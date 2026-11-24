# 打包 Isocline.app

> 状态：2026-11-23。打包脚本在 [scripts/package-mac.ts](../scripts/package-mac.ts)，第一版是 0.1.0。
> 这一篇讲怎么打、打出来的是什么、怎么安全地试，以及**正式对外发布前**还缺什么（第 7 节）。

## 1. 一句话

```bash
npm run package:mac
```

在这台 Mac 上从当前代码打出 `dist/mac/Isocline.app` 和 `dist/mac/Isocline-<版本>-<架构>.dmg`，大约一分钟。只要 App、不要磁盘映像：

```bash
npm run package:mac -- --no-dmg
```

`dist/` 在 `.gitignore` 里，打出来的东西不会进仓库。

## 2. 需要什么

- 一台 Mac（脚本只在 macOS 上跑），Node 24 以上。
- 先 `npm install` 过：脚本用的是 `node_modules/electron/dist/Electron.app`，不另外下载任何东西，所以离线也能打。
- 用到的都是 macOS 自带的命令：`ditto`、`PlistBuddy`、`iconutil`、`codesign`、`hdiutil`。
- 打出来的架构跟这台 Mac 一样（现在是 arm64，即 Apple 芯片）。要给 Intel Mac 用，得在 Intel 机器上打，或者以后做通用包（第 7 节）。

## 3. 脚本做了什么

不用 electron-builder 之类的打包工具，八步都是脚本自己做的，每一步在终端里打一行 `▸`：

1. **构建界面**：`npm run build:ui`，生成 `packages/ui/dist`。
2. **复制 Electron**：把 `node_modules` 里的 `Electron.app` 复制成 `Isocline.app`，删掉 Electron 自带的示例程序（`default_app.asar`）和图标。
3. **改名**：可执行文件改成 `Isocline`，四个辅助进程改成 `Isocline Helper (…)`。Electron 是按主程序的名字去找辅助进程的，所以要一起改。然后改 `Info.plist`：
   - 名字、bundle id、版本号、图标；
   - bundle id 从 `package.json` 的 homepage 推出来：`io.github.<GitHub 用户名>.isocline`，别人 fork 之后自然是他自己的；
   - 麦克风的用途说明（只在你按住形象、按快捷键或点麦克风时听）；
   - 去掉用不到的摄像头、蓝牙权限说明。
4. **画图标**：用形象的代码（`packages/desktop/src/icon-art.ts`）画出 16 到 1024 像素的各个尺寸，再用 `iconutil` 合成 `Isocline.icns`。
5. **复制源码**：各个包的 `package.json` 和 `src`，加上 `packages/ui/dist` 和 `packages/server/voice`（语音的 Python 脚本），以及 LICENSE 和第三方声明。测试不带。
6. **复制依赖**：用 `npm ls --omit=dev` 列出运行时真正要的包（大约 138 个），只复制这些。Electron、Vite、TypeScript、Playwright 这些开发工具都不带。`@isocline/*` 这些工作区包在包里仍然是指向包内副本的链接。
7. **签名**：`codesign --sign -`，本机临时签名（不是开发者证书），然后验证一遍。
8. **磁盘映像**：一个 DMG，里面是 `Isocline.app` 和一个指向「应用程序」的快捷方式，拖过去就装好。

**为什么不打成 asar 包：**主节点由 launchd 从包里的 `.ts` 文件直接启动，node-pty（终端）和 sharp（图片）还要从真实文件里加载原生代码，所以全部用普通文件。代价是 App 大一些（约 475MB，DMG 约 230MB），其中 Electron 本身占 250MB 左右。

## 4. 打出来的 App 怎么运行

- **App 本身**是一个 Electron 程序（[packages/desktop/src/main.ts](../packages/desktop/src/main.ts)）：窗口、形象、菜单栏、快捷键。
- **主节点**是同一个可执行文件，以 Node 的方式运行（`ELECTRON_RUN_AS_NODE=1`），跑包里的 `packages/server/src/cli.ts`。它装成 launchd 的用户代理 `isocline.home-node`，开机自动起来，关掉 App 也继续工作。
  - 代理文件：`~/Library/LaunchAgents/isocline.home-node.plist`
  - 日志：`~/Library/Logs/Isocline/isocline.home-node.log`
  - 数据：`~/Library/Application Support/Isocline/`
- **装在哪很重要**：launchd 会记住 App 当时所在的路径。如果直接在 DMG 里或「下载」文件夹里打开，下次开机那个路径可能已经不在了，所以 App 会先提示「移到应用程序文件夹」。
- **从 Alfred 升级**：第一次打开时，App 会依次停掉并删除旧的 `alfred.home-node`、把 `Application Support/Alfred` 和日志目录改名为 `Isocline`，再启动新的主节点。钥匙串里的凭证第一次被读到时会复制一份到新名下，旧的保留。详见 [design/rename-isocline.md](design/rename-isocline.md) 第 3.3 节。

## 5. 安全地试一个新包（不碰真实的数据）

**不要直接双击打开来测试。**打包版不带任何环境变量启动时，会接管你真实的主节点和数据目录（第 4 节）。测试要给它一个临时世界和另一个端口：

