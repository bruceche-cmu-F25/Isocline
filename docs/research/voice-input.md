# 语音输入：怎么做最合适（调研）

> 状态：调研 v0.1（2026-11-18）。只读调查，**没有实测任何识别模型**；准确率数字多数是厂商或第三方自报。还没有据此改代码。
> 起因：Bruce 对待办的设想——不用手打，跟 Alfred 说一声就建好；Alfred 自己筛出来的事放进待办；日历上的日程同步过来（后两条先不做，记在第 8 节）。第一条要求：**凡是要跟 Alfred 交互的地方都能说话**，包括日常对话、开发会话、手机。
> 承接：[full-duplex-voice.md](full-duplex-voice.md)（实时语音对话，另一件事，见第 1 节）、[remote-access.md](remote-access.md)（手机走 Tailscale Serve 的 PWA）、[../design/dev-mode.md](../design/dev-mode.md)（开发会话、权限模式）。
> 标记：**【事实】** 读代码、文档核实过；**【建议】** 本文的提案；**【待定】** 见第 7 节。

## 实现状态（2026-11-19）

已做第一版「听写」：

- **麦克风按钮放在 6 处跟 Alfred 说话的地方**：Alfred 面板的输入框（日常对话，手机也是它）、开发页新会话的输入框、Alfred 提问时的「自己写回答」、收件箱里「改一下」提议、自动化的「要做什么」、⌘K 面板。
- 点一下开始，再点一下结束，Esc 丢掉；说完的文字插进输入框，看过再发，不会自动发出去。录音中按钮变红，显示时长，按钮外圈随音量变化。
- **识别在主节点上做**：`POST /api/voice/transcribe`（16kHz 单声道 WAV）。开始录音时前端顺手调一次 `POST /api/voice/warm`，模型一边录一边加载；闲置 10 分钟卸载。模型是 Qwen3-ASR 0.6B（第 6.1 节），通过 `uv` 跑 `packages/server/voice/transcribe.py`。配对过的手机也能用。
- 代码：`packages/server/src/voice.ts`、`packages/ui/src/voice/`；测试 `packages/server/test/voice.test.ts`。

还没做：识别后的整理、打包时带上 Python 和模型。快说（⌥⇧Space、按住形象、手机按住 Alfred）、常用词（词表）、形象的 `listen` 状态和 Alfred 开口，2026-11-23 按 [../design/voice.md](../design/voice.md) 做了。

## 0. 结论

1. **先做「听写」，不做「实时对话」。** 按住（或点一下）说话，松开后整段转成文字。这覆盖了「跟 Alfred 说一声就建待办」，因为建待办是 agent 已经会做的事，语音只是换了一种输入。全双工实时对话照 full-duplex-voice.md 以后做，到时候复用这里的麦克风、形象状态和权限。
2. **识别放在主节点（Mac）上做，不放在各个前端。** Mac、手机、以后别的设备都只负责录音，把音频发给主节点。这样手机不用装模型，云端 key 不出 Mac，各设备识别质量一样，跟现有「主节点持有一切」的结构一致。
3. **识别引擎做成可替换的。** 首选本机模型（开源、不花钱、隐私好）；云端服务作为选项，用户自己填 key。**第一轮实测（第 6.1 节）：本机默认用 Qwen3-ASR 0.6B 加一份短词表**。真人语音上它和 1.7B 一样准，计算量和内存都只有 1.7B 的 2/5；Whisper 会幻觉，出局。云端和 Apple 的还没测，最后还要用 Bruce 自己的录音确认。
4. **不需要单独的「语音命令」管线。** 转出的文字照常交给对话，agent 用已有的待办工具去建。给 agent 一句提示：「这段来自语音，可能听错；该问就问」。
5. **听写不能代替点按钮的授权。** 开发会话里的「允许这条命令」、对外不可逆的操作，第一版只能点，不能说。
6. **界面只改一处就覆盖三个地方。** 日常面板、开发页、手机用的是同一个对话组件 `Conversation.tsx`，在输入框底栏加一个麦克风键即可。外加一个 Mac 全局快捷键「对 Alfred 说」，App 不在前台也能说。

