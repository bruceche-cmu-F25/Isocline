# Zirma

An open-source personal agent. One home node on your computer holds your world: what you asked for, what got done, and the proof that it got done. Every device you use is a window onto that same home node. The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status: step 2 of 5, plus conversations and general tools.** Zirma has a home node, a todo module, conversations (each with its own warm agent session, model choice, and the ability to add to a run while it works), MCP servers and skills behind a permission gate, and a Mac app. Memory and scheduling, multi-device access, voice and more modules come next.

**Design:** [Current views, chosen identity and screenshot](docs/design/README.md).

**The name.** Zirma (say ZEER-ma) is a city in Italo Calvino's *Invisible Cities*. The app was called Alfred until 2026-11-23 and Isocline until 2026-11-24 ([why](docs/design/rename-isocline.md), [what moved](docs/design/rename-zirma.md)). You talk with one of two characters, **Ana** (a woman's voice) or **Kata** (a man's), named for the two directions of the fourth dimension; pick one, or give it a name of your own, in Settings → General. An install from before either rename moves its world, logs, keychain entries and launchd agent over by itself the first time the new app opens.

## The Mac app

```bash
npm install
npm run desktop
```

On first open, the app installs the home node as a launchd user agent (`~/Library/LaunchAgents/zirma.home-node.plist`) and starts it with the app's own runtime, so you don't need a separate Node to run it. From then on:

- **The home node is independent of the app.** Closing the window or quitting the app does not stop a run. The node also starts again at login. Its log is at `~/Library/Logs/Zirma/zirma.home-node.log`.
- **The figure stays on screen.** It sits in the bottom-right corner, always on top, and never takes focus. It shows when the assistant is working or has something waiting. Click it to open the main window.
- **Returning from away gets one greeting.** When you lock the screen and come back after 10 minutes or more, the figure greets you once with what actually happened while you were away. Change the 10 minutes with `ZIRMA_AWAY_MINUTES`.
- **Chat replies stay in their conversation.** Unseen replies have an unread dot. Ask the assistant to notify you when it finishes to receive an Inbox delivery. Read the morning brief in Inbox and browse previous editions in Automations.
- **⌥Space opens Zirma from anywhere.** The menu bar item shows whether the home node is online, can hide the figure, and can restart or stop the node.

Running the app from source, macOS shows it as "Electron" and asks once for permission to show notifications. To build `Zirma.app` and a disk image: `npm run package:mac` (ad hoc signed, not notarized: on another Mac, open it the first time with right-click → Open). How it is built, how to try a build without touching your real data, and what a public release still needs: [docs/packaging.md](docs/packaging.md).

To remove the background service completely:

```bash
launchctl bootout gui/$(id -u)/zirma.home-node; rm ~/Library/LaunchAgents/zirma.home-node.plist
```

`npm run e2e --workspace @zirma/desktop` drives the real app against a throwaway world on port 7481 and checks all of the above. It installs its own temporary launchd agent and removes it at the end.

## Tools beyond todos: MCP servers and skills

Zirma uses its own configuration, separate from your personal Pi setup, in its data directory (`~/Library/Application Support/Zirma/` on macOS):

- **MCP servers** go in `mcp.json`. It uses the same format as Pi and Claude Desktop, so you can copy entries across. `${VAR}` placeholders are filled in from the environment when Zirma connects.

  ```json
  { "mcpServers": { "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } } } }
  ```

- **Skills** go in `skills/<name>/SKILL.md`, using the [Agent Skills](https://agentskills.io/specification) format.

Each server marks its tools with hints, and those hints decide what runs freely:

- **Runs without asking:** tools a server marks as read-only, and reading Zirma's own skill files.
- **Asks you first, for that one call:** every other tool, including tools a server doesn't mark at all, and reading any other file. If you say no, the assistant is told not to try another way.
- **Not available at all:** a shell, writing files, and editing files.

A call you allowed that may have changed something outside Zirma is kept as a receipt of that run.

A conversation's session stays open between turns, as in Pi Web, so its MCP connections stay up; it closes after 10 minutes idle.

## Run the home node alone

You need Node 24 or newer. To talk to the assistant in sentences, you also need a model signed in through [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`~/.pi/agent`). Without a model, the todo list still works by hand.

```bash
npm install
npm start          # builds the interface, then serves a development world on http://127.0.0.1:7491
```

**Development and production never share anything** ([packages/core/src/stage.ts](packages/core/src/stage.ts)). Production is the installed Zirma.app; anything run from this source tree is development, with its own world, port, launchd agent and keychain entry:

| | Production (Zirma.app) | Development (from source) |
|---|---|---|
| World | `~/Library/Application Support/Zirma/` | `~/Library/Application Support/Zirma Dev/` |
| Port | 7480 | 7491 |
| launchd agent | `zirma.home-node` | `zirma.home-node.dev` |
| Keychain service | `Zirma` | `Zirma Dev` |

On Linux the worlds are `~/.local/share/zirma` and `zirma-dev`. `--data-dir` / `ZIRMA_DATA_DIR`, `ZIRMA_PORT` and `ZIRMA_KEYCHAIN_SERVICE` move a world within its stage; a development run refuses production's world and keychain. A server run from source as the real node says so with `ZIRMA_ENV=production`. Only one home node can run on a data directory at a time.

## What is guaranteed so far

- A sentence becomes a **run**. Submitting a run returns immediately, and the conversation never blocks while a run works.
- A run's result is backed by **receipts**: the events it actually wrote, recorded in the same transaction as each change. If the model says "done" but called no tool, the run has no receipts.
- **Retries are safe.** Every command and run carries a request id. Sending the same request again returns the original result instead of running it a second time.
- **A crash never repeats work.** If the home node stops in the middle of a run, the run comes back marked *interrupted*. It runs again only after you choose to continue it.
- **Coming back is a real event.** Devices report when you are active or away. Exactly one welcome is recorded per return, and it holds only what actually happened, never a guess.
- **Runs cannot delete.** A run gets read and reversible tools only. Permanent deletion stays with you.
- **The server only listens locally.** It binds to loopback and refuses any other Host header and any cross-site browser origin. Paired devices come with the multi-device step.

## Layout

```text
packages/core        world (events, state), runs, notices, commands; the engine port
packages/module-kit  the module contract: operations, agent tools, permission levels
packages/engine-pi   runs one core run as a tool-scoped, in-memory Pi session
packages/server      the home node: client protocol (HTTP + SSE), single-instance lock, CLI
packages/protocol    the public client protocol types
packages/ui          the interface every device opens (React + Vite), and the figure's page
packages/desktop     the Mac app (Electron): launchd home node, figure, menu bar, hotkey, notifications, presence
modules/todo         todos, moved from Robin's todo domain, with a read-only Robin importer
prototype/           chosen tesseract identity, its state sheet, and the workspace layout study
archive/design/      earlier interaction, layout and identity studies
```

```bash
npm test             # core, todo module and home node, including a kill-mid-run test
npm run typecheck
npm run dev:ui       # Vite on :5173, proxied to a running home node
```

MIT licensed. Zirma builds on [Pi](https://github.com/earendil-works/pi) (MIT, © Mario Zechner) and borrows code and
designs from [pi-web](https://github.com/agegr/pi-web) (MIT, © agegr), among others: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
