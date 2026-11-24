# Alfred — 跨 Session 交接文档

> 更新：2026-11-23，按当天的工作区（提交加未提交的改动）对过第 3、4、5.1、8 节。2026-11-19 整篇重写过；第 9 节是那一轮的记录，留作历史。
> 用途：下一个 session 读完这一篇，就知道 Alfred 做到哪、下一步做什么、哪些事要先问 Bruce。
> 本文区分**事实**（代码里有、跑过）、**已定**（Bruce 点过头）和**建议**（AI 提的，还没定）。

## 1. 一句话

Alfred 是从 pi-web-robin 抽出来的开源个人助手 harness：一个常驻本机的主节点（home node）、一个 Mac 桌面 App、手机通过 Tailscale 访问。日常这一半（今天、待办、日历、邮件、链接、通知、自动任务）和开发这一半（在项目里读写代码）都已经能用。Robin 仍然是 Bruce 每天在用的工具，大部分个人业务（求职、学习、笔记、研究……）还在 Robin 里，没有搬。

## 2. 工作约定（先读）

怎么起开发环境、什么绝对不碰、怎么验证、提交和推送的规矩：以仓库根目录的 `AGENTS.md` 为准。下面是补充。

- 分支 `alfred-harness`；`main` 受保护。**origin 是公开仓库**：只推应用开发的内容，推之前扫一遍有没有私人信息和参考图。
- 提交不带 Claude 的 co-author 行。只有 Bruce 说了才提交、才推。
- Robin 仓库有别的 session 正在改的未提交内容：**只读，不整理、不回退**。
- 不把 Robin 的 `.env`、令牌、真实数据库、聊天记录复制进本仓库。
- 界面文案要短（一个数，不是一句话）；页面内容按页面列宽排版，任何宽度下文字不重叠；中英双语都要看。
- **开源 App，任何功能不写死、要泛化，能力由用户自己创建**（2026-11-22 已定）：个人的名字、账号、分类、站点、提示词都是数据不是代码；内置项只是可改可删的样例。规则见 `docs/ARCHITECTURE.md` 9.1 节。
- 架构和每个大功能先有设计文档、Bruce 批准后再建。文档在 `docs/design/`，调研在 `docs/research/`，可点的原型在 `prototype/`。

## 3. 已经建成的（事实）

| 块 | 现状 | 在哪 |
|---|---|---|
| 主节点 | 一个进程持有世界（SQLite，事件 + 状态同一事务）、执行任务；租约、心跳、中断后不重跑 | `packages/core`、`packages/server` |
| 引擎 | Pi 跑在子进程里，每个对话一个热会话；Alfred 的工具在主节点执行；闸门拦住所有不是 Alfred 定义的工具 | `packages/engine-pi` |
| 模块契约 | 操作（设备点的）、查询、工具（模型用的，带权限级别）、提议、同步、对外投递；模块只经它用核心（2026-11-23） | `packages/module-kit` |
| 模块 | 待办（来源：日历镜像、邮件建议；Robin 导入已删）；日历（Google 镜像，可直接建、改、拖，Alfred 的改动走提议）；邮件（Gmail 镜像、分类、收藏和星标、写信和回信）；链接（常去、收下的链接、主题、视频架） | `modules/todo`、`calendar`、`mail`、`links` |
| 今天 | 默认打开的页：一句话、今天的日程和待办、计数；首次运行的引导 | `docs/design/today-and-inbox.md` |
| 访问 | 每个地址谁能用（任何设备 / 开发设备 / 只许本机）写在一张表里，没写的地址一律 404（2026-11-23） | `packages/server/src/access.ts` |
| 提议 | Alfred 准备好改动，等你点头；过期、失效、改一改再提 | `packages/core/src/proposals.ts` |
| 自动任务 | 按时间表起任务，无人值守只做可逆的事；早报是内置模板 | `core/src/automations.ts` |
| 注意力 | 一张表决定一条通知由谁、在哪、什么时候告诉你；回来时欢迎语说等了什么；A1–A5 | `docs/design/attention.md` |
| Mac App | Electron；纸质主题；tesseract 形象会跳出来说通知；托盘 | `packages/desktop`、`packages/ui` |
| 界面壳 | 顶栏（日常｜开发）、可完全收起的侧栏、页面底部一条 ask bar（⌘J 或 `/`，带日期的一句直接记成待办或日程）、⌘K 搜索（未提交） | `packages/ui/src/shell` |
| 设置与连接 | Google 一键连接（钥匙串）、模型和订阅登录、MCP 连接器、设备 | `docs/design/settings-and-connections.md` |
| 多设备 | Tailscale Serve + 配对 + Web Push，在 iPhone 上跑通；浏览器闲置上锁；手机底栏可配；设备可申请开发权限 | `docs/research/remote-access.md` |
| 开发模式 | 项目、信任、三种权限模式、带 diff 的批准卡片、改动面板、命令、worktree、提交和开 PR、后台进程、终端、浏览器窗格（D1–D5） | `docs/design/dev-mode.md` |
| 语音输入 | 听写 v1：六处麦克风，主节点用本地 Qwen3-ASR 0.6B 转写 | `docs/research/voice-input.md` |
| 语言 | 中英双语，跟主节点上的设置走 | `packages/ui/src/i18n` |
| 用户自建 | 领域、偏好、页面排序和隐藏、放假的词、推送联系方式都是用户的数据（未提交） | `docs/design/user-defined.md` |
| 评测 | 27 个日常对话场景，用真实模型在临时主节点上跑（未提交） | `scripts/eval` |

