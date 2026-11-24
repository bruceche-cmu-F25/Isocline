# 从 Isocline 改名为 Zirma

v0.1，2026-11-24。Bruce 已定：产品名 Zirma，存下来的数据也一起改名并迁移，等同一个 checkout 里的其他会话停下、提交后再改代码。名字的来由、商标和域名检查见 [rename-isocline.md](rename-isocline.md) §6。

## 1. 已经定了的

- **产品名**：Zirma，读作 ZEER-ma（/ˈzɪər.mə/），中文读音"兹尔玛"，不另起中文名。
- **字标**：Geist Serif 小写 `zirma`，i 上的点是一个转 25° 的蓝色小方块（`prototype/zirma.html`）。正文里写 Zirma，句首大写。
- **不变的**：形象（超立方体）、两个声音 Ana 和 Kata；助手的名字仍是用户数据，Bruce 自己的仍可以叫 Alfred。
- **域名**：zirma.dev 已注册（Bruce，Cloudflare）。主站建议放 zirma.app（还没买）；没买之前 zirma.dev 先当主站。
- **商标**：上线前请律师查一次 IceWhale 的 ZIMA（rename-isocline.md §6）。

## 2. 和上次改名的关系

上次（Alfred → Isocline，提交 `c40094c`）已经留下一套迁移办法：`packages/server/src/rename.ts` 搬目录，`packages/core/src/legacy.ts` 读旧环境变量和旧钥匙串，`home-node.ts` 退掉旧 launchd 代理，`http.ts` 认旧 cookie。这次不另起一套，而是把它们改成**认一串旧名字**：Isocline 和 Alfred，从新到旧。只装过 Alfred 的机器直接迁到 Zirma，不用先经过 Isocline。

## 3. 改什么

### 3.1 品牌层（直接改）

界面文案（`i18n/en.ts`、`zh.ts`）、README、文档、`Zirma.app` 的名字和图标文字、Mac 菜单、通知标题、推送的 subject、网页标题、`prototype/` 里的说明。
`IsoclinePanel.tsx` 这类以产品名命名的文件和组件，一起改名。

### 3.2 存下来的数据（迁移，旧名字继续认）

| 东西 | 现在 | 改成 | 怎么迁 |
|---|---|---|---|
| 数据目录 | `~/Library/Application Support/Isocline`（开发：`Isocline Dev`） | `…/Zirma`（`Zirma Dev`） | 启动时：新目录不存在、旧目录存在，就整个移过去；旧名按 Isocline、Alfred 的顺序找 |
| 日志 | `~/Library/Logs/Isocline` | `…/Zirma` | 同上 |
| Linux 数据目录 | `isocline`、`isocline-dev` | `zirma`、`zirma-dev` | 同上 |
| 钥匙串服务 | `Isocline`（开发：`Isocline Dev`） | `Zirma`（`Zirma Dev`） | 读时先新后旧（Isocline，再 Alfred），找到就复制到新名下；旧的一份留着，删除时一起删 |
| launchd 代理 | `isocline.home-node`（`.dev`） | `zirma.home-node`（`.dev`） | 新 App 启动时退掉 `isocline.*` 和 `alfred.*` 两个旧代理，再装新的 |
| 配对手机的 cookie | `isocline_device`、`__Host-isocline_unlock` | `zirma_device`、`__Host-zirma_unlock` | 三个名字都认；认出旧的就换发新的 |
| 浏览器本地设置 | 约 30 个 `isocline.*` / `isocline:*` 键 | `zirma.*` / `zirma:*` | 界面加载时一次性复制（新键已有就不动） |
| Mac App 的 bundle id | `…isocline` | `…zirma` | 新 id 等于一个新 App：装完后把旧的 `Isocline.app` 从"应用程序"里移走（`install:mac` 负责） |
| 环境变量 | `ISOCLINE_*`（21 个） | `ZIRMA_*` | `ISOCLINE_X` 和 `ALFRED_X` 在 `ZIRMA_X` 没设时照用 |

### 3.3 内部标识

| 东西 | 做法 |
|---|---|
| 包名 `@isocline/*`（11 个，没发布） | 改成 `@zirma/*`，纯机械替换 |
| CLI `isocline` | 改成 `zirma` |
| 日历里建的日程 id 前缀 | 新建的用 `zirma…`；`isocline…`、`alfred…` 继续认 |
| 开发会话分支前缀 | 新的用 `zirma/`，旧分支不动 |
| 启动命令 | npm 脚本 `trial`、`dev:ui`、`prototype` 不带产品名，不用改；各工具自己的本地配置（不进仓库）自己改 |
| 事件里的 `actor: "alfred"`、偏好 `by: "alfred"`、`read_in_alfred` 列 | **不改**。它们是存下来的值，界面显示时本来就换成助手名 |

### 3.4 不改的历史

`rename-isocline.md`、`prototype/isocline.html` 留作记录，标题下加一行"已被 Zirma 取代"。提交历史不动。

## 4. 怎么做

1. 等同一个 checkout 里正在跑的会话停下、各自提交（AGENTS.md：不能动别人没提交的改动）。
2. 先改迁移代码并写测试：旧名字列表、目录搬迁、钥匙串、cookie、localStorage、launchd、环境变量。用一个临时世界从 Isocline 迁到 Zirma，再从 Alfred 迁到 Zirma，各走一遍。
3. 再做机械替换：包名、标识、文案、文件名。
4. `npm install`（工作区的包名变了），然后 `npm test`、`npm run typecheck`。
5. 界面在无头 Chrome 里看一遍：中文和英文、窄屏、深色。
6. 单独一个提交，不夹带别的改动。
7. Bruce 自己的生产环境最后迁：`npm run install:mac` 装上 Zirma.app，确认登录、手机配对、数据都在，再删旧的 Isocline.app。

## 5. 风险

- **生产数据**：搬目录是同盘重命名，瞬间完成，但不可逆：迁完后旧版 Isocline.app 打不开新目录。所以第 7 步之前不碰真实世界，钥匙串的旧条目也保留。
- **手机**：cookie 名变了，靠"三个名字都认"不掉线；如果出问题，最坏是重新配对一次。
- **别的会话**：改名后它们手里的文件路径和 import 会失效，所以必须等它们停。
