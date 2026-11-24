/** Remote access (docs/research/remote-access.md): other devices reach the home node through Tailscale Serve, which
 * gives them HTTPS inside the user's tailnet. Serve forwards to a second loopback port, the ingress, where every
 * request is a remote device's and must carry a device token; the local port keeps trusting loopback as before.
 *
 * Pairing: the Mac shows a one-time code (and a QR code with a link that carries it); the device sends it to
 * /api/pair and gets its token in an HttpOnly cookie. One code at a time, ten minutes, five wrong tries.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listDevices, pairDevice, revokeDevice, setDeviceScope, type Device, type DeviceKind, type DeviceScope, type World } from "@isocline/core";
import type { PairingCode, RemoteResponse, TailscaleStatus } from "@isocline/protocol";
import { WebLock } from "./web-lock.ts";
import type { Tailscale } from "./tailscale.ts";

/** Not 443 or 8443: those are often taken by other things already served on the same machine. */
export const DEFAULT_SERVE_PORT = 4443;
export const PAIRING_MS = 10 * 60_000;
const PAIRING_TRIES = 5;
/** No 0/O, 1/I: read off a screen and typed on a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STATUS_TTL_MS = 30_000;

export const DEVICE_COOKIE = "isocline_device";
/** What the device cookie was called before the rename (Alfred → Isocline): still read, and replaced when seen. */
export const LEGACY_DEVICE_COOKIE = "alfred_device";

interface Config { enabled: boolean; port: number }

export class PairingError extends Error {
  override name = "PairingError";
  readonly code: "invalid" | "expired" | "none";
  constructor(code: "invalid" | "expired" | "none", message: string) { super(message); this.code = code; }
}
export class RemoteError extends Error {
  override name = "RemoteError";
}