## 1. 三件不同的事

| | 听写（本文） | 快说（本文） | 实时对话（以后） |
|---|---|---|---|
| 怎么开始 | 输入框里的麦克风键 | Mac 全局快捷键；手机长按形象 | 进入通话 |
| 说完去哪 | 文字进输入框，看过再发 | 直接作为一条消息发给 Alfred | 语音模型当场回话，后台 agent 干活 |
| Alfred 怎么回 | 对话里的文字 | 形象跳出来，用说话卡片回（已有的 `useSpeech`） | 声音 |
| 识别谁来做 | 主节点的转写服务 | 同左 | 实时模型自带 |
| 典型用途 | 开发会话里口述需求、长段说明 | 「明天下午三点前把报税材料交了」 | 边走边聊、汇报 |

【建议】日常场景默认「快说」，开发场景默认「听写」（开发里一句话的分量重，先看一眼再发）。

## 2. 现在到哪了

【事实】

- **对话组件只有一份**：`packages/ui/src/Conversation.tsx` 的 `<form className="composer">`，一个 textarea 加底栏（模型、思考、权限、发送）。日常面板、开发页、手机都用它。
- **形象已有 `listen` 状态**：`packages/ui/src/entity/tesseract.js` 的十种状态里有 `listen`，还没有地方用它。
- **Alfred 说话已经有了**：`packages/ui/src/speech/useSpeech.ts`（形象跳起来、卡片里逐字出字）。快说的回复直接走这条路。
- **Mac 端是 Electron 45**，已经注册了一个全局快捷键 `Alt+Space`（打开主窗口，`packages/desktop/src/main.ts:24`）。没有麦克风权限的相关代码。
- **手机是 PWA**，经 Tailscale Serve 走 HTTPS，所以浏览器允许用麦克风（`getUserMedia` 只在安全来源下可用）。
- 代码里还没有任何录音、转写的代码。

## 3. 识别引擎

### 3.1 本机

| 候选 | 中文 / 中英混说 | 怎么接进 Alfred | 许可 | 备注 |
|---|---|---|---|---|
| **Apple SpeechAnalyzer / SpeechTranscriber**（macOS 26、iOS 26） | 有简体、繁体、粤语等 locale；一次会话选一个 locale，**混说能力不明** | 要写一个 Swift 小程序，Node 通过子进程调用 | 系统自带 | 英文测试 WER 2.12%，好于 Whisper Small 的 3.74%（Inscribe，LibriSpeech）；**没找到中文的可靠评测**；支持的 locale 随系统版本变，要在本机查 `supportedLocales` |
| **Qwen3-ASR-0.6B**（MLX 移植） | 中英双语，能自动判断语言，支持给上下文提示 | 社区移植：Python（mlx-qwen3-asr、qwen3-asr-mlx）或 C（qwen3-asr-mlx-c），作为子进程 | 权重 Apache-2.0 | M4 Air 上约 12.6 倍实时（社区报告）；流式靠「开窗口重解码」，离线质量差约 2 个百分点；**不是官方 MLX 版本** |
| **SenseVoice / Fun-ASR-Nano**（FunASR） | 中、英、粤、日、韩；Fun-ASR-Nano 支持热词 | funasr-mlx（Python）；也可能有 sherpa-onnx 的 Node 绑定（**未核实**） | FunASR 模型许可，**商用前要看条款** | 非自回归，很快；流式 Paraformer 在 MLX 上的 CER 0.156，明显变差 |
| Whisper large-v3-turbo | 中文可用，但有时出繁体、标点不稳，偶尔幻觉复读（试跑时一句转成上百个「了」）；可以用 initial prompt 给词表 | mlx-whisper（Python）或 whisper.cpp（C，有 Node 绑定） | MIT | 开源听写 App 的主力，生态最成熟；**已放进第 6 节的比较** |
| Parakeet | 以英语和欧洲语言为主 | FluidAudio | CC-BY | 不考虑 |

