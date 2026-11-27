/** Who may use each address of the client protocol: the one list of them.
 *
 * Three levels:
 * - `device`: any paired device (and this machine).
 * - `dev`: a device the user let into development sessions (`dev` scope), and this machine.
 * - `local`: only this machine. Credentials, remote access, other devices, skills (files here), project folders, the
 *   user's own shell and the Mac app's own channel.
 *
 * An address that is not in the list is refused for everyone (404), this machine included. So a new address cannot
 * reach other devices by being forgotten here: it does not work at all until it is listed, with a level.
 *
 * The level is a floor, decided by the address alone. Some routes narrow it further from what the address names
 * (a run, a file or a conversation that belongs to a development session needs `dev`); those checks stay in
 * http.ts, next to the lookup they depend on. Pairing (`POST /api/pair`) is the one address an unpaired device may
 * use; http.ts lets it through before asking for a device.
 *
 * Rules are read top to bottom and the first that matches wins, so a narrower rule goes above a wider one.
 */
import { MODEL_USAGE_PATH } from "./connections-http.ts";
import { HttpError } from "./wire.ts";

export type Access = "device" | "dev" | "local";

/** Who is asking, as far as access goes. */
export interface Asker {
  /** This machine. */
  local: boolean;
  /** Holds the `dev` scope. Ignored for this machine. */
  dev: boolean;
}

export const LOCAL_ONLY = "Only on the machine Zirma runs on";
export const NEEDS_DEV = "This device needs permission to use development sessions.";

interface Rule {
  /** `*` for every method. */
  method: string;
  pattern: RegExp;
  access: Access;
  /** As written below, for tests and error messages. */
  path: string;
}

/** `:x` is one path segment; a trailing `/*` is anything below (or nothing). Everything else is a regex. */
function rule(method: string, path: string, access: Access): Rule {
  const source = path.replace(/\/\*$/, "(?:/.*)?").replace(/:[a-z]+/g, "[^/]+");
  return { method, pattern: new RegExp(`^${source}$`), access, path };
}

export const ACCESS: readonly Rule[] = [
  // Pairing and the device's own session (remote.ts, web-lock.ts). Pairing itself is let through before this.
  rule("POST", "/api/pair", "device"),
  rule("*", "/api/device/(web-lock|unlock|activity|request-dev|forget)", "device"),
  rule("*", "/api/push/*", "device"),
  // What a device asks about itself; this machine is answered with the whole of remote access.
  rule("GET", "/api/remote", "device"),
  rule("*", "/api/remote/*", "local"),
  rule("*", "/api/devices/*", "local"),

  // The world as devices see it, and the user's things in it.
  rule("*", "/api/state", "device"),
  rule("*", "/api/events", "device"),
  rule("*", "/api/models", "device"),
  rule("*", "/api/outlets", "device"),
  rule("*", "/api/presence", "device"),
  // A speech service's key is a credential: only this machine.
  rule("*", "/api/voice/services/*", "local"),
  rule("*", "/api/voice/*", "device"),
  rule("*", "/api/files/*", "device"),
  rule("*", "/api/runs/*", "device"),
  rule("*", "/api/ops/:name", "device"),
  rule("*", "/api/queries/:name", "device"),
  rule("*", "/api/modules/:module/files/:name", "device"),
  rule("*", "/api/modules/:module/sync", "device"),
  // A note's text saved, a file put in a note, a file of the notes read: the user's own, from any of their devices (notes.ts).
  rule("*", "/api/notes/(save|attach|file)", "device"),
  // Showing the notes folder in the Finder: on the Mac the home node runs on.
  rule("*", "/api/notes/reveal", "local"),
  rule("*", "/api/notices/:id/(claim|present|acknowledge)", "device"),
  rule("*", "/api/settings", "device"),
  rule("*", "/api/areas/*", "device"),
  rule("*", "/api/preferences/*", "device"),
  rule("*", "/api/automations/*", "device"),
  rule("*", "/api/proposals/:id/(accept|decline|revise)", "device"),

  // Conversations; development sessions among them.
  rule("*", "/api/conversations/archived", "device"),
  rule("POST", "/api/conversations", "dev"),
  // The user's own shell: everything their account can do. No scope lets another device in.
  rule("*", "/api/conversations/:id/terminal/*", "local"),
  // Starting a background process is a command of the user's own, like the terminal; the rest is a session's.
  rule("POST", "/api/conversations/:id/processes", "local"),
  rule("*", "/api/conversations/:id/processes/*", "dev"),
  rule("*", "/api/conversations/:id/(changes|diff|branch|pr|commit|commit-preview|publish)", "dev"),
  rule("*", "/api/conversations/:id/read", "device"),
  rule("*", "/api/conversations/:id", "device"),

  // Project folders mean something only on this machine, and trusting one lets Zirma read it.
  rule("GET", "/api/projects/:id/branches", "dev"),
  rule("*", "/api/projects/*", "local"),

  // The Mac app comes here for what only it can do (desk.ts); anyone may ask whether it is there.
  rule("GET", "/api/desktop", "device"),
  rule("*", "/api/desktop/requests/*", "local"),

  // Sign-ins, keys and connectors. A device may read how much of its subscriptions is used, nothing else.
  rule("GET", MODEL_USAGE_PATH, "device"),
  rule("*", "/api/connections/*", "local"),
  // Skills are files on this machine, and adding one reads its other folders.
  rule("*", "/api/skills/*", "local"),
  // Settings → Web holds search services' keys.
  rule("*", "/api/web/*", "local"),
];

/** The level an address needs, or null for an address Zirma does not have. */
export function accessFor(method: string, path: string): Access | null {
  return ACCESS.find((candidate) => (candidate.method === "*" || candidate.method === method) && candidate.pattern.test(path))?.access ?? null;
}

/** Throws unless the asker may use the address: 404 for an unknown one, 403 for one above their level. */
export function checkAccess(asker: Asker, method: string, path: string): void {
  const access = accessFor(method, path);
  if (!access) throw new HttpError(404, "Not found");
  if (asker.local || access === "device") return;
  if (access === "local") throw new HttpError(403, LOCAL_ONLY, "local_only");
  if (!asker.dev) throw new HttpError(403, NEEDS_DEV, "needs_dev");
}
