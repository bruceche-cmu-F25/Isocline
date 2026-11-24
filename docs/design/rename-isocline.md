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

### 商标和域名复查（2026-11-23 晚）
查了 Cline（同名 AI 编程 agent）和 Isocline 本身的现状。

**Cline 的商标**
- Cline Bot Inc.（旧金山，开源编程 agent Cline 的公司）在美国申请了 CLINE，申请号 98795282，2024-10-10 提交，范围是可下载的软件开发工具，使用证明是 cline.bot。**现在注册了没有还没确认**：第三方站点只有 2024 年的状态，要到 [USPTO TSDR](https://tsdr.uspto.gov/#caseNumber=98795282&caseType=SERIAL_NO&searchType=statusSearch) 手动看。
- 另一个 CLINE 申请（98462357，申请人 Ping Chu）被 CELINE 异议，2025-06 缺席判负、已放弃。这件事和 Cline Bot 无关，只说明大品牌会对相近的名字提异议。
- Roo Cline 2025-01 改名 Roo Code，官方说的理由是品牌辨识，"因为商标"只有一条网友评论，没有证实。

**和 Isocline 冲突的风险：偏低，不是零。** Isocline 是现成的英文词（等斜线），读音和意思都和 Cline 不同，审查一般看整体印象。唯一的切入点是 "-cline" 后缀，加上我们也有编程 agent（开发模式），和 Cline 的商品范围重叠。对外别拿 Cline 作对比，也别用让人联想到 Cline 的写法。

**真正的问题是 Isocline 这个名字今年已经挤了**：
| 域名 | 现状 |
|---|---|
| isocline.com / .org | 2003 年注册；.com 跳到 isoclineventures.com（投资公司） |
| isocline.ai | 2026-06 注册，叫 Isocline 的技术趋势分析网站 |
| isocline.app | 叫 Isocline 的 iPhone / Apple Watch 私人追踪应用，"即将上架" |
| isocline.io | 2026-06 注册，叫 Isocline 的软件控股公司 |
| isocline.dev | whois 没查到、访问不通，**不能确定还空着**，去注册商那里看 |
| getisocline.com | 未注册，可买 |
| cline.bot / cline.ai / cline.com / cline.dev | Cline 官方 / 隐私保护的所有者 / 1995 年的老注册 / 停在 Afternic 上像是在卖 |

没查到现存的软件类 ISOCLINE 商标（只有失效的机床、高尔夫球杆），所以法律上仍然是"第一个申请的人"，但三家同名软件意味着：好域名没了，App Store 可能撞名，搜索结果被分走，而且它们里任何一家都可能先去申请商标。

### 换名候选（2026-11-23 晚）
Bruce 觉得 Isocline 不太顺口。查了约 30 个：tesser、lares、tomte、orrery、octa、quatern、tessel、plinth、ostler、fourfold、kata、tessa 等真实短词的 .com / .app / .dev / .ai **全被占**；造词里 Tesra 有同名工程软件公司（tesra.ai 也在用），Wenda 是食品公司且中文"问答"搜不出来。

最看好的 **Anakata**（Ana + Kata，第四维的两个方向）细查后**不推荐**：
- 英文维基的 "Anakata" 直接跳到海盗湾联合创始人 Gottfrid Svartholm（网名 anakata，因入侵服务器坐过牢；他写的 BitTorrent tracker 就叫 Hypercube）。搜这个名字第一屏就是他，开源和技术圈正是我们的用户。
- **anakata.io**（2026-10 注册）是一款叫 **"Ana & Kata"** 的双人四维解谜游戏。和我们的两个角色名、四维的意思都撞了。
- 域名：.com（2000 年）、.org、.ai、.io、.app 都被占，只剩 anakata.dev 和 getanakata.com；GitHub 用户名 anakata、X 账号 anakata 也被占。
- 没查到 ANAKATA 商标；用这个词当品牌的还有 Anakata Wind Power（风电叶片，不同行业）。

顺带：那款 "Ana & Kata" 游戏对我们角色名本身影响不大（角色是 App 里的称呼，不是产品名），但对外宣传时别把 "Ana & Kata" 当标题用。

**Tessera**：不行。已有同名个人 AI 助手 App（2026-08）、同名编程 agent 工作台、a16z 投的 Tessera Labs，Tessera, Inc.（现 Adeia，专利授权公司）有软件类商标，域名全占。

**第二轮（书、游戏、电影、神话里的意象，约 70 个）**。和超立方体 / 四维字面相关的好词过去两年都被 AI 公司用光了；电影、游戏角色名（Murph、Calcifer、Giskard、智子 Sophon）有版权方，域名也全占。只有卡尔维诺《看不见的城市》里的城市名还有空位：

| 名字 | 出处和意思 | 域名 | 同名 | 结论 |
|---|---|---|---|---|
| **Zirma** | 《看不见的城市》里"重复的城"：记忆靠重复，城市才在你心里存在。助手替你记住 | .app .dev .ai 空着；.com 在 BrandBucket 挂牌出售 | 没搜到同名软件或商标 | **首选**：两个音节、中性，故事和"替你记住"贴 |
| **Despina** | 同书：骆驼客看它是船，水手看它是骆驼，样子取决于你从哪来（像 Mac 和手机看同一个家）；也是莫扎特《女人心》里那个聪明、张罗一切的女仆；海王星的一颗卫星 | .app .dev 空着；getdespina.com 空着；.com 已注册没网站 | 没搜到；有个拼法相近的 DESPIA 在申请 42 类 | **次选**：三层意思都好，但名字偏女性，和男角色 Kata 有点别扭 |
| Eudoxia | 同书：地毯上藏着城市的真实形状 | .com 在用 | 知名开发者的 GitHub 用户名 eudoxia0 | 四个音节，不选 |
| Ekumen / Ersilia / Anarres / Hearthian | 勒古恩、卡尔维诺、Outer Wilds | — | 机器人公司 Ekumen；开源组织 Ersilia；anarres.com 在用；hearthian.com 待上线 | 不选 |

**第三轮（约 60 个：卡尔维诺其余城市、博尔赫斯、勒古恩、冯内古特、Hinton 给超立方体小方块起的拉丁名、建筑、航海、音乐、日本和中国的意象）**。真实短词（oriel、gnomon、binnacle、rubato、pronoia、zaira、xihe…）全占；卡尔维诺的城市名大多空着，但多是四五个音节的女名。细查的五个：

| 名字 | 出处和意思 | 域名 | 同名 | 结论 |
|---|---|---|---|---|
| **Tehanu** | 勒古恩《地海》第四部书名：一颗星的名字，也是那个被烧伤的女孩 Therru 的真名（她其实是龙的孩子）。被看轻的东西有真名、有力量 | .app .dev .ai 空着；.com 在 HugeDomains 出售 | 没搜到同名软件、商标；GitHub 只有个人小仓库 | **新增第三候选**：三个开音节（te-HA-nu），中文好念（特哈努）；书名一般不能注册商标 |
| Thekla | 卡尔维诺：永远在施工的城，图纸是星空（像一个永远没做完的开源项目） | .app .dev .ai 空着 | **thekla.com 是 Jonathan Blow 的游戏工作室 Thekla, Inc.**（《The Witness》） | 不选 |
| Moena | Hinton 超立方体模型里一个小方块的名字；也是意大利一个滑雪小镇 | .app .dev 空着 | moena.com 在用 | 不选 |
| Pirra | 卡尔维诺：你到达之前想象的城，一到就消失 | .app .dev 空着 | pirra.com 在用；GitHub 上有个 32 星的项目 | 不选 |
| Tralfa | 冯内古特《五号屠场》的 Tralfamadore 人，能同时看见所有时刻 | .com 出售 | 没有 | 截出来的半个词，读着怪，不选 |

到这一轮为止的排序：**Zirma > Tehanu > Despina**，三个都还没做正式商标检索。

Zirma 的读音：意大利原文 z 读 /dz/，原音 DZEER-ma；英语读者多读 ZUR-ma 或 ZEER-ma；中文"齐尔玛"。读法不唯一是个小缺点。

**第四轮（约 45 个：地海的岛和人、《柏林苍穹下》的天使、芬兰史诗、各地记忆和书写之神、黑泽明）**，没有新的首选：
- **Zima**（Bruce 问的）：不行。上海 IceWhale 2024 年在美国申请了 ZIMA、ZIMABOARD、ZIMA CUBE 等商标，产品 ZimaOS 是家用个人云 / NAS 系统，和我们"跑在家里那台机器上"的主节点正面相邻；App Store 已有 "Zima: Offline AI"、"ChatZima"；zima.ai 在用；还有 Coors 的 Zima 酒、俄语"冬天"。
- Dersu（黑泽明《德尔苏·乌扎拉》里的森林向导）：意思很好，但这部片 1975 年在中国被批判为反华片，dersu.com 也在用。不选。
- Selidor（地海最西的岛，龙住的地方）：.app .dev .ai 空着，没有同名软件；但 selidor.com 跳到一家咨询公司，三个音节、意思要讲很多。备用。
- Damiel（《柏林苍穹下》里倾听人心的天使）：damiel.com 在用。Kemay、Ensmer、Iffish：意思太弱。
- Seshat、Sampo、Elpis、Awen、Versor、Querencia、Palomar 等：域名全占。

**Zima 对 Zirma 的影响（2026-11-24 复查，以 Trademarkia 为准）**：之前说两件都"还在审"是错的，IceWhale 的 ZIMA 现在是：

| 申请号 | 状态 | 类别 | 范围 |
|---|---|---|---|
| 98670562 | 已注册（7697495，2025-02） | 9 | 微型电脑、带操作系统的硬件、NAS、服务器、存储设备 |
| 98670579 | 已注册（8027279，2025-11） | 35 | 计算机化数据库管理、文件管理、网店 |
| 99947384 | 2026-07 新申请，**正在公告期** | 42 | 个人云存储、NAS 管理、**家用服务器操作系统**的 SaaS，智能家居平台 PaaS |
| 90512269 ZIMABOARD | 在审，长期中止 | 9 | 含"可下载的计算机操作软件" |

另外 ZIMA、ZIMA CUBE、ZIMA BLADE、ZIMASPACE、CASAOS 也都是它的。Trademarkia 上没有任何拼作 ZIRMA 的商标。

两点相反的信号：
- **对我们有利**：美国只看"名字像不像 + 东西近不近"。完全同名的 ZIMA 已经有好几家同时注册：XIMA Inc. 的游戏软件（9 类）、Coors 的酒、KP Medical 的牙套清洗机、CoClean 的泳池清洁器。可见商品不同，连同名都能共存，何况 ZIRMA 还差一个字母。
- **对我们不利**：99947384 写的正是"家用服务器操作系统、个人云"，而我们就是跑在家里一台机器上、管个人数据的软件。这一件还在公告期，2026 年底前后就会注册，以后审查员很可能拿它来比。

结论：**中等风险，不是死路**。如果定位写成"个人 AI 助理软件"（9、42 类），不提家用服务器和存储，有机会过；但 IceWhale 很重视 ZIMA 这个品牌，提异议的可能性不低。在中国它多半也注册了。真想用 Zirma，花几百美元请律师做一次检索和意见。

**第五轮（约 50 个：宫泽贤治、《永远讲不完的故事》、北欧命运女神、西比尔、Hinton 小方块、蓬莱）**：大多被占。剩下能看的只有 Ihatove（宫泽贤治的理想乡伊哈托布，.app .dev .ai 空着，但四个音节，岩手当地很多店用这个名字）和 Penglai（蓬莱，.app .dev 空着，但也是山东一个市名），都不如前面几个，没有细查。

**第六轮（约 60 个：卡尔维诺其余城市、地海、《黑暗的左手》、家宅守护神、"助手"类古词）**：

| 名字 | 来历 | 域名 | 判断 |
|---|---|---|---|
| Ogion | 地海里格得的老师"沉默者"，话少、懂天气、守着弓忒山 | .app .dev 空；.com 是 GoDaddy 停放页（2019） | 意思最贴：安静、在身边、懂你的世界。没找到同名软件和美国商标 |
| Estraven | 《黑暗的左手》里那个默默帮主角、最后为他而死的朋友 | .app .dev .ai 空；.com 1999 年起被人持有，打不开 | 意思是"可信的同伴"，但三个音节，拼写不直观 |
| Kalessin | 地海最老的龙 | .app .dev .ai 空；.com 2026-04 刚被注册、停放 | 有力但冷，不像个管家；.com 刚被人抢注，可能有人在用 |
| Valdrada | 卡尔维诺的镜子城（湖面映出整座城） | .app .dev 空 | 出局：GitHub 上 mkturkcan/valdrada 是纽约"数字孪生"项目（279 星，本月还在更新），意象撞车 |
| 其余 | Aglaura、Osskil、Lebannen（四个后缀全空，但不好读或意思不对）；Zobeide、Zemrude、Sophronia 等城市名偏长偏女性；Famulus、Lares、Tomte、Gnomon 等域名已被占 | | 出局 |

GitHub 上 Ogion 只有 18 个小仓库，App Store 没有同名应用，网上也搜不到同名软件或商标。

### Zirma 全面评估（2026-11-24）

**名字本身**
- 来自卡尔维诺《看不见的城市》"城市与符号 3"。去过 Zirma 的人都记得几样东西，因为这座城市"不断重复，好让某些东西留在脑子里"。这和一个替你记事的个人助理很贴。
- 两个音节、五个字母，拼写和读音大体一致。英语多读 ZUR-ma 或 ZEER-ma，意大利语原读 DZEER-ma，中文可以叫"齐尔玛"。读音不唯一，但哪种都不难听。
- 没找到它在土耳其语、阿拉伯语、库尔德语、印地语里有意思（Wiktionary 无词条）。俄语 зима 意为"冬天"，读音近但无害。
- 搜索结果主要是卡尔维诺，没有大公司占着这个词，做起来以后容易排到第一。

**域名和账号**

| 项 | 情况 |
|---|---|
| zirma.app / .dev / .ai / .co / .so | 没有 DNS，看起来空着 |
| getzirma.com / usezirma.com / zirmaapp.com | 空着 |
| zirma.com | BrandBucket 出售，一口价 5,095 美元，或每月 489 美元租用 |
| zirma.net / .org / .de | 有人持有 |
| GitHub `zirma` | 被一位法国开发者占用（大多是 fork），要用 `zirma-app` 之类的组织名 |
| npm / PyPI / crates | `zirma` 都空着 |

**已有同名**
- Zirma Coop：一家做可持续旅游和数字化的合作社（国家不详）。
- 两个独立游戏：2013 年的网页策略游戏，以及 itch.io 上一个卡尔维诺题材的原型。
- App Store 没有同名应用。都不在软件助理领域，影响小。

**商标**
- 美国：没有任何 ZIRMA 或 ZIRMO 商标。SIRMA 只有一件软件类（9/42 类），2017 年已放弃。
- 主要风险仍是 IceWhale 的 ZIMA：美国 9 类、35 类已注册；42 类（个人云、NAS、家用服务器系统）在公告期。2026 年 7 月它还在**英国**申请了 ZIMA（9、42 类）和 ZimaOS（42 类）。说明它在往海外铺，欧盟和中国多半也有，但我没能查到（EUIPO、WIPO、中国商标网都打不开）。
- 有利的一面：完全同名的 ZIMA 在美国还被游戏软件、酒、医疗清洗设备等多家同时注册，说明只要商品不同就能共存。
- 结论：**中等风险**。登记时写"个人 AI 助理软件"，不写存储、NAS、家用服务器，有较大机会通过；最坏情况是 IceWhale 提异议，那时再改名。

**其他小毛病**
- 英语用户可能联想到 Coors 在 90 年代出的透明麦芽酒 Zima（已停产，常被当作笑话）。
- 名字本身不带"帮手"的意思，要靠介绍来讲故事。

**决定（2026-11-24，Bruce）：产品名定为 Zirma**，替代 Isocline。上线前仍要请律师查一次 ZIMA 的风险。

**域名（2026-11-24 查）**：
- zirma.dev：Bruce 已于 2026-11-24 在 Cloudflare 注册。
- zirma.app、zirma.ai、zirma.co、zirma.io、getzirma.com 仍未注册。
- zirma.com 在 BrandBucket 卖 5,095 美元。

先买的顺序：zirma.app（主站），getzirma.com（便宜的 .com，用于邮件和别人顺手输入 .com 的情况），然后可选 zirma.ai（防抢注，较贵）。

**字标（2026-11-24，Bruce 选定）**：Geist Serif 小写 zirma，i 上的点换成一个蓝色小方块，转 25°，像正在转动，呼应超立方体的旋转。其他候选（圆点、超立方体当点、空心点、回声、正方块、线框和实心小立方体）都留在 prototype/zirma.html 里对照。

**如果选 Zirma，要做的事**
1. 尽快注册 zirma.app、zirma.dev、zirma.ai 和 getzirma.com；zirma.com 等有收入再买。
2. 抢 GitHub 组织名、npm / PyPI 包名和社交账号。
3. 花几百美元请律师查一次美国、欧盟和中国（尤其 IceWhale 在中国的 ZIMA），再提交美国 9 和 42 类申请。
4. 宣传里不要用"家用服务器"或"个人云"当主打词，免得往 ZIMA 那边靠。

### 第九批：Bruce 提的科学 / 科幻词（2026-11-24）

AION、Monolith、Klein、Laplace、Hilbert、Euler、Planck、Aleph、Tessa：这九个的 .com .app .dev .ai **全部被占**，而且大多已经有 AI 公司在用：

| 名字 | 主要冲突 |
|---|---|
| Aion | Aion 银行 2026-11 刚发布"AI 财务助理"；aion.to 做 AI 代理平台；NCSoft 的网游《永恒之塔》AION 是大商标 |
| Monolith | Monolith AI（伦敦，已被 CoreWeave 收购）；一堆同名游戏 |
| Klein | Klein Tools、Calvin Klein 都是强商标；Dan Klein 的 AI 代理公司 |
| Laplace | Laplace Intelligence（2026 TechCrunch Disrupt 参赛的 AI 代理公司） |
| Hilbert | 冲突最少，但只是数学家姓氏，hilbert.app / .dev 也被占 |
| Euler | Euler AI（链上代理）、EULER 合作伙伴软件、Euler 3D 打印 AI |
| Planck | Planck AI 企业平台、Planck 保险 AI、Planck VPN |
| Aleph | Aleph Alpha（德国大模型公司）、aleph.im，还有很多宗教类应用 |
| Tessa | YC 投资的 Tessa（AI 同事）、Tactic 的 Tessa 办公助理，正好同类 |

九个都出局。科学家名字和短的科幻词早就被 AI 公司分完了。

### 最后对比（2026-11-24）

| | Isocline | Zirma | Tehanu | Ogion |
|---|---|---|---|---|
| 好听 / 好记 | 中：三个音节，"不太顺口" | **好**：两个音节，有力 | 好：柔和 | 中：读法不定 |
| 意思 | 等斜线 / 等斜旋转，要解释 | 一座让人记住东西的城市 | 地海里的"燃烧的孩子"，温暖 | 安静的老师，最贴"助手" |
| 和图形 / 故事 | 和超立方体、Ana/Kata 连得最紧 | 和"记忆"连得上 | 弱 | 弱 |
| 域名 | .com 被占；.dev 未确认 | .app .dev .ai 空，.com 5,095 美元 | .app .dev .ai 空，.com 待售 | .app .dev 空 |
| 商标风险 | **低**：无有效 ISOCLINE 商标 | **中**：IceWhale 的 ZIMA | 低（未细查） | 低（未细查） |
| 同名产品 | **三个** 2026 年的 Isocline 软件项目 | 没有同类产品 | 没有 | 没有 |

推荐 **Zirma**：最好听，而且没有同名产品，只剩一个能花钱查清的商标问题。如果律师说 ZIMA 风险太大，退回 **Isocline**：商标最干净，故事最完整，但要和三个同名项目抢搜索结果。

**Mentor / Mentro（2026-11-24）**：Mentor 四个后缀全被占，而且 App Store 上已经有一串"Mentor AI"教练类应用，这个词太普通，没法注册成商标。Mentro 的 .com .app .dev 都被占，只剩 .ai，读起来也像 Metro。两个都出局。

**第七轮（约 120 个：导师和仆从类人物、凯尔特神话、地海和《一无所有》其余人名）**：Telemachus、Nestor、Sancho、Passepartout、Jeeves、Merlin、Taliesin 等域名都被占；Hestan 是厨具品牌；Cadfael、Glaukopis 不好读。只多了一个能看的：

- **Takver**：《一无所有》里主人公 Shevek 的伴侣，一个在苦日子里一直陪着他、很踏实的人。两个音节，读作 TAK-ver。.app .dev .ai 都空着，.com 从 1999 年起有人持有。GitHub 上只有两个小仓库，App Store 没有同名应用，也没搜到同名公司或商标。缺点是知道的人少，字面上没有温度。

**Bruce 提的几个（2026-11-24）**：Retro、Gwen、Case、Charles、Axiom 的 .com .app .dev .ai 全被占。
- Retro、Case、Charles 都是常用词或人名，在软件类里几乎没法注册商标；Charles 还撞上 Mac 上很有名的抓包工具 Charles Proxy。
- Gwen 已有一个"Gwen AI Chatbot"应用，而且和阿里的 Qwen 只差一个字母、同一个领域。
- Axiom 在 AI 软件里有一串在审商标（Axiomatic AI、Oteemo Axiom、Axiom Neural Works 等），还有 Axiom 交易应用。
- 五个都出局。

**Alfred 能不能用**：作为产品名不能。
- ALFRED 是 Running with Crayons 的注册商标，它做的就是 Mac 上著名的效率工具 Alfred（alfredapp.com）。我们也是 Mac 应用，而且同样是"帮你做事"的软件，这是最直接的冲突。
- 实际上也装不了：两个都叫 Alfred.app，会在"应用程序"文件夹里互相覆盖。
- App Store 上还有 Alfred Camera、Hello Alfred（上门家政）、Alfred Home 等。
- 能做的是保留现在的方案：产品换名，助手默认叫什么由用户自己设，Bruce 自己的可以叫 Alfred（个人使用不涉及商标）。
- 改一个字母的变体（Elfred、Aelfred、Alfwin，.app .dev .ai 都空着）反而更糟：和 Zirma 对 Zima 是同一种问题，而且对手更有名。

**第八轮（约 80 个：科幻机器人、宫崎骏、《攻壳机动队》、Portal）**：TARS、KIPP、Gerty、Baymax、Wheatley 等域名都被占。剩下空着的 Fuchikoma、Yubaba、Kushana、P-body 都是别人的角色商标，不能用，所以这一轮没有收获。

现在的排序：**Tehanu > Ogion > Takver > Despina > Zirma（中等风险）**。

顺带发现：游戏《Fez》（2012）里的向导 Dot 就是一个会说话的超立方体。形象不用改（造型和动作都不同），但对外说"会说话的超立方体"时知道有这个先例。

### 三种改法
| 改法 | 好处 | 代价 |
|---|---|---|
| A. 只改品牌（R1、R2），内部和数据都保留 alfred | 最快，几乎没风险 | 用户还是会在 Finder（数据目录）、登录项和活动监视器（launchd 标签）、钥匙串里看到 "Alfred"；开源用户读代码满眼 alfred，像没改完 |
| **B. 全改，带迁移（R1–R4）** | 干净，一次到位；以后不用再背这个包袱 | 迁移要认真写、认真测；一次性的工作量大约是两三天 |
| C. 不改，继续叫 Alfred | 零工作量 | 公开发布后随时可能收到律师函，那时候改代价更大 |

【建议】**B**，但分两段做：R1、R2 先做（马上就能看到新名字和两个角色）；R3、R4 在公开发布之前做完。发布之前用户只有 Bruce 一个人，迁移只需要在他的世界上成功一次。

### 改之前要做的事（和代码无关）
1. 注册 **isocline.dev** 和 **getisocline.com**（也可以加上 isocline.sh）。isocline.dev 先确认还能买（见上面的复查）。
2. 在美国提交 ISOCLINE 的商标申请（9 类和 42 类）。现在我们是第一个；isocline.app、isocline.ai、isocline.io 三家同名软件随时可能去申请，越早越好。
3. 补查欧盟和中国的商标（看在哪里发布）。
4. 到 TSDR 看一眼 CLINE 98795282 的现状；正式发布前花点钱请律师做一次检索。

## 7. 要 Bruce 定的

1. 字标的点：两种颜色、同角度方块，还是两者组合（第 2 节的建议）。
2. Ana 和 Kata：只能选一个，还是按日常和开发自动切换。
3. 改法用 B（全改，分两段）还是 A（只改品牌）。
4. 什么时候改 GitHub 仓库名、什么时候换官网。
5. 知道了今年已有三家同名软件（第 6 节的复查）以后，还用不用 Isocline。

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