【事实】本机是 Apple M4 / 16GB，跑 0.6B 级别的模型没有压力。

### 3.2 云端

| 候选 | 中英混说 | 上下文 / 热词 | 价格（自报） | 备注 |
|---|---|---|---|---|
| **Soniox** stt-rt-v5 | 自称能在一句里中英切换；Speko 的流式评测里中英混合错误率 11.8%，排第二 | 支持 context（术语、人名） | 约 $0.12/小时（实时） | 两家来源对是否额外按 token 计费说法不一 |
| **AssemblyAI** universal-3-5-pro | Speko 评测里唯一两种语言都保住的，约 9.8% | 支持 | 未查 | 厂商自称代码切换第一 |
| **OpenAI gpt-transcribe / gpt-live-transcribe** | 支持多语言提示，没有中文专项数据 | 关键词列表 | gpt-transcribe 约 $0.0045/分钟（二手） | 2026-07 发布；whisper-1、gpt-4o-transcribe 系列 2027-02-26 下线 |
| **豆包流式语音识别 2.0**（火山引擎） | 中文最强的候选（含方言），混说未查到 | 有热词（未在本轮核实） | 约 ¥1/小时 | 要国内实名的火山账号 |
| ElevenLabs scribe_v2_realtime | 中英混合错误率 75%，第二种语言大多被转成英文 | | | **排除** |
| Deepgram Flux | 流式只支持英文 | | | **排除** |

【事实】以上云端都比本机贵不了多少：按 Bruce 一天说 30 分钟算，Soniox 一个月约 $1.8，豆包约 ¥15。

### 3.3 不用的

- **浏览器自带的 Web Speech API**：在 Electron 里会报 `network` 错误（Google 的服务只给正式版 Chrome 用），不能依赖。
- **只靠手机键盘上的系统听写**：PWA 的输入框里本来就能用，**零成本的后备**，但没法加上下文，也接不上快说和形象。保留它，不当主方案。

## 4. 准不准，主要靠上下文

Bruce 的话是中英混着说的，开发时还夹着 `useSpeech`、`tesseract`、`engine-pi` 这类名字。通用模型在这两点上最容易错。补救有两层：

1. **识别时给提示**（Qwen3-ASR 的上下文、Soniox 的 context、gpt-transcribe 的关键词、豆包的热词）。【建议】由主节点按场景拼一份词表：
   - 总是带：Bruce 的常用词（Alfred、人名、地名），存在设置里，可编辑。
   - 日常：当前页面（待办标题、日程标题、邮件发件人）。
   - 开发：项目的文件名、目录名、最近 git diff 里出现的标识符、AGENTS.md / CLAUDE.md 里的专有名词。Wispr Flow 也是这么做的：从当前编辑器读函数、类、变量名加进转写上下文，再把认出来的标识符包上反引号。
2. **识别后整理一遍（可选）**：去掉「嗯、那个」，补标点，标识符加反引号。用一个小模型，提示里带同一份词表。【建议】**听写模式才整理**（文字要给人看、要改）；快说直接发原文，交给 agent 自己理解，省一次调用、少一层出错的地方。

给 agent 的提示（参考 Hermes Agent 的做法）：「这条是语音转写，可能有听错的词；拿不准的名字先查或先问；回复要短。」

## 5. 各端怎么录

### 5.1 统一的录音方式

【建议】所有前端都用 Web Audio（`AudioWorklet`）直接取 16kHz 单声道 PCM，发 WAV 给主节点。不用 `MediaRecorder`：iOS 上它出 mp4/AAC，主节点还得解码；PCM 每秒 32KB，说 30 秒约 1MB，走 Tailscale 没问题。

