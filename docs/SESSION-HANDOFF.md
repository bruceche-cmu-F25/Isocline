# Zirma：跨 Session 交接文档

> 更新：2026-11-24，按 `zirma` 上的 `b7a368b`（PR #5）和 GitHub 上开着的 PR 对过全篇。上一版（2026-11-23）还叫 Alfred，写的是 `alfred-harness` 上没提交的改动；那些改动现在都已经在 `zirma` 上了。更早的记录（2026-11-19 那一轮）看这篇文档的 git 历史。
> 用途：下一个 session 读完这一篇，就知道 Zirma 做到哪、下一步做什么、哪些事要先问 Bruce。
> 本文区分**事实**（代码里有、跑过）、**已定**（Bruce 点过头）和**建议**（AI 提的，还没定）。

## 1. 一句话

Zirma（读作 ZEER-ma；2026-11-23 前叫 Alfred，11-24 前叫 Isocline）是从 pi-web-robin 抽出来的开源个人助手 harness：一个常驻本机的主节点（home node）、一个 Mac 桌面 App、手机通过 Tailscale 访问。日常这一半（今天、待办、日历、邮件、链接、通知、自动任务、语音）和开发这一半（在项目里读写代码）都已经能用。生产版 `v0.1.0` 装在 Bruce 的 Mac 上。Robin 仍然是 Bruce 每天在用的工具，大部分个人业务（求职、学习、笔记、研究……）还在 Robin 里，没有搬。

## 2. 工作约定（先读）

以仓库根目录的 `AGENTS.md`（规矩）和 `docs/WORKFLOW.md`（分支、提交、版本、发布）为准。最要紧的几条：

- **主线是 `zirma`**，也是 GitHub 的默认分支，已开保护。一件事一条分支（`feat/`、`fix/`、`docs/`、`chore/`），从 `origin/zirma` 切，放在自己的 git worktree 里，开 PR，CI 绿了再 squash 合并。`main`、`alfred-harness` 是历史，不动。
- **主文件夹只跟 `zirma`、不做功能**：开发版主节点跑的就是它的源码。在 Bruce 那台跑着开发版的 Mac 上，它是 `~/Alfred`（路径是历史原因，先不改，见 PR #7）。新的工作目录叫 `../Zirma-<主题>`。
- **只有 Bruce 说了才提交、才推。** 提交不带 AI 的 co-author 或"generated with"行。**origin 是公开仓库**：推之前扫一遍有没有私人信息和别家产品的截图。
- **绝不碰生产**：端口 7480 / 7490、`~/Library/Application Support/Zirma`、钥匙串 `Zirma`、`ZIRMA_ENV=production`。不要在浏览器里打开 127.0.0.1:7480。试东西用 `npm run trial`（临时世界）。
- **生产只从版本 tag 装**：`npm run install:mac -- v0.1.<n>`，装之前会自动备份数据库；回退时代码和数据一起退（WORKFLOW §5）。
- 同一个 checkout 里可能有别的 session 在改：**不回退、不 stash、不整理**别人的改动。
- 不把 Robin 的 `.env`、令牌、真实数据库、聊天记录复制进本仓库。
- 界面文案要短；任何宽度下文字不重叠；中英文都要看；界面改动要自己在无头 Chrome 里看过。
- **开源 App，任何功能不写死、要泛化，能力由用户自己创建**（2026-11-22 已定）：个人的名字、账号、分类、站点、提示词都是数据不是代码；内置项只是可改可删的样例（`docs/ARCHITECTURE.md` 9.1 节）。
- 架构和每个大功能先有设计文档、Bruce 批准后再建。文档在 `docs/design/`，调研在 `docs/research/`，可点的原型在 `prototype/`。

## 3. 已经建成的（事实，都已在 `zirma` 上）