## 4. 这一轮（2026-11-23）：架构整理

按 `/improve-codebase-architecture` 查出来的问题改了四处，**都没有提交**。`npm test` 427 个通过，`npm run typecheck`（服务端 + 界面）通过，界面能构建。

1. **访问表。** 远程设备能用哪个地址，以前散在 `http.ts` 十几处，而且默认放行。现在只写在 `packages/server/src/access.ts`：每个地址一个级别，`dispatch` 里检查一次；没写的地址对谁都是 404。测试 `packages/server/test/access.test.ts`。
2. **Gmail 星标走对外队列。** 以前一个专用地址在请求里直接调 Gmail，绕开了队列、请求 id 重放和回执。现在是普通操作 `mail.favorite`：本地立刻改，Gmail 那一步排进队列（可重试、按点击顺序、成功不打扰、失败发通知）；星标还在路上时，收件同步不会把它改回去；取会话后再查一次权限。`/api/modules/mail/favorite` 和 `Home.setMailFavorite` 删了。行为上的变化：点完立刻显示「已在 Gmail 中加星」，Gmail 拒绝时靠通知告诉你。
3. **界面不再强转模块快照，操作名有类型。** `packages/ui/src/modules.ts` 说明每个模块的快照是什么类型（`snapshotOf`）；页面注册表用 `modulePage` 给每页自己模块的快照。每个模块在 `types.ts` 里列出设备能调的操作（`TODO_OPS` 等），`api.op()` 只收这些名字；`packages/server/test/module-types.test.ts` 核对清单和模块一致。
4. **模块只经 `module-kit` 用核心。** 模块源码不再直接 `import "@alfred/core"`；`module-kit` 开头列出模块能用的那几样。同一个测试锁住这条。模块的测试照旧直接用 core 搭世界。

没改的：界面里每个模块的页面、今天页、搜索仍是写在 `packages/ui` 里的（模块是服务端包，界面是另一个应用；要让模块自己带页面，得先有插件做法，见第 5.2 节第 3 条）。`todo-sources.ts` 仍是唯一同时认识待办和日历的地方，有注释说明，先不动。

## 5. Alfred 自己还欠的（按已有计划）

