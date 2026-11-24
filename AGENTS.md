# AGENTS.md

Rules for anyone changing this repository, person or coding agent. Read them before the first command.

## Run it
- Node 24+ runs the `.ts` files directly (erasable syntax only). `npm install` once.
- From source you are always on the development stage (`packages/core/src/stage.ts`): world `~/Library/Application Support/Zirma Dev`, port 7491, keychain `Zirma Dev`. A dev run pointed at production's world or keychain refuses to start.
- For a trial, use a throwaway world with secrets in a file, not the dev world or any keychain: `npm run trial` (a fresh temporary world on port 7520; another port with `ZIRMA_PORT=…`).
- Interface with hot reload: `npm run dev:ui`, then http://127.0.0.1:5173 (it proxies `/api` to the trial node on 7520).
- Clickable prototypes: `npm run prototype`, then http://127.0.0.1:4173.
- Tools that launch servers for you (an editor, an agent's preview) should call these three scripts, not copies of their commands. Their own config files stay out of the repository.

## Never touch
- The real home node: port 7480 and its ingress 7490, the world `~/Library/Application Support/Zirma`, the keychain service `Zirma`. Never open 127.0.0.1:7480 in a browser: a window there counts as the user looking and is handed their real notices.
- `ZIRMA_ENV=production`: only the installed Zirma.app sets it.
- Real data: no tokens, `.env` files, databases or chat logs in the repo, a test or a fixture.
- `packages/ui/dist` while a real node is served from this checkout: build a trial with `npx vite build --outDir <tmp>` (in `packages/ui`) and set `ZIRMA_UI_DIR=<tmp>`.
- Changes you did not make: other sessions may be editing this checkout. Don't revert, stash or tidy them.

## Verify
- `npm test` and `npm run typecheck` pass before you say it works.
- Interface changes: look yourself, in a browser (headless Chrome through `playwright-core`, as in `packages/desktop/test/*.e2e.mjs`), in Chinese and English, at a narrow width. No text may overlap. Say what you could not check.
- Architecture and every large feature need an approved design doc in `docs/design/` before code.

## Commit and push
- Branches, commits, versions and releases follow `docs/WORKFLOW.md`: one branch per task (`feat/`, `fix/`, `docs/`, `chore/`) cut from `zirma` (the trunk and GitHub's default branch), in its own git worktree, merged back by a squash-merged pull request once CI passes; production installs only from a version tag. `main` and `alfred-harness` are history; leave them alone.
- `~/Alfred` itself stays on `zirma` (the development node runs its source); never build a feature in it. Agents commit and push only when asked.
- No AI co-author or "generated with" lines in commits.
- `origin` is public. Before a push, scan the unpushed commits for private details (names, hosts, addresses, keys) and for reference screenshots of other products.
- Borrowed code, designs or assets: a header comment with source and licence, plus a row in `THIRD-PARTY-NOTICES.md`.
- Nothing personal in code: names, accounts, categories, sites and prompts are user data; built-ins are deletable samples (`docs/ARCHITECTURE.md` §9.1).