| 块 | 现状 | 在哪 |
|---|---|---|
| 主节点 | 一个进程持有世界（SQLite，事件和状态写在同一个事务里）、执行任务；租约、心跳，中断后不重跑 | `packages/core`、`packages/server` |
| 引擎 | Pi 跑在子进程里，每个对话一个热会话；Zirma 的工具在主节点执行；闸门拦住所有不是 Zirma 定义的工具 | `packages/engine-pi` |
| 模块契约 | 操作（设备点的）、查询、工具（模型用的，带权限级别）、提议、同步、对外投递；模块只经它用核心；快照和操作名有类型 | `packages/module-kit` |
| 待办 | 来源：日历镜像、邮件建议；领域和"放假"的词都是用户数据 | `modules/todo` |
| 日历 | Google 镜像；可以直接建、改，Zirma 建的日程能在周视图上拖；Zirma 自己的改动走提议，虚线提议也能拖 | `modules/calendar` |
| 邮件 | Gmail 镜像、分类、标签、归档、收藏和星标（星标走对外队列）、写信和回信；只接 Google | `modules/mail` |
| 链接 | 常去（可建文件夹）、收下、视频架；v0.5 的分类树、搜索、从浏览器书签导入 | `modules/links`、`docs/design/links.md` §4.10 |
| 今天 | 默认打开的页：先列等你决定的事，再列今天的日程和待办、计数；首次运行的引导 | `docs/design/today-and-inbox.md` |
| 提议 | Zirma 先把改动准备好，等你点头；会过期、失效，改一改可以再提 | `packages/core/src/proposals.ts` |
| 自动任务 | 按时间表起任务，无人值守时只做可逆的事；早报是一个可改的样例 | `packages/core/src/automations.ts` |
| 注意力 | 一张表决定一条通知由谁、在哪、什么时候告诉你；A1–A6 | `docs/design/attention.md` |
| 访问 | 每个地址谁能用（任何设备 / 开发设备 / 只许本机）写在一张表里，没写的一律 404 | `packages/server/src/access.ts` |
| 界面壳 | 顶栏（日常｜开发）、侧栏、底部一条 ask bar（带日期的一句直接记成待办或日程）、⌘K 搜索 | `packages/ui/src/shell` |
| 设置与连接 | Google 一键连接（钥匙串）、模型和订阅登录、MCP 连接器、设备、偏好、页面排序和隐藏 | `docs/design/settings-and-connections.md` |
| 多设备 | Tailscale Serve、配对、Web Push，在 iPhone 上跑通；浏览器闲置上锁；手机底栏可配 | `docs/research/remote-access.md` |
| 开发模式 | 项目、信任、三种权限模式、带 diff 的批准卡片、改动面板、命令、worktree、提交和开 PR、后台进程、终端、浏览器窗格；会话里能选模型和分支 | `docs/design/dev-mode.md`、`dev-terminal-browser.md` |
| 多文件输入 | 图片、PDF、md、json 跟一句话一起发 | `docs/design/attachments.md` |
| 语音 | 听写（本机 Qwen3-ASR）；快说（⌥⇧Space、按住形象、手机上按住圆泡）；Zirma 开口：系统声音、本机 Qwen3-TTS，或云端声音（ElevenLabs，`speak-cloud.ts`） | `docs/design/voice.md` |
| 语言 | 中英双语，语言存在主节点上 | `packages/ui/src/i18n` |
| Mac App 和打包 | Electron；纸质主题；超立方体形象；托盘。`npm run package:mac` 打出 `Zirma.app` 和 DMG（ad hoc 签名、没公证、只有 arm64） | `packages/desktop`、`docs/packaging.md` |
| 开发与生产分开 | 世界、端口、launchd 代理、钥匙串都各用一套；开发版拒绝用生产的世界；可以按需把生产的世界复制进开发版（`npm run dev:copy-world`）；开发版菜单里能更新已装的 App | `packages/core/src/stage.ts` |
| 安装和备份 | `npm run install:mac -- <tag>`：在干净目录里 `npm ci`、跑测试、打包、换掉 `/Applications/Zirma.app`；换之前备份生产的数据库，留 10 份 | `scripts/install-mac.ts` |
| 改名迁移 | 认 Isocline、Alfred 两个旧名字：数据目录、日志、钥匙串、launchd、cookie、浏览器本地设置、环境变量都自动搬 | `docs/design/rename-zirma.md` |
| 评测 | 27 个日常对话场景，用真实模型在临时主节点上跑 | `scripts/eval` |
| CI | 每个目标是 `zirma` 的 PR 都在 macOS 上跑 `npm ci`、`typecheck`、`test` | `.github/workflows/ci.yml` |

