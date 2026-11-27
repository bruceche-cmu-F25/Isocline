#!/usr/bin/env node
/** alfred serve            run the home node (loopback; other devices come in through Tailscale Serve)
 *
 *  Options: --data-dir <dir>  --port <n>  --ingress-port <n> (default port + 10)
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { createPiEngine } from "@zirma/engine-pi";
import { moveNoteSources, todoModule } from "@zirma/module-todo";
import { calendarModule } from "@zirma/module-calendar";
import { mailModule } from "@zirma/module-mail";
import { linksModule } from "@zirma/module-links";
import { createNotesModule } from "@zirma/module-notes";
import type { ModuleServices } from "@zirma/module-kit";
import { googleService } from "./google-service.ts";
import { DEFAULT_PORT, defaultDataDir, defaultUiDir } from "./config.ts";
import { openHome } from "./home.ts";
import { createHttpServer, createIngressServer } from "./http.ts";
import { Transcriber } from "./voice.ts";
import { Speaker } from "./speak.ts";
import { RemoteAccess } from "./remote.ts";
import { PushService } from "./push.ts";
import { cliRunner, findTailscale, Tailscale } from "./tailscale.ts";
import { GoogleConnections } from "./google.ts";
import { createCredentialStore, McpConnectors, ModelAccounts, Skills } from "@zirma/engine-pi";
import { adoptLegacyEnv, checkStage, currentStage, recordDomainEvent } from "@zirma/core";
import { defaultSecretStore } from "./secrets.ts";
import { watchTodoSources } from "./todo-sources.ts";
import { watchReminders } from "./reminders.ts";
import { moveRenamedFolders } from "./rename.ts";
import { defaultNotesRoot, watchNotes } from "./notes.ts";
import { watchNoteCompile } from "./note-compile.ts";
import { watchLinkFile } from "./link-file.ts";
import { watchNoteTodos } from "./note-todos.ts";

// The notes module needs the data directory for its default library, so the list is made once that is known.
const baseModules = [todoModule, calendarModule, mailModule, linksModule];
// Settings an install made before a rename still apply: ISOCLINE_X, else ALFRED_X, is read as ZIRMA_X.
adoptLegacyEnv();
const log = (message: string) => console.log(`[zirma] ${message}`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    port: { type: "string" },
    "ingress-port": { type: "string" },
  },
});
// An install from before a rename keeps its world: the old folders move to the new names (once; not for --data-dir).
if (!values["data-dir"]) moveRenamedFolders(undefined, log);
const dataDir = values["data-dir"] ?? defaultDataDir();
// A note page that moves takes its todos along (the todo list knows them by page): the one place that knows both.
const MODULES = [...baseModules, createNotesModule({ defaultRoot: defaultNotesRoot(dataDir), onMoved: (world, from, to) => { moveNoteSources(world, from, to); } })];
// A development run never opens production's world or its keychain (core stage.ts).
const crossing = checkStage(dataDir);
if (crossing) {
  console.error(`[zirma] ${crossing}`);
  process.exit(1);
}
const command = positionals[0] ?? "serve";

if (command === "serve") {
  const port = Number(values.port ?? process.env.ZIRMA_PORT ?? DEFAULT_PORT);
  // The model runs in worker processes; each conversation keeps its session under <data>/engine/sessions.
  // MCP servers come from <data>/mcp.json, skills from <data>/skills/.
  const engine = createPiEngine({ cwd: join(dataDir, "engine"), config: dataDir, log });
  // How long a locked screen counts as "away" before coming back is a return (default 10 minutes).
  const awayMinutes = Number(process.env.ZIRMA_AWAY_MINUTES);
  const presence = Number.isFinite(awayMinutes) && awayMinutes > 0 ? { awayReturnMs: awayMinutes * 60_000 } : {};
  let home: ReturnType<typeof openHome>;
  let services: ModuleServices = {};
  try {
    home = openHome({ dataDir, engine, modules: MODULES, presence, log, services: () => services });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AlreadyRunningError")) throw error;
    console.error(`[zirma] ${error.message}. Stop it first, or use another --data-dir.`);
    process.exit(1);
  }
  // Google accounts: tokens in the keychain, Zirma's own OAuth client from the data directory (or the default one).
  const google = new GoogleConnections({ dataDir, secrets: defaultSecretStore(dataDir), world: home.world, clientDirs: [...new Set([dataDir, defaultDataDir()])], log });
  // Model sign-in: credentials in the keychain too, shared with the engine workers (which use the same store).
  const models = new ModelAccounts({
    store: createCredentialStore({ secrets: defaultSecretStore(dataDir), lockDir: dataDir }), dataDir, log,
    onChange: (kind, provider, detail) => home.world.tx(() => recordDomainEvent(home.world, { kind: `model.${kind}`, subject: `model:${provider}`, actor: "user", payload: { provider, ...detail } })),
  });
  // Connectors: the MCP servers in <data>/mcp.json, their secrets and sign-ins in the keychain, like the rest.
  const mcp = new McpConnectors({
    dataDir, secrets: defaultSecretStore(dataDir), log,
    onChange: (kind, name) => home.world.tx(() => recordDomainEvent(home.world, { kind: `connector.${kind}`, subject: `connector:${name}`, actor: "user", payload: { name } })),
  });
  // A connector's search tool can be one of the search services in Settings → Web.
  home.web.connectors = mcp;
  // Skills: the folders in <data>/skills/, listed, switched, and added from this Mac or from skills.sh.
  const skills = new Skills({
    dataDir, log,
    onChange: (kind, name) => home.world.tx(() => recordDomainEvent(home.world, { kind: `skill.${kind}`, subject: `skill:${name}`, actor: "user", payload: { name } })),
  });
  // The calendar and mail modules read the connected accounts through it.
  services = { google: googleService(google) };
  // Other devices: Tailscale Serve forwards to the ingress port, where every request needs a paired device.
  const ingressPort = Number(values["ingress-port"] ?? process.env.ZIRMA_INGRESS_PORT ?? port + 10);
  const tailscaleBinary = findTailscale();
  const remote = new RemoteAccess({ dataDir, world: home.world, tailscale: new Tailscale(tailscaleBinary ? cliRunner(tailscaleBinary) : null), ingressPort, log });
  // Notices nobody took within seconds go to the devices that turned notifications on.
  const push = new PushService({ dataDir, world: home.world, secrets: defaultSecretStore(dataDir), hidePreviews: () => remote.webLock.enabled, log });
  remote.events.on("revoked", (id) => { push.unsubscribe(id); home.outlets.forget(id); });
  // The phones' notifications: one more outlet the home node's attention can hand a notice to.
  home.reach(() => push.reaches());
  // Calendar events become todos by themselves (which ones is the user's choice, on the Todos page).
  const stopTodoSources = watchTodoSources(home.world, calendarModule, log);
  // Events about to start, todos about to be due, mail from the people the user named: told on Zirma's own.
  const stopReminders = watchReminders({ world: home.world, modules: home.modules, syncModule: home.syncModule }, log);
  // The notes folder: another app's changes are read in a moment after they happen.
  const stopNotes = watchNotes(home, log);
  // Zirma's layer of the notes: its passes through them, run in the background.
  const stopNoteCompile = watchNoteCompile(home, log);
  // Links filed on their own, once the user switched it on (or pressed the Unfiled button).
  const stopLinkFile = watchLinkFile(home, log);
  // A note's to-do finished or reopened on the todo list: its box in the note follows (and the other way round on save).
  const stopNoteTodos = watchNoteTodos(home.world, home.modules.find((module) => module.id === "note") as unknown as Parameters<typeof watchNoteTodos>[1], log);
  // Speech to text for every device; the model loads when someone starts talking.
  const voice = new Transcriber({ log });
  const speaker = new Speaker({ log, secrets: defaultSecretStore(dataDir) });
  const server = createHttpServer(home, { port, uiDir: defaultUiDir(), log, google, models, mcp, skills, remote, push, voice, speaker });
  const ingress = createIngressServer(home, { port: ingressPort, uiDir: defaultUiDir(), log, google, models, mcp, skills, remote, push, voice, speaker });
  server.on("error", (error: NodeJS.ErrnoException) => {
    void engine.close();
    home.close();
    if (error.code === "EADDRINUSE") {
      console.error(`[zirma] Port ${port} is already in use (another Zirma, or something else). Stop it, or pick another port: npm start -- --port <n>`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    log(`${currentStage()} home node${process.env.ZIRMA_BUILD ? ` ${process.env.ZIRMA_BUILD}` : ""} on http://127.0.0.1:${port}  (data: ${dataDir})`);
    home.kick();
    ingress.listen(ingressPort, "127.0.0.1", () => {
      log(`ingress for other devices on http://127.0.0.1:${ingressPort}`);
      remote.restore().then(() => { if (remote.url) log(`other devices: ${remote.url}`); }, (error: Error) => log(`remote access: ${error.message}`));
    });
  });
  ingress.on("error", (error: NodeJS.ErrnoException) => log(`ingress port ${ingressPort} unavailable (${error.code ?? error.message}); other devices cannot connect`));
  const stop = async () => {
    stopTodoSources();
    stopReminders();
    stopNotes();
    stopNoteCompile();
    stopLinkFile();
    stopNoteTodos();
    voice.close();
    speaker.close();
    google.close();
    models.close();
    mcp.close();
    server.close();
    server.closeAllConnections();
    ingress.close();
    ingress.closeAllConnections();
    // Workers close their sessions (and MCP servers) before the world closes.
    await engine.close();
    home.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else {
  console.error(`Unknown command: ${command}\nUsage: alfred serve`);
  process.exit(2);
}