```bash
D=$(mktemp -d)
ISOCLINE_DATA_DIR=$D ISOCLINE_PORT=7487 dist/mac/Isocline.app/Contents/MacOS/Isocline
```

- 设了 `ISOCLINE_DATA_DIR` 就是"开发世界"：数据放在 `$D`，launchd 代理的名字带上这个目录的哈希（`isocline.home-node.<8 位>`），不会替换掉真实的代理；也不会去挪 `Application Support` 里的目录，也不会弹出移动提示。
- **钥匙串是共用的**：开发世界和真实世界读写的是同一个登录钥匙串。所以测试 App 读到的模型和 Google 凭证就是你真实的那几个。要完全隔离，再加上 `ISOCLINE_SECRETS=file`，凭证就存进 `$D/secrets.json`。2026-11-23 的一次测试就是因为没加这一条，把真实钥匙串里的模型凭证挪了位置（已经修好，迁移现在只复制、不删旧的）。
- **测完清理**（`<hash>` 是代理名后面那 8 位）：

  ```bash
  launchctl bootout gui/$(id -u)/isocline.home-node.<hash>
  rm ~/Library/LaunchAgents/isocline.home-node.<hash>.plist
  rm -rf "$D"
  ```

- 想用脚本自动点一遍：`packages/desktop/test/desktop.e2e.ts` 是从源码跑的端到端测试；用 Playwright 的 `_electron.launch({ executablePath: "dist/mac/Isocline.app/Contents/MacOS/Isocline", env: {...} })` 也能直接驱动打包版。

## 6. 装到自己的 Mac 上

1. 先备份数据：把 `~/Library/Application Support/Alfred`（已经升级过的话是 `Isocline`）复制一份放到别处。
2. 打开 DMG，把 Isocline 拖进「应用程序」。
3. 第一次打开。在自己这台 Mac 上打出来的包可以直接打开；从别的地方下载的会被 macOS 拦下，要右键 →「打开」，或者到 系统设置 → 隐私与安全性 → 「仍要打开」。
4. 第一次打开会接管主节点（第 4 节）。在菜单栏里确认「主节点：在线」。

**退回旧版**：退出 App，在菜单栏里停掉主节点，把数据目录改回原来的名字（或者用第 1 步的备份恢复），再从源码 `npm run desktop`。

**彻底卸载**：

```bash
launchctl bootout gui/$(id -u)/isocline.home-node
rm ~/Library/LaunchAgents/isocline.home-node.plist
rm -rf /Applications/Isocline.app
```

数据目录 `~/Library/Application Support/Isocline` 和钥匙串里名为 "Isocline" 的条目要不要删，自己决定。

## 7. 正式对外发布前还缺什么

现在的包只适合自己用和给少数人试。公开发布之前：

| 事 | 为什么 | 大致做法 |
|---|---|---|
| 开发者签名和公证 | 现在是临时签名，别人打开会被 macOS 拦下 | 加入 Apple Developer Program（每年 99 美元），用 Developer ID Application 证书签名（`codesign --options runtime`，并给 Electron 配上它需要的 entitlements），再用 `xcrun notarytool submit` 提交公证、`xcrun stapler staple` 把公证结果钉进包里。打包脚本第 7 步要换成这一套，证书名从环境变量读，不写死 |
| 自动更新 | 现在装了 0.1.0 以后收不到修复 | 选一种更新方式（GitHub Releases 加 Electron 的自动更新，或者 Sparkle），需要先有正式签名 |
| 版本号 | 现在取 `package.json` 的 `version` | 每次发布前改版本号，打 git tag，在 GitHub Releases 上附 DMG |
| Intel / 通用包 | 现在只有 arm64 | 在 Intel 机器上打，或者用 `lipo` 合成通用包；node-pty 和 sharp 的原生部分也要有两种架构 |
| libvips 许可证 | sharp 带的 libvips 是 LGPL，包里要附上它的许可证（THIRD-PARTY-NOTICES 里写了） | 在第 6 步后面把许可证文本复制进包 |
| 语音转写 | 依赖本机装了 `uv`，第一次用会下载模型 | 在设置里讲清楚，或者以后把 Python 环境一起打进包 |
| Google 登录 | 现在每个人要自己建 Google 客户端（约 10 分钟） | 决定要不要内置项目自己的客户端；内置的话要先通过 Google 的应用验证 |
| 商标和域名 | 名字还没受保护 | 注册 isocline.dev、getisocline.com，提交美国商标申请（见 design/rename-isocline.md 第 6 节） |

## 8. 出问题时

- **"主节点没有启动"**：看 `~/Library/Logs/Isocline/isocline.home-node.log`。常见原因是端口 7480 被占了（比如源码版的主节点还在跑），或者另一个主节点正在用同一个数据目录（日志里会写 `Another Isocline home node is running`）。
- **看代理状态**：`launchctl print gui/$(id -u)/isocline.home-node`。
- **App 闪退或打不开**：在终端里直接运行 `/Applications/Isocline.app/Contents/MacOS/Isocline`，错误会打在终端里。
- **验签名**：`codesign --verify --deep --strict --verbose=2 /Applications/Isocline.app`。