| 事 | 状态 | 依据 |
|---|---|---|
| Links 第二刀：读正文和字幕、写总结、读的时候归主题、后台模型、每天上限 | **先不做**（Bruce 2026-11-19）；开工前查到的事实在文档里 | `docs/design/links.md` §6 第 2 条 |
| Links 之后几刀：全文搜索和 `link_search`、"想做"接到建议的待办、ask bar 里贴网址、手机分享入口、深读（截图 / 内置浏览器 / 转写） | 没做 | `docs/design/links.md` §6 |
| 用你登录过的 Chrome 读有登录墙的站（B 站、小红书），经 bsk（腾讯 BrowserSkill） | Bruce 2026-11-19 要的；**先存着**（他说到时候再考虑怎么做）。有草案，没批准，六个问题没定，什么都没做；bsk 的命令行可以随 app 带，扩展要用户自己装 | `docs/design/browser.md` |
| 多文件输入的剩余部分：扫描件转图片、对话删除时删文件、真实模型下验证 | 第一版已做（2026-11-19） | `docs/design/attachments.md` §2、§3 |
| 开发页浏览器的第三步（Alfred 点和填）、截图给模型、后台进程；整套在真的 Alfred.app 里验证 | 终端和"能看、Alfred 能读"的浏览器已做第一版（2026-11-19） | `docs/design/dev-terminal-browser.md` §4、§5 |
| 日常页"少说话"：底部一行、就地改 | Bruce 已选"底部一行"。**"说一句就落地"已做（2026-11-20）**：底部一行边打边读（`packages/ui/src/shell/read.ts`，本地规则，不经过模型），带日期或时间的句子显示成待办 / 日程，回车直接记下，可撤销；一句里逗号隔开的几件事分开读；问句和"改已有的东西"照旧交给 Alfred。预览上点日期可以换一天。**就地改也接上了待办和日程**（同一天）：卡片里点「说一句…」，这件事挂到底部一行，说"明天""下午3点""晚1小时""做完了"直接改（`shell/say.ts`，本地规则），说得更多的连同这件事交给 Alfred；邮件的之前已做。**提议在日历落点处的虚线预览**也做了：未决提议里的 `calendar.add` / `calendar.move` 画成虚线日程，点开可以接受 / 不用了。**在 Alfred 里建的日程可以在周视图上直接拖**（Bruce 要的，同一天）：改时间、换天，按 15 分钟对齐，时长不变，走 `calendar.edit`；只限 id 以 `alfred` 开头、没有别的参会者、不重复的有时间日程，Google 来的照旧走编辑框；只支持鼠标。**虚线提议也能拖**：提议还是提议，只是那一步换了时间（核心 `amendProposal`，只许用户的设备、不许 run；日历操作 `calendar.retime` 重写那一步的预览，并在摘要末尾记一行"你把…改到了…"）。**还没做**：待办提议在待办页的虚线行（邮件来的建议已有）、提议被你手改后自动让位；没有设计文档；日程的落地、就地改没在真实 Google 账号上走过 | `prototype/less-talk.html` |
| 开发模式 D5：worktree、提交和开 PR 的按钮、后台进程面板 | **已做并提交**（`3e5760d`，2026-11-20）；没对真实 GitHub 推送过 | `docs/design/dev-mode.md` §6 |
| 语音：快说（⌥⇧Space、按住形象、手机按住 Alfred）、常用词、形象的"在听"、Alfred 开口（系统声音 / 本机 Qwen3-TTS） | 2026-11-23 做了，没提交；没在真的 Mac App 里试过；打包 Python 还没做 | `docs/design/voice.md` |
| 注意力 A6：语音出口 | 2026-11-23 随语音做了（空档在设备上判断） | `docs/design/voice.md` §2.3 |
| 远程访问的 tsnet 版本 | 以后 | `docs/research/remote-access.md` |
| 记忆（偏好、做事方法） | 架构里有位置，没有设计文档 | `docs/ARCHITECTURE.md` §8 |
| 打包 Alfred.app | **第一版已打（0.1.0，2026-11-23，未提交）**：`npm run package:mac` → `dist/mac/Alfred.app` 和 `Alfred-0.1.0-arm64.dmg`。不加打包依赖：拿 node_modules 里的 Electron.app 改名，只放生产依赖，不用 asar；ad hoc 签名、没公证（别的 Mac 第一次要右键→打开）；不在「应用程序」里运行时提示移过去。在临时世界上启动验证过（主节点从包里由 launchd 起、四个模块、页面无报错）；**没在真实世界上装过**，装上后会接管 `alfred.home-node`（下次重启主节点生效）。语音转写仍要本机有 `uv`；只有 arm64 | `scripts/package-mac.ts` |
| Google 应用验证（公开发布前） | 没做；现在是"已发布、未验证"，上限 100 人 | 设置与连接 §3.1 |
| 公开名字 | **2026-11-23 定为 Isocline**（美国商标查过：ALFRED 被 Running With Crayons 注册，ISOCLINE 全部失效）；两个声音角色 Ana（女）、Kata（男）。改名方案是草案，没动代码 | `docs/design/rename-isocline.md` |

