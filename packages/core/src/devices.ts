/** Paired devices (docs/ARCHITECTURE.md 5.7): every device other than the home node's own machine reaches the world
 * with a device token. Only the token's hash is stored; the token itself goes to the device once, at pairing.
 * Pairing and revoking are events like any other change, so every device sees the list change.
 */
import { createHash } from "node:crypto";
import { recordDomainEvent } from "./events.ts";
import { iso, newId } from "./ids.ts";
import { dropGrantsBy } from "./shell.ts";
import type { World } from "./world.ts";

/** What a paired device may do beyond the everyday (docs/design/dev-mode.md 4.7). `dev`: open development sessions,
 * talk in them, read what they did, and allow their changes and commands. No device has it until the user turns it
 * on for that device, on the home node's machine. */
export const DEVICE_SCOPES = ["dev"] as const;
export type DeviceScope = (typeof DEVICE_SCOPES)[number];

export const DEVICE_KINDS = ["desktop", "phone", "browser"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  /** The tailnet login that paired it, when it came through Tailscale. */
  via: string | null;
  pairedAt: string;
  lastSeenAt: string | null;
  scopes: DeviceScope[];
  devAccessRequested: boolean;
}

export class DeviceError extends Error {
  override name = "DeviceError";
  readonly code: "missing" | "invalid";
  constructor(code: "missing" | "invalid", message: string) { super(message); this.code = code; }
}

/** Last seen is written at most this often, so a busy phone does not write on every request. */
const SEEN_EVERY_MS = 60_000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function toDevice(row: Record<string, unknown>): Device {
  return {
    id: row.id as string, name: row.name as string, kind: row.kind as DeviceKind, via: (row.via as string | null) ?? null,
    pairedAt: row.paired_at as string, lastSeenAt: (row.last_seen_at as string | null) ?? null,
    scopes: (JSON.parse((row.scopes as string | undefined) ?? "[]") as string[]).filter((scope): scope is DeviceScope => (DEVICE_SCOPES as readonly string[]).includes(scope)),
    devAccessRequested: row.dev_access_requested === 1,
  };
}

/** Devices that may still connect, most recently paired first. */
export function listDevices(world: World): Device[] {
  return world.db.prepare("SELECT * FROM core_devices WHERE revoked_at IS NULL ORDER BY paired_at DESC, rowid DESC").all().map(toDevice);
}

/** Records a new device for a token the caller made; returns it. The token never enters the world. */
export function pairDevice(world: World, input: { token: string; name: string; kind: DeviceKind; via?: string | null }, now: number = Date.now()): Device {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new DeviceError("invalid", "A device needs a name");
  if (!DEVICE_KINDS.includes(input.kind)) throw new DeviceError("invalid", `kind must be one of: ${DEVICE_KINDS.join(", ")}`);
  if (input.token.length < 32) throw new DeviceError("invalid", "Device tokens are at least 32 characters");
  return world.tx((db) => {
    const id = newId();
    db.prepare("INSERT INTO core_devices (id, name, kind, via, token_hash, paired_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, input.kind, input.via ?? null, hashToken(input.token), iso(now));
    recordDomainEvent(world, { kind: "device.paired", subject: `device:${id}`, payload: { name, kind: input.kind }, actor: "user", now });
    return toDevice(db.prepare("SELECT * FROM core_devices WHERE id = ?").get(id)!);
  });
}

/** The device a token belongs to, or null (unknown or revoked). Notes when it was last seen. */
export function deviceForToken(world: World, token: string, now: number = Date.now()): Device | null {
  if (!token) return null;
  const row = world.db.prepare("SELECT * FROM core_devices WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(token));
  if (!row) return null;
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at as string) : 0;
  if (now - seen >= SEEN_EVERY_MS) {
    world.tx((db) => db.prepare("UPDATE core_devices SET last_seen_at = ? WHERE id = ?").run(iso(now), row.id as string));
    row.last_seen_at = iso(now);
  }
  return toDevice(row);
}

/** Takes effect at once: the device's next request is refused. Revoking twice is a no-op. */
export function revokeDevice(world: World, id: string, now: number = Date.now()): Device {
  return world.tx((db) => {
    const row = db.prepare("SELECT * FROM core_devices WHERE id = ?").get(id);
    if (!row) throw new DeviceError("missing", "No such device");
    if (!row.revoked_at) {
      db.prepare("UPDATE core_devices SET revoked_at = ? WHERE id = ?").run(iso(now), id);
      recordDomainEvent(world, { kind: "device.revoked", subject: `device:${id}`, payload: { name: row.name as string }, actor: "user", now });
      // What it allowed for a session ends with it.
      dropGrantsBy(world, id, now);
    }
    return toDevice(row);
  });
}

function activeDevice(world: World, id: string): Device {
  const row = world.db.prepare("SELECT * FROM core_devices WHERE id = ? AND revoked_at IS NULL").get(id);
  if (!row) throw new DeviceError("missing", "No such device");
  return toDevice(row);
}

/** Asking leaves every permission unchanged. A pending request survives restarts until the Mac answers it. */
export function requestDevAccess(world: World, id: string, now: number = Date.now()): Device {
  return world.tx((db) => {
    const device = activeDevice(world, id);
    if (device.devAccessRequested || device.scopes.includes("dev")) return device;
    db.prepare("UPDATE core_devices SET dev_access_requested = 1 WHERE id = ?").run(id);
    recordDomainEvent(world, { kind: "device.dev_requested", subject: `device:${id}`, payload: {}, actor: "user", now });
    return { ...device, devAccessRequested: true };
  });
}

/** Turns one scope on or off for a device and resolves its pending request. Turning `dev` off also ends what the device allowed for a session. */
export function setDeviceScope(world: World, id: string, scope: DeviceScope, enabled: boolean, now: number = Date.now(), onlyIfRequested = false): Device {
  if (!(DEVICE_SCOPES as readonly string[]).includes(scope)) throw new DeviceError("invalid", `scope must be one of: ${DEVICE_SCOPES.join(", ")}`);
  return world.tx((db) => {
    const device = activeDevice(world, id);
    // A reply from another Mac window may arrive after the request was already decided.
    if (!device.devAccessRequested && (onlyIfRequested || device.scopes.includes(scope) === enabled)) return device;
    const scopes = enabled ? [...device.scopes, scope] : device.scopes.filter((candidate) => candidate !== scope);
    db.prepare("UPDATE core_devices SET scopes = ?, dev_access_requested = 0 WHERE id = ?").run(JSON.stringify(scopes), id);
    recordDomainEvent(world, { kind: "device.scope_set", subject: `device:${id}`, payload: { name: device.name, scope, enabled }, actor: "user", now });
    if (!enabled && device.scopes.includes("dev")) dropGrantsBy(world, id, now);
    return { ...device, scopes, devAccessRequested: false };
  });
}
