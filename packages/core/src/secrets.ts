/** Secrets (account tokens, model credentials, keys) live in the macOS keychain, never in the world
 * database, a config file or a log. On other systems, and when
 * ISOCLINE_SECRETS=file (tests), a 0600 JSON file in the data directory stands in.
 *
 * Values go to the `security` tool on its standard input, never in its
 * arguments (which other processes can read), base64-encoded so any text
 * survives its parsing.
 *
 * That tool reads a command line of at most 4096 characters whole; a longer one it cuts there, storing a cut-off
 * secret over the good one. So a long secret is split over several keychain items (`<name>/<generation>/<n>`), and
 * the entry itself then holds a short header naming them. The parts are written first, the header last: the entry
 * changes in one step, and a write that fails halfway leaves the previous secret as it was.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { carryingOver, LEGACY_KEYCHAIN_SERVICE } from "./legacy.ts";

export interface SecretStore {
  readonly kind: "keychain" | "file";
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9:@._+-]{1,200}$/;
const SERVICE = /^[A-Za-z0-9 ._-]{1,64}$/;
const NOT_FOUND = 44;
/** The longest command line `security -i` reads whole (measured on macOS 26). No longer line is ever sent. */
const MAX_LINE = 4096;
/** Base64 characters of a secret per keychain item: with the command around them, well under MAX_LINE. */
const PART = 2048;
const MAX_PARTS = 64;
/** What a split entry holds instead of its value: the generation of its parts, how many, and the hash of the whole.
 * It has colons, which base64 never has, so it cannot be mistaken for a value. */