### 5.1 结构上看到、还没动的（2026-11-20）

提交 `ed7cbda` 整理结构时看过、留下没改的两处。改法已经想好，都还没做。

**`http.ts` 的 `route()`：第 1 条已做（2026-11-23），第 2 条没做。**

1. ~~"只许本机"的判断散在几处~~：已改成访问表（`packages/server/src/access.ts`），而且比当时的打算更进一步，管全部地址的三个级别，不只是"只许本机"，没写的地址一律 404。`needDev` 里要查数据的那几处照旧留在用的地方。
2. 新建 `sessions-http.ts`（形状照 `connections-http.ts`），项目、会话、终端、改动和 diff 搬过去；`route()` 剩下的都是一两行一条的命令转发。还没做。

**日历和邮件的同步：先不动，接第三个按账号镜像的服务时再合。** `syncCalendar` 和 `syncMail` 相同的是账号状态这一套（挑可读的账号、清掉断开的、逐个读、出错记错误和要不要重连、成功记时间和摘要、变了才发事件），不同的只有怎么读、读到的怎么存。两种改法：

- 只抽循环和出错判断、表不动：每边省十来行，要传五六个回调。不值得，不要这样做。
- 把"账号来源"这一行（现在是 `calendar_sources`、`mail_sources` 各一张，列不一样）收成 module-kit 里一张共用的表，状态整个由它管，模块只交三样：怎么读、怎么存、账号没了删什么。每个模块省约 45 行，"要重连"只剩一处。代价是两张表要迁移，读状态的地方和测试跟着改。

现在的计划里没有第三个这样的服务，所以没到做的时候；到了就按第二种做。

### 5.2 写死的地方（2026-11-22 按 ARCHITECTURE 9.1 查的）

第 1、2、5 条已按 `docs/design/user-defined.md` 做完（2026-11-22，没提交；做法和偏差见那篇第 7 节）。同一天第二轮做了第 3（能做的一半）、4、6、7、8、10 条，见那篇第 8 节。只剩第 9 条（只接 Google），和第 3 条里"用户自己加页面或模块"。

已经没问题的：代码里没有 Bruce 的名字、邮箱或私人路径；Alfred 的提示词只说"用户"；链接的默认网站、自动任务、技能、连接器都是用户能建能删的数据。

**用户自己建不了的（先改）**