最近一次全量验证（PR #4，2026-11-24）：`npm run typecheck` 通过，`npm test` 476 个全过。

## 4. 最近两天做了什么（2026-11-23 到 11-24）

按时间顺序，都已合进 `zirma`：

1. **架构整理**：访问表、Gmail 星标走对外队列、模块快照和操作名的类型、模块只经 `module-kit` 用核心（`1f725dc`、`8b0adc6`、`6320248`）。
2. **语音 V1–V5**（`e9c466e`），之后加了云端声音（`6ffa82a`）。
3. **新用户的首次运行**（`c932b1f`）。
4. **打包和安装**：`package:mac`、`install:mac`，开发与生产分开（`e1d5a43` 到 `73e4b92`）。
5. **改名两次**：Alfred → Isocline（`c40094c`），Isocline → Zirma（PR #4）。生产已迁到 `Zirma.app` 的 `v0.1.0`（PR #5，过程见 `rename-zirma.md` §6）。
6. **开发版那边的一批**（`6ffa82a`）：链接的分类树和书签导入、邮件标签和归档、云端声音、手机键盘和待办页。
7. **流程**：`WORKFLOW.md`、CI、`zirma` 当主线、每次安装前备份、启动脚本统一成 npm 脚本（`f99aeb1`、PR #1–#3）。
8. **网络断了以后，Google 读取几秒内重试，并说明失败原因**（`e8e1899`）。

## 5. 开着的 PR 和等 Bruce 看的设计

| 东西 | 状态 | 在哪 |
|---|---|---|
| PR #6：人始终在控制（产品、地图、决策三样东西，加会话回执） | 草案 v0.3，**待看，未批准**；代码没开始 | 分支 `docs/in-control`：`docs/design/in-control.md`、`prototype/in-control.html` |
| PR #7：新的工作目录和新代码用 Zirma 命名 | 小改，等合 | 分支 `docs/worktree-names` |
| 日历上的待办（每天一行「待办」，拖下来的都落在今天） | 草案 v0.1，**待看**；起因是 Bruce 一句话，理解错了就整篇作废 | `docs/design/calendar-todos.md`、`prototype/calendar-todos.html` |
| 目标（第三种模式，一个长期目标一个地方；原名学习模式） | v0.10（2026-11-27），不当老师（去掉练习、出题、间隔重复和「提示」做法）；世界观页和路线页都照「先讲明白、你来问」重做了，第 8 节的项都定了；已批准；只做电脑端；G1 做了（`modules/goals`：目标和文件夹、第三个模式、世界观和路线两页的显示和手改），还没有接模型；下一刀是让模块的后台任务能要上网工具，再做 G4 | `docs/design/goals.md`、`prototype/goals.html` |
| 多个邮箱 | 草案 v0.1，没批准 | `docs/design/mail-accounts.md` |
| Notes（`Alfred Notes` 文件夹里的 Markdown，Obsidian 可选） | **已批准，代码没开始**。原型 Bruce 还没看；下一步 N1、N2 连着做 | `docs/design/notes.md`、`prototype/notes.html` |

注意：`settings-and-connections.md` 的抬头仍写着"草案、没据此改代码"，但大半已经实现了；以后改这份文档时顺手把抬头对上。

## 6. 还欠的（按已有计划）

### 6.1 做了但没验证完的

| 事 | 没验证的 | 依据 |
|---|---|---|
| 改名迁移 | 手机 cookie 的换发（下次用手机打开时发生）；开发版从 `Isocline Dev` 搬到 `Zirma Dev`、换成 `zirma.home-node.dev`（开发版 App 下次打开或主节点重启时发生）；钥匙串里 `push:vapid`、`voice:elevenlabs` 第一次用时才会复制 | `rename-zirma.md` §6 |
| 语音 | 对着真麦克风说一句（当时那台 Mac 的 USB 麦克风录到的全是静音）；⌥⇧Space 和菜单里的静音要 Bruce 自己按；本机模型要 `uv`，Python 还没打进包 | `voice.md` §5 |
| 日历和"少说话" | 日程的落地、就地改没在真实 Google 账号上走过 | `prototype/less-talk.html` |
| 开发模式 D5 | 没对真实 GitHub 推送过 | `dev-mode.md` §6 |
| 多文件输入 | 扫描件转图片、对话删除时删文件、真实模型下验证 | `attachments.md` §2、§3 |