接口草案：

```
POST /api/voice/transcribe     body: audio/wav, query: ?scene=daily|dev&conversation=…
→ { text, raw, language, engine, ms }

WS   /api/voice/stream         以后做流式（边说边出字）时用；第一版不做
```

- 设备权限跟着对话走：能发消息的设备就能转写。
- 音频转完即删，不落盘（【待定】要不要留最近几条方便回放纠错）。
- 第一版**不做流式**：松开后整段识别。0.6B 模型 12 倍实时，说 10 秒等不到 1 秒；Wispr Flow 这类产品也是松开后才出字。流式等实时对话那一步一起做。

### 5.2 Mac（Electron）

- **麦克风权限**：打包时 Info.plist 写 `NSMicrophoneUsageDescription`，第一次用时调 `systemPreferences.askForMediaAccess('microphone')`。开发期 Electron 二进制会以「Electron」的名义申请。
- **App 里**：输入框底栏的麦克风键，点一下开始、再点一下结束（或按住）。说话时形象切到 `listen`，底栏显示音量条。
- **全局「对 Alfred 说」**：Electron 的 `globalShortcut` 只能收到按下、收不到松开，所以只能做成「按一下开始，再按一下结束」，不需要额外权限。要做「按住说话、松开结束」，得用 `uiohook-napi` 这类原生钩子，系统会要「输入监控」（或「辅助功能」）权限。【建议】第一版用切换式，按住式以后再说。快捷键和现有的 `Alt+Space` 分开，比如 `Alt+Shift+Space`（【待定】）。
- 全局快说时，常驻形象切到 `listen`，说完转成 `think`，Alfred 用说话卡片回一句（「好，明天下午三点前，已加到待办」）。

### 5.3 手机（PWA）

- **麦克风键**同 Mac；**长按底栏的形象**就是快说。
- **已知的坑**：iOS 上加到主屏幕的 PWA，每次重新打开都要再问一次麦克风权限；Safari 里「始终允许」的设置不带到主屏幕 App。有人在 2026-10 报告 WebKit bug 327237，仍未修（我只读到了引用这条 bug 的 GitHub 讨论，没打开 bug 本身）。另有报告 PWA 关掉再开后 `MediaRecorder` 失灵。
  - 应对：只在用户点了麦克风以后才申请；一次打开期间复用同一个音频流，不要每按一次就重新申请（有项目因为每次按都申请两次而被弹两次）；用 `AudioWorklet` 而不是 `MediaRecorder`。
  - 后备：键盘上的系统听写。
- PWA 退到后台时 iOS 会停麦克风，锁屏下不能用。
- 【建议，以后】iOS 快捷指令 + 操作按钮：「听写文本」→「获取 URL 内容」发到 Alfred。系统听写在手机上做，Alfred 只收文字，不用打开 PWA。需要一种只能「发一条快说」的受限令牌，现在的设备令牌是 HttpOnly cookie，快捷指令拿不到。原生 App 做出来以后，这些都换成 App 里的实现。

### 5.4 开发会话

- 默认听写，文字进输入框，看过再发。
- 整理时把标识符包上反引号，路径保持原样。
- 语音**不能**用来批准命令或切换权限模式（呼应 dev-mode.md 的权限设计：模型或转写听错的「好」不能变成一次 shell 授权）。

## 6. 下一步：用 Bruce 的录音比一次

公开评测里几乎没有「中英混说 + 开发术语」这一项，而这正是 Bruce 的用法，所以要自己比。

【建议】

1. 录 30 段，每段 5～20 秒，按 Bruce 的真实说法：
   - 10 段日常中文（待办、日程、提醒）；
   - 10 段中英混说（「把 meeting 挪到 Thursday 下午」）；
   - 10 段开发口述（带文件名、函数名、命令）。
   自己写下每段的标准文本。
