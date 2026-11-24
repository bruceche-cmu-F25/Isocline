# 开发流程

v0.3，2026-11-24。写给每一个改这个仓库的人和编码代理，不管用的是什么工具。这里只用到 git、npm，以及 GitHub 上的 pull request（网页或 `gh` 都可以）。`AGENTS.md` 里的规矩照旧（不碰生产、验证、隐私扫描、引用别人的代码），这里只管：分支、提交、合并、版本、发布。

## 1. 分支

| 分支 | 是什么 | 怎么往里写 |
|---|---|---|
| `zirma` | 开发主线，也是 GitHub 上的默认分支。所有功能最后都合到这里。它永远能跑，测试全过。生产只从它上面的版本 tag 装。 | 只经 PR 合并，不直接在上面做功能 |
| `feat/<主题>` | 一个新功能 | 从最新的 `zirma` 切出来，做完开 PR 合回去 |
| `fix/<主题>` | 修一个 bug | 同上 |
| `docs/<主题>` | 只改文档（设计文档、说明） | 同上 |
| `chore/<主题>` | 工具、脚本、依赖、整理 | 同上 |
| `main` | 最早的原型，受保护，不再更新 | — |
| `alfred-harness` | 以前的主线，2026-11-24 起由 `zirma` 接替，留着当历史 | — |

- **一件事一条分支。** 做到一半发现是两件事，就拆成两条分支、两个 PR。
- **一条分支一个工作目录。** 同一时间可能有好几个人或代理在改这个仓库，所以每条分支用自己的 `git worktree`，不在别人正在用的文件夹里切分支、改文件。
- **主文件夹 `~/Alfred` 一直停在 `zirma`。** 本机开发版主节点（`zirma.home-node.dev`）跑的就是这个文件夹里的源码，它在哪条分支，开发版就跑哪条。在这个文件夹里只做 `git pull`，不做功能。
- 主题用英文短词，连字符分隔，比如 `feat/notes-library`、`fix/google-retry`、`docs/workflow`。
- 分支活得越短越好。超过一周还没合的，要么拆小先合一部分，要么先把最新的 `zirma` 合进来。

## 2. 做一件事的步骤

0. **大功能和架构，先写设计文档。** 放在 `docs/design/`，批准了才写代码。设计文档可以单独用一条 `docs/` 分支、一个 PR。
1. **开分支和工作目录。**
   ```bash
   cd ~/Alfred && git fetch origin
   git worktree add ../Alfred-<主题> -b feat/<主题> origin/zirma
   cd ../Alfred-<主题> && npm install
   ```
2. **小步提交。** 一个提交只做一件说得清的事，提交之后测试仍然能过。
3. **本地验证。** `npm test` 和 `npm run typecheck` 全过。界面改动按 `AGENTS.md` 去浏览器里看：中英文、窄屏、文字不重叠。没验证到的，写进 PR。
4. **推之前扫一遍。** `origin` 是公开的。看一遍 `git log -p origin/zirma..HEAD`，里面不能有名字、主机、地址、密钥，也不能有别家产品的截图。然后 `git push -u origin feat/<主题>`。
5. **开 PR，目标分支选 `zirma`。** 标题就是合并后的那条提交信息（§3）。正文写四件事：做了什么、为什么、怎么验证的、还没验证什么。有设计文档就链上。
6. **审一遍。** 从头到尾读一遍 PR 的 diff：有没有 bug、有没有漏测、有没有不该进仓库的东西。能找别的人或代理来审更好。发现真问题就在这条分支上改，再推。
7. **CI 绿了再合。** 用 **squash merge**：`zirma` 上一个 PR 只留一条提交，以后回退也只要退一条。合完删掉远端分支，再删掉本地工作目录：`git worktree remove ../Alfred-<主题>`。
8. **主文件夹跟上。** `cd ~/Alfred && git pull`。需要的话重启开发版主节点。

## 3. 提交信息

- 用英文写一句完整的话，说这次改动让什么变了，祈使句开头，末尾不加句号，比如 `Try a Google read again within seconds when the network dropped`。
- 正文可选，用来说为什么，以及不显然的取舍。
- 不加 AI 署名行（`Co-Authored-By`、"Generated with" 之类）。
- 不加 `feat:` 之类的前缀，分支名已经说了是哪一类。

## 4. 版本号

版本号的格式是 `主.次.修`（语义化版本，semver），例如 `0.1.0`：