### 6.2 没做的

| 事 | 状态 | 依据 |
|---|---|---|
| Links L2：读正文和字幕、写总结、后台模型 | **先不做**（Bruce 2026-11-19） | `links.md` §6 |
| Links 其余：`link_search` 全文索引、ask bar 里贴网址、手机分享入口、深读 | 没做 | `links.md` §6 |
| 用你登录过的 Chrome 读登录墙（B 站、小红书） | **先存着**；草案没批准 | `browser.md` |
| 开发页浏览器的第三步（Zirma 自己点和填）、截图给模型 | 没做 | `dev-terminal-browser.md` §4、§5 |
| 今天页 T2–T4（通知收窄、判断层、通知的卡）、T6 学习段 | 没开始 | `today-and-inbox.md` §7 |
| "少说话"的剩余：待办提议在待办页上的虚线行；提议被你手改后自动让位 | 没做，也没有设计文档 | `prototype/less-talk.html` |
| 记忆（`ASSISTANT.md`、`USER.md`、`MEMORY.md`） | 架构里有位置，没有设计文档。偏好已经有了（设置 → 通用 → 偏好） | `ARCHITECTURE.md` §5.1、§8 |
| 远程访问的 tsnet 版本 | 以后 | `remote-access.md` |
| 对外发布：开发者签名和公证、自动更新、Intel 或通用包、libvips 许可证、Python 打进包 | 没做 | `packaging.md` §7 |
| Google 应用验证 | 没做；现在是"已发布、未验证"，上限 100 人 | `settings-and-connections.md` §3.1 |
| 商标 | 上线前请律师查一次 IceWhale 的 ZIMA；zirma.dev 已注册，zirma.app 还没买 | `rename-zirma.md` §1 |

### 6.3 结构上看到、还没动的

- **`http.ts` 的 `route()`**：新建 `sessions-http.ts`（形状照 `connections-http.ts`），把项目、会话、终端、改动和 diff 搬过去；`route()` 只剩一两行一条的命令转发。还没做。
- **日历和邮件的同步**：等接第三个按账号镜像的服务时再合。到时把 `calendar_sources`、`mail_sources` 收成 `module-kit` 里一张共用的账号来源表，模块只交三样：怎么读、怎么存、账号没了删什么。不要只抽循环、表不动的那种（省得少，要传五六个回调）。
- **写死的地方**（按 ARCHITECTURE 9.1 查过）：只剩两条。一是邮件和日历只接 Google（见 `mail-accounts.md`）；二是用户还不能自己**加**页面或模块，这要先有插件做法，ARCHITECTURE 第 8 节说第一版不做，要 Bruce 定。`todo-sources.ts` 仍是唯一同时认识待办和日历的地方，有注释，先不动。

## 7. Robin 里有、Zirma 里还没有的

按 Robin 的目录、README 和 `docs/` 整理，**没有逐个读领域文件**；"大小"是粗估。

| 功能 | Robin 里是什么 | Zirma 现状 / 建议 | 大小 |
|---|---|---|---|
| Notes | 草稿 → 归档到 Obsidian 或 Notion；Canvas、Mind map | 按 `notes.md` 做（已批准）；Canvas 和 Mind map 不搬（已定） | 中 |
| Higgs 语音 | 浏览器麦克风 → Boson Higgs Realtime，全双工；真事委派给主模型 | Zirma 有"一来一回"的快说，没有全双工通话。先写设计文档，先定数据流（私人内容进不进 Boson） | 大 |
| Learning Hub | 能力地图、路线图、四门课、书架、导师、刷题教练、周报 | 落在「目标」这个模式（`goals.md`）里；刷题教练不进来（2026-11-27：不出题、不检验） | 很大 |
| 周计划 | 用真实日程算空闲、预览 / 接受 | 搬成日历模块上的提议 | 中 |
| 早报全流程 | 采集游标、证据和版次、预算、语音早报 | 现在是一个自动任务样例；要不要搬整条流水线，先问 Bruce 够不够 | 中 |
| Gmail 分类回顾 | 来信分桶，给约定建日程、给截止建待办 | 建待办的一半已做；建日程那一半走提议 | 小 |
| 求职、外联 / CRM | 扫职位、打分、申请、面试轮次；外联草稿、审批、去重、发信回执 | 个人模块，不进开源默认安装；先问还用不用 | 大 |
| 产品实验室、研究台、科技活动 | 想法评估；论文阅读室；湾区活动 | 个人模块排后；研究对话先用普通对话 + MCP 顶 | — |
| 工具箱、Mac 清理、Telegram | 浏览器里的小工具；本机清理；离开电脑时的入口 | 建议不搬，除非 Bruce 还要 | — |