1. ~~**领域写死七个**~~（已改：领域是用户数据，设置 → 通用里管理）：`packages/core/src/areas.ts:16`，待办和链接都按这张常量表校验。改法：领域进主节点的一张表，首次运行写入这七个当样例，设置里能新建、改名、换色、删除。
2. ~~**早报靠专用代码显示**~~（已改：分块显示、只留最新、有改动才说、颜色都是每个自动任务的选项）：`briefEditorial.ts` 按固定的中英文小标题拆早报；界面多处判断 `template === "brief"`；数据库限定模板只能是 `brief`、`mail_todos`。用户改了早报的写法，显示就会退回普通文字；用户也做不出第二份早报那样的东西。改法：把"按几个分区显示"做成自动任务自己的一项属性，不按模板 id 判断。
3. **模块和页面是固定清单**（做了一半：页面能排序、能关，设置 → 通用 → 页面；用户自己**加**页面或模块要先有插件做法，ARCHITECTURE 第 8 节说第一版不做）：`packages/server/src/cli.ts:29`、`shell/pages.tsx:128`。现在用户能自己加的只有技能、连接器、自动任务。第 8 节说第一版不做插件系统，这条要 Bruce 定：维持，还是让用户也能加页面或模块。
4. ~~**偏好没地方放**~~（已改：设置 → 通用 → 偏好；Alfred 能记能删；每次运行连同称呼一起告诉它）：第 8 节说的 `USER.md`（称呼、语气、默认做法，可见可改）没做，现在只存了称呼、语言、模型。

**只对 Bruce 或一部分人成立的**

5. ~~**从 Robin 导入**~~：已删（2026-11-22，Bruce 定的）。
6. ~~**推送的联系方式**~~（已改：环境变量，否则 `package.json` 的 `homepage`）：`packages/server/src/push.ts:54` 默认填 Bruce 的 GitHub 仓库地址，每个人装上后都会用这个地址向 Apple、Google 的推送服务登记。改成用户自己的联系方式，或者首次运行时设置。
7. ~~**语言只有中文和英文**~~（已改：语言代码一处定，文字都按语言查表；开发会话的权限问题以前只有中文，也修了）：`locale === "zh" ? "zh-CN" : "en-US"` 散在八九处；`modules/calendar/src/write.ts:57` 里日历提议的中文直接写在代码里，没走翻译文件。加第三种语言要到处改代码。改法：一个统一的取语言代码的函数，模块里的文字都进翻译文件。
8. ~~**读网页标题固定要中文**~~（已改：跟用户的语言）：`modules/links/src/fetch.ts:90` 的 `Accept-Language` 写死 `zh-CN`，应该跟用户的语言走。
9. **邮件和日历只接 Google**：已经在 `mail-accounts.md` 的计划里。

**用户改不了的规则（小）**

10. ~~**认"放假"的词是固定的**~~（已改：待办页"来源"里能增删，原来的词是样例）：`modules/todo/src/types.ts:28`，偏学生（停课、学校关门）。默认可以留着，但用户要能加自己的词，或者交给模型判断。

## 6. Robin 里有、Alfred 里还没有的

按 Robin 的目录、README 和 `docs/` 整理，**没有逐个读领域文件**；"大小"是粗估。

### 6.1 Bruce 点名的四个

| 功能 | Robin 里是什么 | Alfred 现状 | 建议怎么搬 | 大小 |
|---|---|---|---|---|
| **Links** | 保存的链接：自动取标题和图标、分组成"家族"、可拖动排序；模型有加链接的工具 | **L1 已做**（`modules/links`：常去、收下、主题、视频架、网站图标）；L2 先不做 | 一个 `links` 模块：表 + 4 个操作 + 2 个工具 + 一页。规则和测试基本原样搬。最小、最独立，适合第一个搬 | 小 |
| **Notes** | 草稿（带图片和 PDF 附件）→ 确认后归档到 Obsidian（默认）或 Notion；另有 Canvas 和 Mind map 两个工作区，Obsidian 库浏览和关系图 | 没有 | 分三刀：① 草稿 + 归档到 Obsidian（核心）；② Notion 走 MCP 连接器，不再自己写 Notion 适配；③ Canvas / Mind map 各是一个大编辑器，单独决定要不要 | 中（①）到大（③） |
| **Higgs 语音** | 浏览器麦克风 PCM → Boson 的 Higgs Realtime（WebSocket）→ 流式语音；闲聊在 Higgs，真事用 `ask_robin` 委派给主模型，有调用栅栏和请求日志 | 只有听写（说 → 文字）。没有全双工对话，没有语音播报 | 这就是架构里的"语音层"（§5.4）和注意力的 A6。委派那一半 Alfred 已经有更好的地基（任务、租约、回执）；要搬的是实时连接、打断、字幕和形象的说/听状态。先写设计文档：数据流（私人内容会不会进 Boson）、锁屏和后台、手机 | 大 |
| **Learning Hub** | 学习入口页、能力地图（图）、路线图、四门课（AI / Web / 交付 / 训练）、书架、Full Stack Open + 导师、NeetCode 刷题 + 教练（提示阶梯）、GPT-2 讲解、AI 周报、播客、视频 | 没有 | 这是一组模块，不是一个。建议先搬"进度 + 书架 + 路线图"这层数据和首页；教练和导师是带专门提示的对话，放到开发模式的会话形态定了之后再搬 | 很大 |