2. 每段跑 Apple SpeechTranscriber（zh-CN）、Qwen3-ASR 0.6B / 1.7B（MLX）、Whisper large-v3-turbo（MLX）、Soniox、AssemblyAI、gpt-transcribe、豆包极速版，能给词表的都跑带 / 不带两遍。SenseVoice 暂时没放（MLX 移植要手动配模型文件），需要时再加。
3. 记四个数：字错率（CER）、专有名词对了几个、松开后多久出字、每小时成本。
4. 一张表 + 结论写回本文第 3 节，定默认引擎。

工具已做好（2026-11-18）：[scripts/voice-bench/](../../scripts/voice-bench/README.md)，包括录音网页、七个引擎、打分和报告。Apple 那一家要先装 macOS 26 的 Command Line Tools；云端几家要 Bruce 自己开账号、填 key。

### 6.1 第一轮结果：本机三个引擎（2026-11-18）

Bruce 还没录音，先用两组代用数据：

- **真人**：ASCEND 公开数据集（CC BY-SA 4.0）的测试集和验证集里抽的 90 句。5 个人自然对话，中英混说和纯中文各一半，共 395 秒。
- **合成**：本文的 30 条句子，中文部分用中文声音、英文部分用同一个人的英文声音，拼起来念，两个声音共 60 句，共 298 秒。这是唯一有开发术语的一组。

机器：M4 / 16GB。错误率按混合错误率算（汉字按字、英文按词），不计「呃、嗯、um」。「+词表」是把同一类所有句子的关键词都塞给识别器。

| 引擎 | 真人：错误率 | 真人：关键词 | 合成：错误率 | 合成：开发类 | 合成：关键词 | 1 秒音频算多久 | 峰值内存 |
|---|---|---|---|---|---|---|---|
| **Qwen3-ASR 0.6B** | 9.4% | 85/110 | 17.1% | 27.0% | 87/106 | **0.08 秒** | **2.9 GB** |
| Qwen3-ASR 0.6B +词表 | **9.1%** | 89/110 | 12.7% | 23.0% | 99/106 | 0.08 秒 | 2.9 GB |
| Qwen3-ASR 1.7B | **9.0%** | 95/110 | 12.5% | 19.5% | 96/106 | 0.20 秒 | 7.6 GB |
| Qwen3-ASR 1.7B +词表 | 10.7% | 98/110 | **7.4%** | **10.5%** | **101/106** | 0.20 秒 | 7.6 GB |
| Whisper large-v3-turbo | 17.5% | 38/110 | 14.8% | 21.9% | 93/106 | 0.28 秒 | 2.0 GB |
| Whisper large-v3-turbo +词表 | 43.5% | 80/110 | 28.2% | 49.2% | 90/106 | 0.30 秒 | 2.0 GB |
| Whisper turbo 中文版（BELLE） | 16.2% | 46/110 | 37.6% | 50.0% | 38/106 | 0.27 秒 | 2.0 GB |
| Cohere Transcribe（int8） | 13.4% | 66/110 | 210.8% | 383.2% | 74/106 | 0.07 秒 | 2.5 GB |

看到的：

1. **真人语音上，0.6B 和 1.7B 几乎一样准**（9.4% 对 9.0%），差别在噪声范围内。1.7B 的长处是专有名词：真人组关键词 95 对 85，合成的开发类 19.5% 对 27.0%。
2. **1.7B 的代价很大**：算得慢 2.5 倍，峰值内存 7.6GB。这台 16GB 的 Mac 跑它时用上了交换内存，把磁盘写满过一次。作为一直开着的服务，它太重。
3. **Whisper 出局**。不带词表时，混说的英文常被转成中文音译，关键词只认对 38/110。带上词表后会幻觉：一句话转成上百个「非常」，或者冒出阿拉伯文、俄文的乱码。它也是三个里最慢的。
4. **Superwhisper 用的两个模型也不行**（2026-11-19 补测）。
   - 中文版 Whisper（BELLE 微调）：比原版 Whisper 好一点点（16.2% 对 17.5%），但混说里的英文更容易被转成中文。
   - Cohere Transcribe：速度和 0.6B 一样快，纯中文也还行（7.4%）。但它一次只能指定一种语言，说话里一夹英文，就会把中文写成拼音（「每天八点」→「Maytian Badian」），或者一个字重复上百遍。合成组的错误率因此到了 210%。
