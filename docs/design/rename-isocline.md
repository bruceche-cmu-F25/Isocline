# 从 Alfred 改名为 Isocline

> 状态：v0.2（2026-11-23）。Bruce 说"开始做吧，先不做 ana 和 kata 的模式切换"：R1–R4 当天做完，没提交，见第 8 节。原型：[prototype/isocline.html](../../prototype/isocline.html)（字标和 i 上的点）。
> 本文区分【已定】（Bruce 说了的）、【事实】（代码里查到的）和【建议】（还没定）。

## 1. 已经定了的

- 【已定】产品改名 **Isocline**。原因：Running With Crayons 在美国注册了 ALFRED（US 4473267、4840694，都已续展），范围覆盖"数字管家服务"和效率软件，和我们正面重合。ISOCLINE 在美国商标局 4 条记录全部失效、都不是软件类；ISOCLINIC、ISOKLINE 没有记录（2026-11-23 查）。
- 【已定】两个可以对话的角色：**Ana**（女声）和 **Kata**（男声）。ana 和 kata 是四维几何里第四维的两个方向，相当于三维的"上"和"下"。
- 【已定】字标仍用 **Geist Serif**（一个字重，不用斜体，不用于中文）。
- 【已定】形象仍是超立方体。

### 名字怎么讲（对外的说法要准确）

- isocline 本义是"等斜线"：微分方程里斜率相同的点连成的线。它本身不是四维旋转。
- 名字取自 **isoclinic rotation**（等斜旋转）：四维里两个互相垂直的平面同时转、转过相同的角度。形象干活和思考时的动作（`tesseract.js` 的 `turn2`，XW 与 YZ 同角）正是一次等斜旋转。
- 对外一句话：**"Isocline 的形象是一个超立方体；它干活时，就在做一次等斜旋转。Ana 和 Kata 是第四维的两个方向。"**
- 不要说"isocline 就是超立方体的转动"，懂数学的人会指出来。

## 2. 字标

原型里试了 10 种 i 上的点，规则是：每个 i 用无点的 ı（U+0131，Geist Serif 有），点由我们画在字体原来的位置上（字体单位 x 91–203、y 607–717，换算成 line-height 1 下距左 0.147em、距顶 0.193em）。对照行把我们的点叠在字体自己的点上，位置重合。

小写 **isocline** 正好有两个 i，两个点一个给 Ana、一个给 Kata。这是选小写的最大理由；大写 Isocline 只剩一个 i，故事讲不出来。

| 方案 | 看法 |
|---|---|
| 原样圆点 | 最稳，什么都没说 |
| **两种颜色**（左暖 Ana、右蓝 Kata） | 【建议】首选：小到 17px 仍看得出，故事一眼就懂，深浅色都好 |
| **同角度的方块**（悬停时一起转） | 【建议】备选：最贴"等斜旋转"，适合官网大标题和启动画面；小尺寸像噪点 |
| 菱形 | 安静、几何，但没讲故事 |
| 一上一下（ana 高、kata 低） | 只有懂的人才看得出 |
| 超立方体做点 | 大尺寸可爱，小尺寸糊；而且形象已经在旁边了，重复 |
| 字体自带的 ELSH 轴 | 拉到 100 是**心形**点（字体作者的彩蛋），气质太甜，不用 |

【建议】组合用：日常（侧栏、App 名、文档）用"两种颜色"的圆点；官网首屏和首次启动用"同角度的方块"，并让两个点一起转一圈。

## 3. 改名会动到哪些地方

【事实】2026-11-23 在仓库里统计：带 Alfred 的源文件约 280 个（packages 和 modules），界面翻译里中文 100 条、英文 103 条，文档 25 篇、原型 18 个。按"用户看不看得到"和"有没有存下来的数据"分四层：

### 3.1 品牌层：用户看得到，没有存下来的数据（直接改）

- App 名、bundle id（打包脚本从 `package.json` 的 homepage 推出来）、Info.plist、DMG 文件名、Dock 和菜单栏、窗口标题、通知标题（`push.ts` 里写死的 `"Alfred"`）、关于和设置页标题。
- 界面文案里指**产品**的 Alfred → Isocline。
- README、LICENSE 里的项目名、`package.json` 的 homepage、THIRD-PARTY-NOTICES。
- 官网（`~/alfred-homepage`，不在本仓库）。
- GitHub 仓库改名（GitHub 会自动把旧地址重定向过去）。

### 3.2 助手的名字：从写死改成用户数据

【事实】现在 "Alfred" 一个词同时是产品名和助手的名字："问 Alfred""Alfred 有个提议"，以及引擎提示词 `profiles.ts` 里的 "You are Alfred"。