### 6.2 其它没搬的

| 功能 | Robin 里是什么 | 建议 |
|---|---|---|
| 周计划（planner） | 用真实日程算空闲、预览 / 接受、版本检查 | 搬成日历模块上的提议；"少说话"落地后再做 |
| 早报全流程（brief） | 来源采集游标、不可变的证据和版次、预算、邮件摘要、语音早报；独立的 `brief.sqlite` | Alfred 的早报现在只是一个自动任务模板。要不要搬整条流水线，先问 Bruce 现在的早报够不够 |
| Gmail 分类回顾 | 把来信分桶，给约定建日程、给截止建待办 | 这一轮的"邮件 → 建议的待办"是它的一半；建日程那一半走提议，可以接着做 |
| 求职 | 扫职位、按简历和评分表打分、申请、OA / 面试轮次、简历 | Bruce 个人业务里最大的一块。作为个人模块搬，不进开源默认安装；先问还用不用 |
| 外联 / cold reach / CRM | 草稿、审批、去重锁、发信回执 | 规则严（对外不可逆），Alfred 的提议 + outbound 正好接得住；跟求职一起决定 |
| 产品实验室 | 想法、评估、验证、机会、Jarvis 发现 | 个人模块，排后 |
| 研究台 | 研究对话、论文发现 / PDF / 阅读、HEAT 项目页 | 研究对话可以先用普通对话 + MCP 顶；论文阅读室是独立的大块 |
| 科技活动 | 每周扫湾区活动 | 一个自动任务 + 一个小模块，小 |
| 工具箱 | 音视频转换、图片、PDF、OCR、二维码、开发小工具；录音转写；视频摘要 | 大多在浏览器里跑，和 agent 无关。建议不搬，或以后做成一页 |
| Mac 系统 / 清理 | 只许本机的系统信息和清理 | 属于 Mac App 的设备能力；排后 |
| Telegram | 离开电脑时的入口，带按钮和四种推送 | Alfred 已经有手机 PWA + 推送。建议不搬，除非 Bruce 还想要 Telegram |
| 记忆（handover memory） | 交接时的记忆 | 归到 Alfred 的"记忆"设计里一起做 |
| Pi Web 的工作台 | 会话浏览和分支、文件树、终端、worktree、技能、插件、子代理、用量 | 开发模式 D5 覆盖 worktree；内嵌终端明确不做；技能 / 用量可以进设置 |
| Obsidian / Notion 工具 | 模型可用的读写工具 | Notion 用官方 MCP；Obsidian 跟 Notes 一起 |

> 2026-11-19 之后：Bruce 说 Links 不能只是存链接，要的是"会自动分类的互联网地图"：知道一条内容在哪、在说什么，有总结，自动归类；常去的入口（Gmail、日历）也在里面。设计草案在 `docs/design/links.md`（待批准，第 8 节六个问题），原型在 `prototype/links.html`。他同时提了两件相关的事，还没有文档：对话框支持多文件输入（图片、PDF、md、json）；开发页要有终端和浏览器（这改掉了开发模式文档第 7 节的"不做内嵌终端"）。

### 6.3 建议的顺序（还没定）