5. **词表要短、要准，不能一股脑全塞。** 合成组里，词表让开发类错误率明显下降（1.7B 从 19.5% 降到 10.5%）。但真人组里塞了上百个英文词以后，Qwen 有时会把整句翻成英文输出（「这这来这里的大学」→「this, this, um, Leiden, the university…」），混说的错误率反而上升（1.7B 从 12.5% 升到 16.0%）。

**结论（本机）：默认用 Qwen3-ASR 0.6B，配一份按场景挑过的短词表。** 它的准确度在真人语音上和 1.7B 打平，计算量是 1.7B 的 2/5，内存是 1.7B 的 2/5。说 10 秒话，GPU 只忙 0.8 秒左右，耗电可以忽略。1.7B 留作以后的「精确模式」（比如开发会话、接着电源、内存够的 Mac），不常驻。

**占多少内存、要不要常驻**（实测，Qwen3-ASR 0.6B，fp16）：

| 时刻 | 占用 |
|---|---|
| 加载中（2.9 秒） | 峰值约 3.0GB：权重 1.5GB，加载时还有一份 1.5GB 的临时副本 |
| 加载完、空闲 | **约 1.5GB**：模型权重放在 GPU 显存里。Mac 的 CPU 和 GPU 共用同一块物理内存，所以这 1.5GB 实打实占着内存。`ps` 只显示约 200MB，因为 GPU 显存不算进进程常驻内存，但它确实被占着 |
| 识别一句 | 0.4 秒，基本不再涨 |

【建议】不常驻：按下说话键就开始加载，一边录音一边加载，人说话本来就要好几秒，2.9 秒的加载基本被录音时间盖住。闲置 10 分钟（可调）后卸载。这样平时零占用，用的时候占 1.5GB。另外，4-bit 量化版能把权重降到约 0.5GB，准确度要另测。

还没测、可能改变结论的：

- **云端几家和 Apple 的都没测**（没有 key，没有 macOS 26 SDK）。这个结论只在本机三家里成立。
- 0.6B 的 4-bit 量化版本可能把内存降到 1GB 左右，准确度要另测。
- 真人组是别人的声音和录音设备，合成组的开发术语是机器念的。**最后还要用 Bruce 自己的录音确认一次**，尤其是开发术语。
- 词表怎么挑（多少词、按什么选）要单独试，见第 4 节。

### 6.2 参考：Superwhisper 怎么做（2026-11-19）

Superwhisper 是 Mac / Windows / iPhone 上的付费听写 App，跟 Alfred 的语音输入最像。以下来自它的官方文档（superwhisper.com/docs，读了 24 页）和几篇评测，**没有实际用过**。

**流程是两段，每段都能选本机或云端：**

```
按键录音 → 去掉静音、统一音量 → 语音模型转文字（带词表提示）
        → 固定替换（不用 AI）→ 抓上下文 → 语言模型按「模式」整理（可选）→ 粘贴到光标处
```