【建议】拆开：
- **产品名** Isocline：只出现在 App 名、关于、官网这类"这是什么软件"的地方。
- **助手名**：凡是"它说话、你叫它"的地方都用 `{assistant}` 变量，取用户设置里的名字。默认是当前声音角色的名字（Ana 或 Kata），用户可以改。Bruce 自己那一份可以改回 **Alfred**：在自己电脑上这样叫，不是拿它去推产品，不涉及商标。
- 引擎提示词用 `You are {assistant}, the user's personal assistant in Isocline…`。
- 这也符合 ARCHITECTURE 9.1：名字是用户数据，不写死。

### 3.3 存下来的数据：要迁移，不能直接改名，否则老用户的东西会"消失"

| 东西 | 现在 | 改成 | 不迁移会怎样 |
|---|---|---|---|
| 数据目录 | `~/Library/Application Support/Alfred` | `…/Isocline` | 打开是一个空世界 |
| Mac App 自己的文件 | `…/Alfred/Desktop` | `…/Isocline/Desktop` | 设备 id 变了，形象位置丢了 |
| launchd 标签 | `alfred.home-node` | `isocline.home-node` | 两个主节点抢同一个端口 |
| 日志 | `~/Library/Logs/Alfred` | `…/Isocline` | 只是旧日志留在原处 |
| 钥匙串服务名 | `Alfred`（`secrets.ts`，可用 `ALFRED_KEYCHAIN_SERVICE` 改） | `Isocline` | Google 和模型的登录全部丢失 |
| 配对手机的 cookie | `alfred_device`（`remote.ts`） | `isocline_device` | 所有配对的手机被登出 |
| 浏览器本地设置 | 约 20 个 `alfred.*` 键（主题、字号、侧栏宽度、草稿……） | `isocline.*` | 每台设备的偏好回到默认 |

【建议】做法：
- **主节点启动时**：新目录不存在、旧目录存在 → 把旧目录**整个移过去**（同一块磁盘，瞬间完成），在旧位置留一个说明文件。日志同理。
- **钥匙串**：读的时候先找新服务名，找不到再找旧的，找到就复制到新名下。**旧的一份留着不删**：换过去的那段时间里旧版本的主节点可能还在跑，要退回旧版本也要靠它；只有用户自己删一个凭证时，才连旧的一起删，免得它又被读回来。
- **cookie**：两个名字都认一段时间；认出旧的就换发新的。
- **localStorage**：界面加载时一次性把 `alfred.*` 复制成 `isocline.*`。
- **launchd**：新 App 第一次打开时把旧的 `alfred.home-node` 停掉、删掉它的 plist，再装新的；在这之前先等旧节点把当前的活做完（主节点本来就有租约，中断的任务不会重跑）。
- 迁移要有测试，并且在一个临时世界上从头到尾走一遍；Bruce 的真实世界在这之后才迁。迁移不可逆：迁完的数据旧版本打不开，和以前加数据库迁移是同一回事。

### 3.4 内部标识：用户基本看不到

| 东西 | 建议 |
|---|---|
| 包名 `@alfred/*`（12 个，没发布到 npm） | 改成 `@isocline/*`。纯机械替换，一次改完 |
| 环境变量 `ALFRED_*`（约 20 个） | 改成 `ISOCLINE_*`，旧名继续认一个版本 |
| 事件里的执行者 `actor: "alfred"`（写在数据库里，`schema.ts` 的 `ACTORS`） | **不改**。这是存下来的值，改要迁移所有事件；界面显示时本来就换成助手名 |
| 偏好的 `by: "alfred"` | 同上，不改 |
| 日历里 Alfred 建的日程 id 前缀 `alfred…`（`calendar/src/write.ts`，已经存在用户的 Google 日历里） | 新建的改用 `isocline…`；识别时**两个前缀都认**，否则以前建的日程不能再拖动 |
| 开发会话的分支前缀 `alfred/` | 新分支用 `isocline/`，旧分支不动 |
| 临时文件前缀 `alfred-voice-` 等 | 跟着改，没影响 |
| CLI 命令（`npm run alfred`） | 改成 `isocline` |

### 3.5 文档、原型、记忆

- 设计文档和原型里的 Alfred 改成 Isocline 或"助手"；已经完成的历史记录（交接文档第 9 节这类）保持原样，开头加一句"当时还叫 Alfred"。
- `docs/research/alfred-entity.md` 这类文件名可以改名；改了要同时改所有链接。

## 4. Ana 和 Kata