**建议的顺序（还没定）**：Notes（N1、N2）→ Gmail 回顾的另一半 + 周计划 → 语音层（Higgs）→ 学习 → 个人模块（按 Bruce 还在用哪个排）。

## 8. 要 Bruce 定的

1. PR #6「人始终在控制」、`calendar-todos.md`、`mail-accounts.md`：看过后批不批。
2. 求职、外联、产品实验室、研究台：哪些现在还在用？不用的不搬。
3. Higgs：继续用 Boson 的云端 Realtime，还是等本地全双工模型（`docs/research/full-duplex-voice.md`）？私人查询结果进不进 Boson？
4. Telegram 还要不要？
5. 个人模块放哪：本仓库（公开），还是一个私有的模块目录？
6. 每搬完一块，Robin 里那块就停止写入。从哪一块开始切？待办的切换当时也没做。
7. 用户能不能自己加页面或模块（要先有插件做法）。
8. `ARCHITECTURE.md` 第 12 节还没定的：什么时候绝不出声、记忆里的敏感信息、自我更新到哪一级、开源用户的默认语音、对外文档用什么语言、Robin 是否退役。

## 9. 怎么跑

```text
npm install                    装依赖（Node 24 以上，直接跑 .ts）
npm run trial                  临时世界的主节点，:7520（另一个端口用 ZIRMA_PORT=…）
npm run dev:ui                 界面热更新，http://127.0.0.1:5173，代理到 :7520
npm run prototype              可点的原型，http://127.0.0.1:4173
npm start                      构建界面，起开发版主节点（:7491，世界 Zirma Dev）
npm run desktop                从源码跑 Mac App（开发版）
npm test                       全部测试
npm run typecheck              类型检查（服务端 + 界面）
npm run package:mac            打包 dist/mac/Zirma.app 和 .dmg
npm run install:mac -- <tag>   从一个 tag 装生产（只在 Bruce 要发版时）
npm run dev:copy-world         把生产的世界复制进开发版
```

## 10. 文档地图

- `AGENTS.md`：规矩。`docs/WORKFLOW.md`：分支、提交、版本、发布、回退。
- `docs/ARCHITECTURE.md`：总架构（v0.3，整体没批准，但代码按它建了大半）。§5.7 设备和访问表，§5.8 Robin → Zirma 的映射和模块规则，§9.1 不写死，§12 待定决定。
- `docs/packaging.md`：怎么打包、怎么安全地试、对外发布前还缺什么。
- `docs/design/README.md`：设计主线和形象。`style.md`：整体风格，写新页面先看它。
- 已批准、已做：`workspace-architecture.md`（工作台，到 W7）、`dev-mode.md`（D1–D5）、`dev-terminal-browser.md`、`attention.md`（A1–A6）、`links.md`（L1 + v0.5 的树）、`user-defined.md`、`attachments.md`、`voice.md`、`rename-zirma.md`。
- 部分做了：`today-and-inbox.md`（T1、T5 做了，T2–T4 没做）、`settings-and-connections.md`。
- 已批准、没开始：`notes.md`。
- 草案：`calendar-todos.md`、`mail-accounts.md`、`browser.md`（先存着）、PR #6 的 `in-control.md`。
- 历史：`rename-isocline.md`（已被 `rename-zirma.md` 取代，里面有名字的来由和商标检查）。
- `docs/research/`：形象、视觉、远程访问、语音输入、全双工语音、工作台能力、Web 和手机安全；`goals-trial/` 是「目标」模式用真模型写世界观和路线的试验（2026-11-27）。
