#!/usr/bin/env node
/** alfred serve            run the home node (loopback; other devices come in through Tailscale Serve)
 *  alfred import-robin     copy Robin's todos into Alfred (read-only on Robin)
 *
 *  Options: --data-dir <dir>  --port <n>  --ingress-port <n> (default port + 10)  --robin-dir <dir>  --dry-run  --check
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { createPiEngine } from "@alfred/engine-pi";
import { compareTodos, importTodos, readRobinTodos, robinDataDir, todoModule } from "@alfred/module-todo";
import { calendarModule } from "@alfred/module-calendar";
import { mailModule } from "@alfred/module-mail";
import { linksModule } from "@alfred/module-links";
import type { ModuleServices } from "@alfred/module-kit";
import { googleService } from "./google-service.ts";
import { DEFAULT_PORT, defaultDataDir, defaultUiDir } from "./config.ts";
import { openHome } from "./home.ts";
import { createHttpServer, createIngressServer } from "./http.ts";
import { Transcriber } from "./voice.ts";
import { RemoteAccess } from "./remote.ts";
import { PushService } from "./push.ts";
import { cliRunner, findTailscale, Tailscale } from "./tailscale.ts";
import { GoogleConnections } from "./google.ts";
import { createCredentialStore, McpConnectors, ModelAccounts, Skills } from "@alfred/engine-pi";
import { recordDomainEvent } from "@alfred/core";
import { defaultSecretStore } from "./secrets.ts";
import { watchTodoSources } from "./todo-sources.ts";

const MODULES = [todoModule, calendarModule, mailModule, linksModule];
const log = (message: string) => console.log(`[alfred] ${message}`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    port: { type: "string" },
    "ingress-port": { type: "string" },
    "robin-dir": { type: "string" },
    "dry-run": { type: "boolean" },
    check: { type: "boolean" },
  },
});
const dataDir = values["data-dir"] ?? defaultDataDir();
const command = positionals[0] ?? "serve";

if (command === "serve") {
  const port = Number(values.port ?? process.env.ALFRED_PORT ?? DEFAULT_PORT);
  // The model runs in worker processes; each conversation keeps its session under <data>/engine/sessions.
  // MCP servers come from <data>/mcp.json, skills from <data>/skills/.
  const engine = createPiEngine({ cwd: join(dataDir, "engine"), config: dataDir, log });
  // How long a locked screen counts as "away" before coming back is a return (default 10 minutes).
  const awayMinutes = Number(process.env.ALFRED_AWAY_MINUTES);
  const presence = Number.isFinite(awayMinutes) && awayMinutes > 0 ? { awayReturnMs: awayMinutes * 60_000 } : {};
  let home: ReturnType<typeof openHome>;
  let services: ModuleServices = {};
  try {
    home = openHome({ dataDir, engine, modules: MODULES, presence, log, services: () => services });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AlreadyRunningError")) throw error;
    console.error(`[alfred] ${error.message}. Stop it first, or use another --data-dir.`);
    process.exit(1);
  }
  // Google accounts: tokens in the keychain, Alfred's own OAuth client from the data directory (or the default one).
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
  // Skills: the folders in <data>/skills/, listed, switched, and added from this Mac or from skills.sh.
  const skills = new Skills({
    dataDir, log,
    onChange: (kind, name) => home.world.tx(() => recordDomainEvent(home.world, { kind: `skill.${kind}`, subject: `skill:${name}`, actor: "user", payload: { name } })),
  });
  // The calendar and mail modules read the connected accounts through it.
  services = { google: googleService(google) };
  // Other devices: Tailscale Serve forwards to the ingress port, where every request needs a paired device.
  const ingressPort = Number(values["ingress-port"] ?? process.env.ALFRED_INGRESS_PORT ?? port + 10);
  const tailscaleBinary = findTailscale();
  const remote = new RemoteAccess({ dataDir, world: home.world, tailscale: new Tailscale(tailscaleBinary ? cliRunner(tailscaleBinary) : null), ingressPort, log });
  // Notices nobody took within seconds go to the devices that turned notifications on.
  const push = new PushService({ dataDir, world: home.world, secrets: defaultSecretStore(dataDir), hidePreviews: () => remote.webLock.enabled, log });
  remote.events.on("revoked", (id) => { push.unsubscribe(id); home.outlets.forget(id); });
  // The phones' notifications: one more outlet the home node's attention can hand a notice to.
  home.reach(() => push.reaches());
  // Calendar events become todos by themselves (which ones is the user's choice, on the Todos page).
  const stopTodoSources = watchTodoSources(home.world, calendarModule, log);
  // Speech to text for every device; the model loads when someone starts talking.
  const voice = new Transcriber({ log });
  const server = createHttpServer(home, { port, uiDir: defaultUiDir(), log, google, models, mcp, skills, remote, push, voice });
  const ingress = createIngressServer(home, { port: ingressPort, uiDir: defaultUiDir(), log, google, models, mcp, skills, remote, push, voice });
  server.on("error", (error: NodeJS.ErrnoException) => {
    void engine.close();
    home.close();
    if (error.code === "EADDRINUSE") {
      console.error(`[alfred] Port ${port} is already in use (another Alfred, or something else). Stop it, or pick another port: npm start -- --port <n>`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    log(`home node on http://127.0.0.1:${port}  (data: ${dataDir})`);
    home.kick();
    ingress.listen(ingressPort, "127.0.0.1", () => {
      log(`ingress for other devices on http://127.0.0.1:${ingressPort}`);
      remote.restore().then(() => { if (remote.url) log(`other devices: ${remote.url}`); }, (error: Error) => log(`remote access: ${error.message}`));
    });
  });
  ingress.on("error", (error: NodeJS.ErrnoException) => log(`ingress port ${ingressPort} unavailable (${error.code ?? error.message}); other devices cannot connect`));
  const stop = async () => {
    stopTodoSources();
    voice.close();
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
} else if (command === "import-robin") {
  const { todos, from } = readRobinTodos(values["robin-dir"] ?? robinDataDir());
  log(`read ${todos.length} todo(s) from ${from} (read-only)`);
  if (values["dry-run"]) {
    log("dry run: nothing written");
    process.exit(0);
  }
  // Holds the home node lock: refuses while a home node is running on this data dir.
  const home = openHome({ dataDir, engine: { submit: () => Promise.reject(new Error("no engine")) }, modules: MODULES, log });
  try {
    if (!values.check) {
      const result = importTodos(home.world, todos, "robin");
      log(`imported ${result.imported}, skipped ${result.skipped} already present`);
    }
    const comparison = compareTodos(home.world, todos);
    log(`compared with Robin: ${comparison.same} same, ${comparison.differ.length} differ, ${comparison.missing.length} missing, ${comparison.extra.length} only in Alfred`);
    process.exitCode = comparison.differ.length || comparison.missing.length ? 1 : 0;
  } finally {
    home.close();
  }
} else {
  console.error(`Unknown command: ${command}\nUsage: alfred serve | alfred import-robin [--dry-run] [--check]`);
  process.exit(2);
}