1. ~~**Links**~~：L1 已做（2026-11-19 起）。
2. **Notes**：方案在 `docs/design/notes.md`（2026-11-20 **已批准**，第 8 节六条都按建议）。它把"草稿 → 归档到 Obsidian"改成了"Alfred 自己的笔记系统：笔记从一开始就是一个文件夹里的 `.md`"。Bruce 定的：库默认是 Alfred 新建的 `Alfred Notes`，和 Obsidian 的库分开；新笔记落在里面的「随手记」；Obsidian 的钩子挪到最后、可选。分 N1 读、N2 写、N3 和 Links 连、N4 可选。原型 `prototype/notes.html` 做了（Bruce 还没看过）；代码没开始，下一步 N1 和 N2 连着做。
3. **Gmail 回顾的另一半 + 周计划**：都落在已有的日历 / 邮件 / 提议上，和"少说话"一起设计。
4. **语音层**（Higgs）：先设计文档，再建。它决定 Alfred 像不像"一个在场的助手"，但要先定数据流和打断规则。
5. **Learning Hub**：先数据和首页，后教练。
6. 求职 / 外联 / 产品 / 研究：按 Bruce 现在还在用哪个来排。

### 6.4 要 Bruce 定的

1. 求职、外联、产品实验室、研究台：哪些现在还在用？不用的不搬。
2. ~~Notes 的 Canvas 和 Mind map 要不要进 Alfred，还是只要草稿 → Obsidian？~~ 已定（2026-11-20）：不搬；笔记按 `docs/design/notes.md` 做。
3. Higgs：继续用 Boson 的云端 Realtime，还是等本地全双工模型（见 `docs/research/full-duplex-voice.md`）？私人查询结果进不进 Boson？
4. Telegram 还要不要？
5. 个人模块放哪：本仓库（公开）里，还是一个私有的模块目录？这决定求职、学习这些怎么搬。
6. 每搬完一块，Robin 里那块停写——从哪一块开始切？待办的切换当时也留着没做。

## 7. 怎么跑

```text
npm start                      构建界面并启动主节点（127.0.0.1）
npm run desktop                Mac App
npm test                       全部测试（node --test，直接跑 .ts）
npm run typecheck              类型检查（服务端 + 界面）
npm run package:mac            打包 dist/mac/Alfred.app 和 .dmg
```

Node 24 以上，直接运行 `.ts`（只用可擦除的语法）。启动命令是 npm 脚本：`npm run trial`（临时世界，:7520）、`npm run dev:ui`（:5173）、`npm run prototype`（:4173）。

## 8. 文档地图

- `docs/ARCHITECTURE.md`：总架构（v0.3），§5.7 设备和访问表，§5.8 是 Robin → Alfred 的映射和模块规则，§10 是现在的仓库结构。
- `docs/design/README.md`：设计主线和形象；`docs/design/style.md`：整体风格。
- `docs/design/workspace-architecture.md`：工作台、提议、自动任务、通知页（已批准，做到 W7）。
- `docs/design/today-and-inbox.md`：今天页和通知页（今天页已做，T2–T4 没做）。
- `docs/design/dev-mode.md`：日常与开发（已批准，D1–D5 已做）；`dev-terminal-browser.md`：开发页的终端和浏览器。
- `docs/design/settings-and-connections.md`：设置、Google、模型、连接器。
- `docs/design/attention.md`：注意力（已批准）。
- `docs/design/links.md`：链接（已批准，L1 已做，L2 先不做）。
- `docs/design/user-defined.md`：不写死、用户自建（第 7、8 节是做法）。
- `docs/design/attachments.md`：多文件输入。
- `docs/design/mail-accounts.md`：多个邮箱账户（提议，没做）。
- `docs/design/notes.md`：笔记（已批准，没开始做）。
- `docs/design/study-mode.md`：学习模式（v0.1，方向认可，细节没定，没写代码）。
- `docs/packaging.md`：打包 Isocline.app 的流程、怎么安全地试、正式发布前还缺什么。
- `docs/design/rename-isocline.md`：从 Alfred 改名为 Isocline（2026-11-23 Bruce 定了名字和 Ana/Kata 两个声音角色；文档是草案，没批准，没写代码）；字标原型 `prototype/isocline.html`。
- `docs/design/browser.md`：用已登录的 Chrome 读登录墙（先存着，没批准）。
- `docs/research/`：形象、视觉、远程访问、语音输入、全双工语音、工作台能力、Web 和手机安全。