| 方面 | Superwhisper 的做法 | 对 Alfred 的启发 |
|---|---|---|
| **模式** | 一个模式 = 一个语音模型 + 一段整理指令。内置：只转文字、消息（去口头禅、改语法、正式程度可调）、邮件、笔记、Super（看当前 App 调整、能对选中文字下格式命令）、自定义。模式可以绑定 App 或网站，切过去自动换 | Alfred 的「场景」就是模式：日常、开发各配一份词表和整理方式，按所在页面自动切换。不需要让用户自己建模式 |
| **本机语音模型** | Whisper 全系列，包括「Whisper Large v3 Turbo（中文）」；Parakeet；Cohere Transcribe（MLX 4-bit，1.3GB，文档称本机最准：M4 上 WER 8.4%，14 种语言含中文） | **两个都测了，都输给 Qwen3-ASR 0.6B**（第 6.1 节第 4 条）。Cohere 遇到中英混说会把中文写成拼音 |
| **云端语音模型** | 自家 S1-Voice（称在自家测试里最准）、Deepgram Nova、ElevenLabs Scribe | 我们的测试里 ElevenLabs 中英混说很差 |
| **中英混说** | 文档没提；只说「其他语言的词表词会影响自动识别语言」。有评测说云端整理会把非英语文字改坏 | 混说正是我们要自己比的原因 |
| **词表** | 一张表，作为提示发给语音模型。文档明确说**词表要短**，词会影响标点和格式。另有固定替换（不区分大小写，按你写的大小写输出），比如「at sign」→「@」 | 和我们的实测一致（第 6.1 节第 4 条）。**固定替换值得照抄**：「use speech」→「useSpeech」这类开发词，靠规则比靠模型稳 |
| **上下文** | 三种：选中的文字（开始录音时抓）、剪贴板（录音前 3 秒内或录音中复制的）、当前 App（窗口标题、输入框内容，转写完、整理前才抓）。还会加上日期时间、用户名。都要付费版 | Alfred 自带更好的上下文（在哪一页、哪个项目），不需要读别的 App 的窗口 |
| **录音** | 默认 ⌥Space 切换式；另有按住说话（轻点一下等于切换式）；Esc 取消（30 秒内直接取消，更长要确认）；录音时可暂停或压低正在播的音乐；录音窗口有波形 | **Alfred 现在的 Alt+Space 和它的默认键撞了**，选全局快捷键时要避开。「按住说话、轻点切换」合在一个键上，是个好做法 |
| **送出文字** | 粘贴到光标处；粘贴不了就模拟打字；按住 Shift 粘完自动回车；默认不覆盖剪贴板 | Alfred 的文字是进自己的输入框或直接发消息，不用粘到别的 App，简单得多 |
| **iPhone** | 自定义键盘（要开「完全访问」），也能绑操作按钮；**手机和 Mac 的设置不同步** | Alfred 识别在 Mac 上做，手机只录音，天然一致。键盘扩展要等原生 App |
| **隐私** | 两段都选本机时，文档称音频和文字都不出电脑；云端用零留存条款；历史存在本机 `~/superwhisper` | 跟 Alfred「主节点持有一切」一致 |
| **价格** | 免费版：本机 Whisper、词表、替换、最多 2 个不带 AI 的模式。付费 $8.49/月、$84.99/年或终身 $249.99：云端模型、Parakeet、Cohere、AI 整理、上下文 | Alfred 开源免费，本机能做到它付费版的大部分 |

**一句话：** Superwhisper 的核心是「语音模型 + 可选的 AI 整理」两段，分别可选本机或云端，再加上按 App 自动切换的模式。Alfred 的方案和它同构；区别是 Alfred 的上下文来自自己（页面、项目），文字直接交给 agent，不用模拟粘贴。它在中文和混说上没有特别的做法，所以这方面没有现成答案可抄。

## 7. 待定

1. **默认引擎**：本机暂定 Qwen3-ASR 0.6B（第 6.1 节）。要不要再比云端，取决于 Bruce 愿不愿意开账号；不比也能先用本机的做起来。
2. **全局快捷键**：第一版切换式（不要权限）还是直接做按住式（要输入监控权限）？用哪个键？
3. **日常快说**：直接发出去，还是也先进输入框？本文建议直接发。
4. **要不要留音频**：转完即删，还是保留最近几条方便回放纠错？
5. **实现语言**：本机模型如果选 Qwen3-ASR，用 Python 子进程（打包时要带 Python）还是 C 移植（更好打包，但更新慢）？