- 【建议】**同一时间只有一个在跟你说话**：设置里选当前的声音角色，默认 Ana。理由：两个同时说话会争话轮；"今天"页和通知只需要一个声音。
- 【建议，可选】按模式自动切换：日常页是 Ana，开发模式是 Kata。这样两个人各有分工，又不会同时出现。要不要这样做由 Bruce 定。
- **形象**：同一个超立方体，靠颜色区分。Ana 偏暖，Kata 是现在的蓝色，和字标上两个点的颜色一致。
- **名字**：两个都是默认值，用户可以改名（见 3.2）。
- **声音**：【事实】2026-11-23 另一个 session 已经做了"开口说话"和"快说"（[voice.md](voice.md)，V1–V5，没提交）：声音在主节点上合成，默认用 Mac 自带的系统声音，也可以选本机模型 Qwen3-TTS；设置里有"语音"一页，能选声音、试听、调语速；同一台设备一次只有一个声音。所以【建议】Ana 和 Kata 直接落在这一页上：**选角色 = 选一组声音**（Ana 对应一个女声，Kata 对应一个男声，系统声音和 Qwen3-TTS 各配一对），角色名和形象颜色跟着切换。全双工的实时通话（`docs/research/full-duplex-voice.md`）仍然没做，不在本文范围。
- 【风险】Kata 在对话式 AI 里撞名：印尼有家公司叫 Kata.ai。它只是一个可以改的角色名，不是品牌，风险低；但对外宣传以 Isocline 为主，不要拿 Kata 做卖点。

## 5. 分几步做

| 步 | 内容 | 验收 |
|---|---|---|
| R1 品牌 | App 名、bundle id、打包、菜单、通知、文案里指产品的地方、字标（选定的点） | 打出来的 App 叫 Isocline；界面上没有"Alfred"作为产品名出现 |
| R2 助手名 | 文案里的 `{assistant}` 变量、设置项（声音角色 + 名字，放在 voice.md 的"语音"页里）、引擎提示词、Ana/Kata 两种颜色和两组声音 | 改名后界面和对话里都用新名字；中英文都看过；不同宽度下不叠字 |
| R3 迁移 | 数据目录、Desktop 文件、launchd、日志、钥匙串、cookie、localStorage | 带旧数据的临时世界升级后：对话、待办、Google 登录、模型登录、配对手机都在 |
| R4 内部 | `@isocline/*`、环境变量（兼容旧名）、日历 id 前缀（两个都认）、分支前缀、CLI | `npm test` 和类型检查全过 |
| R5 对外 | README、官网、GitHub 改名、域名、商标申请 | 官网和仓库都是 Isocline |

R1 和 R2 可以一起做；R3 必须在**公开发布之前**做完；R4 可以和 R3 一起做，也可以晚一点。

## 6. 这是不是最好的办法

### 名字本身
在查过的大约 100 个名字里，Isocline 是"商标干净 + 和形象连得上 + 有可用域名（isocline.dev、getisocline.com）"三项都过关的少数几个之一。
- 它的短板：抽象、要解释一句才懂；有一个快上架的同名 iPhone 应用（isocline.app），以后上 App Store 时可能要加后缀。
- 产品名和角色名分开以后，"抽象、冷"由 Ana 和 Kata 的温度来补，短板就小了。
- 其他候选的对比见 2026-11-23 的对话：Phrontis 域名更好但和形象无关；Katael 有自己的 .com 但是造词；Calabi 最酷但有一家 AI 公司占着 .com。

### 三种改法
| 改法 | 好处 | 代价 |
|---|---|---|
| A. 只改品牌（R1、R2），内部和数据都保留 alfred | 最快，几乎没风险 | 用户还是会在 Finder（数据目录）、登录项和活动监视器（launchd 标签）、钥匙串里看到 "Alfred"；开源用户读代码满眼 alfred，像没改完 |
| **B. 全改，带迁移（R1–R4）** | 干净，一次到位；以后不用再背这个包袱 | 迁移要认真写、认真测；一次性的工作量大约是两三天 |
| C. 不改，继续叫 Alfred | 零工作量 | 公开发布后随时可能收到律师函，那时候改代价更大 |

【建议】**B**，但分两段做：R1、R2 先做（马上就能看到新名字和两个角色）；R3、R4 在公开发布之前做完。发布之前用户只有 Bruce 一个人，迁移只需要在他的世界上成功一次。

### 改之前要做的事（和代码无关）
1. 注册 **isocline.dev** 和 **getisocline.com**（也可以加上 isocline.sh）。
2. 在美国提交 ISOCLINE 的商标申请（9 类和 42 类）。现在我们是第一个；isocline.app 那个 iPhone 应用随时可能去申请。
3. 补查欧盟和中国的商标（看在哪里发布）。

## 7. 要 Bruce 定的