## 9. 2026-11-19 那一轮的状态（历史记录）

三件事的代码都写完了，**都没有提交**。`npm test` 223 个通过，`npm run typecheck` 通过。

| 事 | 验证到哪 | 没验证的 |
|---|---|---|
| D4 命令 + 设备范围 `dev` | 核心规则、任务里的问答和授权、HTTP 上的 `needs_dev`，都有测试 | 引擎子进程里的闸门没有用真实的 Pi 回合跑过 `bash`；设备开关没在配对的手机上点过 |
| MCP 连接器 | 测试用一个本地的 MCP 服务跑通了"带密钥请求头连上、数工具、被拒、要登录"；在临时主节点上对真实服务：Context7 连上（2 个只读工具），Notion 走到授权页，假的 GitHub 令牌被拒；设置页在宽窄两种宽度下看过 | 浏览器里点完 OAuth 同意之后的那一半；连上以后在一次真实对话里调用工具 |
| 待办来源 | 日历镜像和邮件建议的规则有测试；待办页在临时主节点上看过（建议行、留下、来源标签、手机宽度）；带旧数据的库升级有测试 | 真的日历同步触发镜像（`packages/server/src/todo-sources.ts` 这条桥没有自动测试）；「从邮件里挑待办」这个自动任务没有用真实模型跑过 |

**待办来源里我替 Bruce 定的默认值（都能改）：**

- 日历默认只把**全天日程**变成待办（待办页上可以改成"所有日程"或"不进待办"），只看未来 14 天，拒绝了的邀请不算。
- 日历来的待办直接是待办（那是你自己的日历）；邮件来的是**建议**，虚线行，你点「留下」才算，点 ✕ 以后同一封邮件不会再提。
- 你改过、完成过的镜像待办归你，日历再变也不动它；没动过的跟着日程改名、改期，日程删了它就归档（不是删除）。
- 「从邮件里挑待办」是一个内置自动任务，**默认关**，每天 09:00；待办页上有开关和「现在挑」。

**要注意的：**

- 这个工作区里同时有**另一个 session 的未提交改动**（至少 `packages/ui/src/App.tsx`、`Calendar.tsx`、`SourceBar.tsx`、`shell/Dock.tsx`、`shell/ask.css`）。提交这一轮的东西时要分开挑文件；`i18n/zh.ts`、`en.ts`、`styles.css`、`shell/pages.tsx` 两边都可能动过，逐块看。
- 新代码带三个数据库迁移（`core:13`、`core:14`、`todo:2`）。正在跑的 Alfred 还是旧代码；重启它就会迁移你真实的库。迁移不可逆（旧代码打不开迁移后的库）。
- 这一轮没有重新构建 `packages/ui/dist`，所以正在用的 App 界面没变。验证用的是另一个目录里的构建（主节点新认 `ALFRED_UI_DIR`）。

**之后同一天又做了 Links 第一刀**（`docs/design/links.md` 已批准，L1 已实现，也没有提交）：模块 `modules/links`（id `link`，迁移 `link:1`、`link:2`）、页面、常去、收下并取标题、网站自己的图标（主节点下载一次、自己提供）、主题、Alfred 的五个工具。在临时主节点上用真实网址试过：文章、GitHub、YouTube 取到标题；小红书认出登录墙；B 站对如实报出身份的程序不给内容，只有网址得来的名字。测试共 249 个（语音那个测试在整套一起跑时偶尔超时，单独跑是过的）。

侧栏里「邮件」排在「链接」上面（Bruce 定的）。

**下一步的候选**：多文件输入和开发页的终端 / 浏览器各自的设计文档；D5；"少说话"的设计文档。Links L2 先不做（见第 5 节）。