| 位置 | 什么时候加一 | 例子 |
|---|---|---|
| 修（第三位） | 只修 bug，用起来没有新东西 | `0.1.0` → `0.1.1` |
| 次（第二位） | 有了新功能，或者行为变了。修位归零 | `0.1.3` → `0.2.0` |
| 主（第一位） | 第一次正式给别人用时变成 `1`，之后只在不兼容的大改时才加 | `0.9.2` → `1.0.0` |

- 主位是 `0`，表示还在早期，还没正式给别人用，什么都可能改。
- 版本号写在根目录 `package.json` 的 `version` 里。打包脚本从这里读，App 的「关于」和安装包名里显示的就是它，现在是 `0.1.0`。
- 每发一个版本，就在那条提交上打一个同名的 git tag：`v0.1.0`、`v0.1.1`……tag 把「生产上跑的是哪份代码」钉死。要回退，装上一个 tag 就行。

## 5. 发布到生产（这台 Mac）

1. 从 `zirma` 切一条 `chore/release-0.1.<n>` 分支，只改 `package.json`（和 `package-lock.json`）里的 `version`，按 §2 开 PR、合并。
2. 在合并出来的那条提交上打 tag，再推上去：
   ```bash
   cd ~/Alfred && git pull
   git tag v0.1.<n> && git push origin v0.1.<n>
   ```
3. 安装：`npm run install:mac -- v0.1.<n>`。它会在一个干净的目录里 `npm ci`、跑测试、打包，再替换 `/Applications/Zirma.app`。
4. 看 `~/Library/Logs/Zirma/zirma.home-node.log` 的最新一行，提交号要对得上。
5. 不在生产上改文件，也不装没合进 `zirma` 的东西。

**数据备份。** `install:mac` 每次换 App 之前，都会把生产的数据库备份到 `~/Library/Application Support/Zirma/backups/`，文件名是 `world-<时间>-<提交号>.sqlite`。提交号是当时在跑的那个版本，所以文件里就是「这个版本最后留下的数据」。只保留最近 10 份。

**回退：代码和数据一起退。** 只装回旧 tag 是不够的：新版本可能已经改过数据库的结构，旧代码不一定读得了。回到 `v0.1.<旧>` 的步骤：

1. 在菜单栏退出 Zirma，停掉生产主节点：
   ```bash
   launchctl bootout gui/$(id -u)/zirma.home-node
   ```
2. 找到旧版本留下的那份备份：先 `git rev-parse --short v0.1.<旧>` 拿到它的提交号，再到 `backups/` 里挑文件名带这个提交号的最新一份。
3. 把现在的数据挪到一边（不删），换上那份备份：
   ```bash
   cd ~/Library/Application\ Support/Zirma
   mkdir -p rolled-back && mv world.sqlite* rolled-back/
   cp backups/world-<时间>-<提交号>.sqlite world.sqlite
   ```
4. 装旧版本：`npm run install:mac -- v0.1.<旧>`。它会打开 App，App 会重新拉起主节点。

装新版本之后才写进去的数据（新邮件可以重新同步下来，但手写的待办、笔记这类）会退掉，还留在 `rolled-back/` 里。在装这个功能之前装的版本没有备份，那种只能装回代码。

**急救例外。** 生产坏了、等不及合并时，可以先 `npm run install:mac -- fix/<主题>` 装上。但当天要把这条分支按 §2 合回 `zirma`，再按本节发一个修位版本重装，让生产重新回到 tag 上。

## 6. 自动检查（CI）

`.github/workflows/ci.yml`：每个目标是 `zirma` 的 PR、每次推到 `zirma`，都会在 macOS 上跑 `npm ci`、`npm run typecheck`、`npm test`。

GitHub 上 `zirma` 应该这样保护：
- 必须经 PR 合并，必须 CI 通过，管理员也一样。
- 不要求别人批准（一个人开发时没人能批）。
- 只允许 squash merge；合并后自动删掉分支；禁止强推，禁止删除这个分支。

## 7. 从以前的做法切换过来（2026-11-24）

以前大家都直接往 `alfred-harness` 上提交，GitHub 的默认分支还是早已过时的 `main`。现在：

1. 从 `alfred-harness` 的最后一条提交切出 `zirma`，设为 GitHub 的默认分支。已完成。
2. `~/Alfred` 切到 `zirma`。已完成。
3. 这份文档、`AGENTS.md` 和 CI 都改指 `zirma`，这一步本身就走 §2 的 PR。
4. 按 §6 给 `zirma` 开保护。开之前，「只经 PR 合并」靠自觉。
5. 在 `zirma` 上打 `v0.1.0`（`package.json` 已经是 `0.1.0`），用它重装一次生产，确认 §5 走得通。