export interface RemoteOptions {
  dataDir: string;
  world: World;
  tailscale: Tailscale;
  /** The loopback port Serve forwards to. */
  ingressPort: number;
  log?: (message: string) => void;
}

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export class RemoteAccess {
  /** Refresh a device's open streams when its permissions change. Revoking also removes its push subscription. */
  readonly events = new EventEmitter<{ revoked: [string]; scopeChanged: [string]; lockChanged: [string | null] }>();
  readonly webLock: WebLock;
  readonly #options: RemoteOptions;
  readonly #file: string;
  #config: Config;
  #status: TailscaleStatus = { installed: false, running: false, dnsName: null, owner: null };
  #statusAt = 0;
  #serving = false;
  #error: string | undefined;
  #pairing: { code: string; expiresAt: number; tries: number } | null = null;

  constructor(options: RemoteOptions) {
    this.#options = options;
    this.webLock = new WebLock(options.world, (id) => this.events.emit("lockChanged", id));
    this.#file = join(options.dataDir, "remote.json");
    this.#config = { enabled: false, port: DEFAULT_SERVE_PORT };
    try {
      const stored = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Config>;
      this.#config = {
        enabled: stored.enabled === true,
        port: Number.isInteger(stored.port) && stored.port! > 0 && stored.port! < 65536 ? stored.port! : DEFAULT_SERVE_PORT,
      };
    } catch { /* first start */ }
  }

  get target(): string { return `http://127.0.0.1:${this.#options.ingressPort}`; }
  /** This machine's tailnet name, as last read (for the ingress Host check). */
  get dnsName(): string | null { return this.#status.dnsName; }
  /** The tailnet login that owns this machine, as last read. */
  get owner(): string | null { return this.#status.owner; }
  get url(): string | null { return this.#serving && this.#status.dnsName ? `https://${this.#status.dnsName}:${this.#config.port}` : null; }

  async refreshStatus(force = false): Promise<TailscaleStatus> {
    if (force || Date.now() - this.#statusAt > STATUS_TTL_MS) {
      this.#status = await this.#options.tailscale.status();
      this.#statusAt = Date.now();
    }
    return this.#status;
  }

  /** At start: if the user left it on, make sure Serve still points here (the user may have reset it). */
  async restore(): Promise<void> {
    await this.refreshStatus(true);
    if (this.#config.enabled) await this.#ensure();
  }

  async describe(): Promise<Extract<RemoteResponse, { local: true }>> {
    const tailscale = await this.refreshStatus(true);
    if (this.#config.enabled && tailscale.running) await this.#check();
    else this.#serving = false;
    return {
      local: true, enabled: this.#config.enabled, webLockEnabled: this.webLock.enabled, serving: this.#serving, url: this.url, port: this.#config.port, tailscale,
      devices: listDevices(this.#options.world), ...(this.#error ? { error: this.#error } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<Extract<RemoteResponse, { local: true }>> {
    await this.refreshStatus(true);
    if (enabled) {
      this.#save({ ...this.#config, enabled: true });
      await this.#ensure();
    } else {
      this.#save({ ...this.#config, enabled: false });
      this.#pairing = null;
      if (this.#status.running && this.#status.dnsName && (await this.#options.tailscale.servedAt(this.#status.dnsName, this.#config.port)) === this.target) {
        await this.#options.tailscale.unserve(this.#config.port);
        this.#options.log?.(`remote access off (Serve :${this.#config.port} removed)`);
      }
      this.#serving = false;
      this.#error = undefined;
    }
    return this.describe();
  }

  /** A new one-time code; the previous one stops working. */
  newPairing(now: number = Date.now()): PairingCode {
    let code = "";
    for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.#pairing = { code, expiresAt: now + PAIRING_MS, tries: 0 };
    const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
    return { code: pretty, url: this.url ? `${this.url}/?pair=${code}` : null, expiresAt: new Date(now + PAIRING_MS).toISOString() };
  }

  /** Spends the code and pairs the device; returns it with its token (given to the device once, never stored). */
  pair(input: { code: string; name: string; kind: DeviceKind; via: string | null }, now: number = Date.now()): { device: Device; token: string } {
    const pairing = this.#pairing;
    if (!pairing) throw new PairingError("none", "No pairing code is open. Show one on the Mac: Settings → Devices.");
    if (now > pairing.expiresAt) { this.#pairing = null; throw new PairingError("expired", "That code has expired. Show a new one on the Mac."); }
    const given = Buffer.from(normalizeCode(input.code).padEnd(8, "-").slice(0, 8));
    if (!timingSafeEqual(given, Buffer.from(pairing.code))) {
      if (++pairing.tries >= PAIRING_TRIES) this.#pairing = null;
      throw new PairingError("invalid", "That code is not right.");
    }
    this.#pairing = null;
    const token = randomBytes(32).toString("base64url");
    const device = pairDevice(this.#options.world, { token, name: input.name, kind: input.kind, via: input.via }, now);
    this.#options.log?.(`paired ${device.name} (${device.kind}${input.via ? `, ${input.via}` : ""})`);
    return { device, token };
  }

  /** Lets a device into development sessions, or takes that away (docs/design/dev-mode.md 4.7). */
  setScope(id: string, scope: DeviceScope, enabled: boolean, onlyIfRequested = false): Device {
    const device = setDeviceScope(this.#options.world, id, scope, enabled, Date.now(), onlyIfRequested);
    if (device.scopes.includes(scope) !== enabled) return device;
    this.events.emit("scopeChanged", id);
    this.#options.log?.(`${device.name}: ${scope} ${enabled ? "on" : "off"}`);
    return device;
  }

  revoke(id: string): Device {
    const device = revokeDevice(this.#options.world, id);
    this.webLock.revoke(id);
    this.events.emit("revoked", id);
    this.#options.log?.(`revoked ${device.name}`);
    return device;
  }

  async #check(): Promise<void> {
    const { dnsName } = this.#status;
    if (!dnsName) { this.#serving = false; return; }
    try {
      const served = await this.#options.tailscale.servedAt(dnsName, this.#config.port);
      this.#serving = served === this.target;
      this.#error = served && served !== this.target ? `Port ${this.#config.port} in this machine's Tailscale Serve is used by something else` : undefined;
    } catch (error) {
      this.#serving = false;
      this.#error = (error as Error).message;
    }
  }

  async #ensure(): Promise<void> {
    const { running, dnsName } = this.#status;
    if (!running || !dnsName) {
      this.#serving = false;
      this.#error = this.#status.installed ? "Tailscale is not running or not logged in on this machine" : "Tailscale is not installed on this machine";
      return;
    }
    try {
      const served = await this.#options.tailscale.servedAt(dnsName, this.#config.port);
      if (served !== null && served !== this.target) {
        throw new RemoteError(`Port ${this.#config.port} in this machine's Tailscale Serve is used by something else; Isocline left it alone`);
      }
      if (served === null) {
        await this.#options.tailscale.serve(this.#config.port, this.target);
        this.#options.log?.(`remote access on: https://${dnsName}:${this.#config.port} → ${this.target}`);
      }
      this.#serving = true;
      this.#error = undefined;
    } catch (error) {
      this.#serving = false;
      this.#error = (error as Error).message;
    }
  }

  #save(config: Config): void {
    this.#config = config;
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(temp, this.#file);
  }
}