const HEADER = /^parts:([0-9a-f]{8}):(\d{1,2}):([0-9a-f]{64})$/;
/** What an item may be called and hold: nothing that could end the quoted word it travels in. */
const ACCOUNT = /^[A-Za-z0-9:@._+/-]{1,240}$/;
const TEXT = /^[A-Za-z0-9+/=:]*$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid secret name: ${name}`);
}

/** One keychain item at a time: the text kept under an account, exactly as stored. Apart from the store, so that
 * how the store splits long secrets can be tested without a keychain. */
export interface KeychainItems {
  read(account: string): Promise<string | undefined>;
  write(account: string, text: string): Promise<void>;
  remove(account: string): Promise<void>;
}

/** The command that stores one item, as `security -i` reads it. Throws rather than build a line the tool would cut,
 * or one whose words could run into each other. */
export function keychainLine(service: string, account: string, text: string): string {
  if (!SERVICE.test(service) || !ACCOUNT.test(account) || !TEXT.test(text)) throw new Error("Not a keychain item Isocline writes");
  const line = `add-generic-password -U -s "${service}" -a "${account}" -w "${text}"`;
  if (line.length > MAX_LINE) throw new Error("Too long for one keychain item");
  return line;
}

function security(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (input === undefined) {
      execFile("security", args, { timeout: 10_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        if (error && code === -1) reject(error);
        else resolve({ code, stdout, stderr });
      });
      return;
    }
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Changes to one entry take turns. A write is checked by reading it back, so two at once (the calendar and the
 * mail both refreshing one account's token) would each read the other's and one would wrongly report a failure.
 * Within this process only; processes that share an entry take turns their own way (engine-pi credentials.ts). */
const turns = new Map<string, Promise<void>>();
function inTurn<T>(key: string, action: () => Promise<T>): Promise<T> {
  const result = (turns.get(key) ?? Promise.resolve()).then(action);
  const settled = result.then(() => {}, () => {});
  turns.set(key, settled);
  void settled.then(() => { if (turns.get(key) === settled) turns.delete(key); });
  return result;
}

/** The keychain's items, through the `security` tool. */
function securityItems(service: string): KeychainItems {
  if (!SERVICE.test(service)) throw new Error(`Invalid keychain service: ${service}`);
  const read = async (account: string) => {
    const { code, stdout, stderr } = await security(["find-generic-password", "-s", service, "-a", account, "-w"]);
    if (code === NOT_FOUND) return undefined;
    if (code !== 0) throw new Error(`Keychain read failed: ${stderr.trim()}`);
    return stdout.trim();
  };
  return {
    read,
    async write(account, text) {
      // Interactive mode reads the command, secret included, from standard input.
      await security(["-i"], `${keychainLine(service, account, text)}\n`);
      // `security -i` exits 0 even when a command fails, so check that it landed.
      if ((await read(account)) !== text) throw new Error("Keychain write failed");
    },
    async remove(account) {
      const { code, stderr } = await security(["delete-generic-password", "-s", service, "-a", account]);
      if (code !== 0 && code !== NOT_FOUND) throw new Error(`Keychain delete failed: ${stderr.trim()}`);
    },
  };
}

export function keychainStore(service = process.env.ISOCLINE_KEYCHAIN_SERVICE || "Isocline", items: KeychainItems = securityItems(service)): SecretStore {
  const part = (name: string, generation: string, index: number) => `${name}/${generation}/${index}`;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const decode = (text: string) => Buffer.from(text, "base64").toString("utf8");
  /** Removes the parts a header names: they are no longer the entry's value. Best effort; a part left behind is
   * never read again. */
  const forget = async (name: string, header: string | undefined, keep?: string): Promise<void> => {
    const named = header ? HEADER.exec(header) : null;
    if (!named || named[1] === keep) return;
    await Promise.all(Array.from({ length: Number(named[2]) }, (_, index) => items.remove(part(name, named[1], index)).catch(() => {})));
  };
  return {
    kind: "keychain",
    async get(name) {
      checkName(name);
      // Twice: a write may replace the entry between reading its header and its parts.
      for (let attempt = 0; attempt < 2; attempt++) {
        const held = await items.read(name);
        if (held === undefined) return undefined;
        const header = HEADER.exec(held);
        if (!header) return decode(held);
        const [, generation, count, digest] = header;
        const parts = await Promise.all(Array.from({ length: Number(count) }, (_, index) => items.read(part(name, generation, index))));
        const whole = parts.join("");
        if (parts.every((text) => text !== undefined) && hash(whole) === digest) return decode(whole);
      }
      throw new Error(`Keychain entry ${name} is incomplete`);
    },
    async set(name, value) {
      checkName(name);
      const encoded = Buffer.from(value, "utf8").toString("base64");
      return inTurn(`${service}\n${name}`, async () => {
        const before = await items.read(name);
        if (encoded.length <= PART) {
          await items.write(name, encoded);
          await forget(name, before);
          return;
        }
        const parts = Array.from({ length: Math.ceil(encoded.length / PART) }, (_, index) => encoded.slice(index * PART, (index + 1) * PART));
        if (parts.length > MAX_PARTS) throw new Error("Too large for the keychain");
        const generation = randomBytes(4).toString("hex");
        const header = `parts:${generation}:${parts.length}:${hash(encoded)}`;
        try {
          for (const [index, text] of parts.entries()) await items.write(part(name, generation, index), text);
          await items.write(name, header);
        } catch (error) {
          // The entry still holds what it held, so the new parts are taken back. Unless the header did land and
          // only checking it failed: then they are the entry's value now, and stay.
          const held = await items.read(name).catch(() => header);
          if (held !== header) await forget(name, header);
          throw error;
        }
        await forget(name, before, generation);
      });
    },
    async delete(name) {
      checkName(name);
      return inTurn(`${service}\n${name}`, async () => {
        const held = await items.read(name);
        await items.remove(name);
        await forget(name, held);
      });
    },
  };
}

export function fileStore(path: string): SecretStore {
  const load = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>; } catch { return {}; }
  };
  const save = (data: Record<string, string>) => {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  };
  return {
    kind: "file",
    async get(name) { checkName(name); return load()[name]; },
    async set(name, value) { checkName(name); save({ ...load(), [name]: value }); },
    async delete(name) { checkName(name); const data = load(); delete data[name]; save(data); },
  };
}

export function defaultSecretStore(dataDir: string): SecretStore {
  if (process.platform !== "darwin" || process.env.ISOCLINE_SECRETS === "file") return fileStore(join(dataDir, "secrets.json"));
  // Secrets kept before the rename, under the old service, come over the first time each is read.
  return process.env.ISOCLINE_KEYCHAIN_SERVICE ? keychainStore() : carryingOver(keychainStore(), keychainStore(LEGACY_KEYCHAIN_SERVICE));
}