## 8. 记着、先不做：待办从哪来

Bruce 对待办的设想（2026-11-18）：

1. **说一声就建**：本文做完即可用（快说 → agent → 待办工具）。
2. **Alfred 自己筛出来的事放进待办**：比如从邮件、消息里看出要做的事。要定：是直接放进去，还是先以「提议」的形式放（Alfred 已经有提议机制）。
3. **日历上的日程同步到待办**：要定同步方向、哪些日程算待办、改了一边另一边怎么办。

后两条不在这次范围内。

## 9. 来源

本机识别：

- https://blog.addpipe.com/apple-speechanalyzer-api/
- https://get-inscribe.com/blog/apple-speech-api-benchmark.html
- https://www.argmaxinc.com/blog/apple-and-argmax
- https://antongubarenko.substack.com/p/ios-26-speechanalyzer-guide
- https://pypi.org/project/funasr-mlx/0.2.3/
- https://huggingface.co/baicai1145/qwen3-asr-0.6b-mlx
- https://github.com/moona3k/mlx-qwen3-asr/
- https://github.com/odysa/qwen3-asr-mlx-c
- https://pypi.org/project/qwen3-asr-mlx/
- https://modelscope.github.io/FunASR/tutorial.html
- https://github.com/Blaizzy/mlx-audio/issues/761
- https://awesomeosai.com/self-hosted/speech-to-text

云端识别：

- https://benchmarks.speko.ai/blog/code-switching-stt-benchmark/
- https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription
- https://soniox.com/speech-to-text
- https://soniox.com/compare-stt/soniox-vs-openai/chinese
- https://www.speechmatics.com/how-we-compare/soniox-alternative
- https://spokenly.app/blog/gpt-transcribe
- https://dev.to/aidriftline/openai-retires-whisper-1-gpt-4o-transcribe-gpt-4o-mini-transcribe-and-gpt-4o-transcribe-diarize-32jl
- https://www.volcengine.com/docs/6561/1359370
- https://www.volcengine.com/

听写产品和开发场景：

- https://docs.wisprflow.ai/articles/8554805225-variable-recognition
- https://docs.wisprflow.ai/articles/6434410694-use-flow-with-cursor-vs-code-and-other-ides
- https://www.assemblyai.com/blog/best-open-source-dictation-apps-mac
- https://github.com/opennookorg/betterwispr
- https://github.com/OpenWhispr/openwhispr
- https://github.com/moona3k/macparakeet

Superwhisper 和 Cohere Transcribe：

- https://superwhisper.com/docs （modes、models/voice、models/language、get-started、common-issues/context、billing/plans、security/sensitive-data、get-started/ios 等页）
- https://bossai.tech/blog/superwhisper-review
- https://www.getvoibe.com/resources/superwhisper-review/
- https://pasqualepillitteri.it/en/news/556/ai-voice-dictation-wispr-flow-superwhisper-compared
- https://venturebeat.com/orchestration/coheres-open-weight-asr-model-hits-5-4-word-error-rate-low-enough-to-replace
- https://the-decoder.com/cohere-releases-open-source-model-that-tops-speech-recognition-benchmarks/
- https://www.producthunt.com/p/cohere-2/cohere-transcribe

实测数据：

- ASCEND：https://huggingface.co/datasets/CAiRE/ASCEND （CC BY-SA 4.0）

平台限制：

- https://github.com/EastStarAI/sanad-agent/issues/422
- https://bugs.webkit.org/show_bug.cgi?id=215884
- https://developer.apple.com/forums/thread/797987
- https://groups.google.com/a/chromium.org/g/chromium-dev/c/RBZXqc0Zvmc
- https://github.com/mumble-voip/mumble/pull/7065
- https://openapps.pro/packages/uiohook-napi