1. 字标的点：两种颜色、同角度方块，还是两者组合（第 2 节的建议）。
2. Ana 和 Kata：只能选一个，还是按日常和开发自动切换。
3. 改法用 B（全改，分两段）还是 A（只改品牌）。
4. 什么时候改 GitHub 仓库名、什么时候换官网。

## 8. 做到哪了（2026-11-23）

**做了（R1–R4），没提交。** `npm test` 446 个通过，类型检查通过，`Isocline.app` 和 `Isocline-0.1.0-arm64.dmg` 已打包。

- **R1 品牌**：App 名、可执行文件和辅助进程都叫 Isocline，bundle id `io.github.<owner>.isocline`；菜单、托盘、通知、窗口、HTML 标题、manifest；中英文里指产品的约 40 条文案；README、THIRD-PARTY-NOTICES。字标 `packages/ui/src/Wordmark.tsx`：小写 isocline，两个 i 的点一暖（Ana）一蓝（Kata），按第 2 节的建议。
- **R2 助手名**：设置里多了 `character`（ana / kata，默认 ana）和 `assistantName`（空就用角色名）；设置 → 通用里两行：选 Ana · 女声 / Kata · 男声，改名字。中英文里助手说话、做事的 58 条文案改成 `{assistant}`，`dict.ts` 的 translate 自动填；主节点（推送、提议的文字）、网页、Mac App 都跟着设置走。引擎提示词是 "You are {名字}, the user's personal assistant in Isocline"。没指定声音时，Ana 用女声（婷婷 / Samantha），Kata 用男声（Eddy / Daniel）；换角色会放掉之前选的声音。**没做**：按日常 / 开发自动切换角色（Bruce 说先不做）；形象本身的颜色还没跟角色变。
- **R3 迁移**：数据目录、日志（`packages/server/src/rename.ts`，主节点启动和 Mac App 启动时各跑一次，开发世界不动）；launchd：新 App 先停掉并删除 `alfred.home-node`（`retireLegacyAgent`），再挪目录，再装 `isocline.home-node`；钥匙串（`core/src/legacy.ts` 的 `carryingOver`，只复制不删旧的）；配对手机的 cookie（旧名照认，认出来就换发新名）；解锁会话的 cookie（旧名照认）；浏览器里约 20 个 `alfred.*` 设置在 `scheme.js` 里一次性改成 `isocline.*`；`ALFRED_*` 环境变量照认（`adoptLegacyEnv`）。
- **R4 内部**：包名 `@isocline/*`、环境变量 `ISOCLINE_*`、新日程 id 前缀 `isocline…`（日历页两个前缀都认）、新分支前缀 `isocline/`、快照 ref `refs/isocline/snapshots/`、CLI `npm run isocline`、临时文件前缀。

**特意没改的**：数据库里的 `actor: "alfred"`、`by: "alfred"`、模型账户的 `source: "alfred"`（存下来的值或协议的值）；`mcp.json` 里每项的 `alfred` 键（用户的配置文件）；浏览器窗格的存储分区 `persist:alfred-browser`（改了里面的登录就丢了）；代码里的组件和样式名（如 `.alfred`、`data-alfred-anchor`、`dock-alfred`），用户看不到；文档和原型里的旧名（历史记录）。

**验证过的**：
- 临时世界端到端：先装一个假的旧 `alfred.home-node.<hash>`，再用**旧的**环境变量名打开打包好的 Isocline.app → 旧代理被停掉、plist 删了，新代理从包里跑起来，菜单叫 Isocline，输入框"问 Ana"。
- 网页：设置里选 Kata 后各处变成 Kata，改名 Alfred 后变成"问 Alfred"；启动画面的双色点；中英文和手机宽度。
- 新测试：钥匙串复制、环境变量、目录搬家、助手名进提示词、角色的默认声音、旧 cookie 的配对手机。

**测试时出过的问题**（已修）：第一次端到端测试时，钥匙串迁移还是"复制后删掉旧的"，测试 App 读模型凭证时把 Bruce 真钥匙串里的 `models` 从 Alfred 挪到了 Isocline，正在跑的旧主节点因此读不到。已经用项目自己的钥匙串代码把它复制回 Alfred（值没有显示或写到别处），并把迁移改成只复制、不删旧的。

**R5 开始了**：GitHub 仓库 2026-11-23 改名为 `bruceche-cmu-F25/Isocline`（旧地址 301 跳转），本地 origin 和 `package.json` 的 homepage 已跟上。官网、域名、商标申请还没做。

**没验证的**：Bruce 真实世界的迁移（第一次打开新 App 时会发生：停掉旧主节点、把 `~/Library/Application Support/Alfred` 挪成 `Isocline`，旧版本代码就打不开它了）；配对 iPhone 上的 cookie 换发；官网（R5）。
