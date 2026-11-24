# 语音识别比较

拿 Bruce 自己的录音比几家识别引擎，给 Alfred 的语音输入选默认引擎。背景见 [docs/research/voice-input.md](../../docs/research/voice-input.md) 第 6 节。

不进 App。录音、结果和 key 都只在这台 Mac 上（`clips/`、`results/`、`.env` 都在 `.gitignore` 里）。

## 1. 录音（约 15 分钟）

```bash
node scripts/voice-bench/server.ts
```

打开 http://127.0.0.1:4791 。

- 30 条起始句子在 `prompts.json` 里：10 条日常、10 条中英混说、10 条开发口述。
- 选中一行，按空格开始，再按一次结束。照平时说话的样子说。
- **说的和文字不一样时，改文字去对上你说的**，不要重录。文字是打分用的标准答案。
- 关键词是打分时要看有没有认对的词，可以改。
- 想加自己的句子，点「加一条」。

## 2. 准备引擎

本机（不要 key）：

- **Qwen3-ASR 0.6B / 1.7B**：要 `uv`（已装）。第一次运行会自动下载 `mlx-qwen3-asr` 和模型（0.6B 约 1.2GB，1.7B 约 3.4GB），存在 `~/.cache/huggingface/`。
- **Whisper large-v3-turbo**（mlx-whisper）：同样用 `uv`，第一次下载约 1.6GB。指定按中文识别；它有时出繁体，打分前转成简体（原文留在结果的 `raw` 里）；词表放进 initial prompt。
- **Whisper turbo 中文版**（BELLE 微调，mlx-audio 加载）和 **Cohere Transcribe**（int8，mlx-speech 加载，要 Python 3.13，uv 会自动装）：各约 1.6GB 和 2GB，都不能给词表。
- **Apple SpeechTranscriber**：要 macOS 26 SDK。这台 Mac 现在是 Command Line Tools 16.4（SDK 15.5），编不了。要测它，先装新版：

  ```bash
  softwareupdate --install "Command Line Tools for Xcode 26.6-26.6"
  ```

  约 900MB，要管理员密码。`engines/apple.swift` 还没在新 SDK 上编过，第一次可能要修一下。

云端（填了 key 才跑，没填的自动跳过）：在 `scripts/voice-bench/.env` 里写

```
SONIOX_API_KEY=...
ASSEMBLYAI_API_KEY=...
OPENAI_API_KEY=...
VOLC_API_KEY=...            # 火山引擎新控制台；旧控制台用 VOLC_APP_KEY + VOLC_ACCESS_KEY
```

| 引擎 | 价格（自报） | 新账号 |
|---|---|---|
| Soniox `stt-async-v6` | $0.10/小时（实时 $0.12） | 据说没有免费额度 |
| AssemblyAI `assemblyai-stt-3-7` | $0.21/小时 | 送 $50 |
| OpenAI `gpt-transcribe` | $0.0045/分钟（$0.27/小时） | 要先充值 |
| 豆包 大模型录音文件识别极速版 | 没查到（流式 2.0 约 ¥1/小时） | 要国内实名 |

30 段加起来不到 5 分钟音频，每家每次几分钱。**录音会发到这些公司的服务器上**；Soniox 和 AssemblyAI 的脚本在拿到结果后会删掉服务器上的文件和转写。

## 3. 跑

```bash
node scripts/voice-bench/run.ts
```

- 每个能跑的引擎跑两遍：不带词表、带词表（「+词表」）。词表 = `vocab.txt` + 同一类所有句子的关键词，模拟 Alfred 按场景拼的词表。
- 结果缓存在 `results/raw/`，再跑只转新的或改过的；`--fresh` 全部重来。
- 只跑某几个：`--engines qwen3-asr-0.6b,soniox-async-v6`；只跑不带词表的：`--context none`。

输出：

- `results/report.md`：总表。混合错误率（汉字按字、英文按词）、三类分开的错误率、关键词认对几个、松开后多久出字、每小时多少钱。
- `results/details.md`：每一句各家转成了什么，没认对的关键词打 ✗。

## 4. 看结果时注意

- 云端的耗时包括上传和轮询。AssemblyAI 每秒才轮询一次（它限制每分钟 60 次），所以会显得慢一些。Soniox 测的是文件接口；真用时会走实时接口，延迟会更低。
- 简单的中文数字和阿拉伯数字算一样（「三点」=「3点」）；繁简不转换。
- 词表不总是帮忙：用合成语音试跑时，Qwen3-ASR 0.6B 带上词表后，会把词表里没说过的词（tesseract）塞进转写。看 `details.md` 就能看到。
- Whisper 的老毛病是「幻觉复读」：试跑时有一句不带词表转成了上百个「了」，错误率一下冲到几百%。看总表时留意是不是一两句拖垮了平均，去 `details.md` 对一下。

## 没有自己的录音时

`import_ascend.py` 能从 ASCEND 公开数据集（真人中英混说，CC BY-SA 4.0）抽 90 句，变成同样格式的 clips。先从 https://huggingface.co/datasets/CAiRE/ASCEND 下载 `main/test-*.parquet` 和 `main/validation-*.parquet`（共约 210MB）：

```bash
uv run --no-project --with pyarrow python -I scripts/voice-bench/import_ascend.py /some/dir/clips test.parquet validation.parquet
```

然后用 `VOICE_BENCH_CLIPS=/some/dir/clips VOICE_BENCH_RESULTS=/some/dir/results node scripts/voice-bench/run.ts` 跑，结果不会和你自己的录音混在一起。第一轮结果见 [voice-input.md 第 6.1 节](../../docs/research/voice-input.md)。

注意内存：Qwen3-ASR 1.7B 峰值约 7.6GB，16GB 的 Mac 上会用到交换内存。

## 文件

| 文件 | 做什么 |
|---|---|
| `server.ts`、`record.html`、`capture-worklet.js` | 录音网页：浏览器取麦克风，转成 16kHz 单声道 WAV 存到 `clips/` |
| `prompts.json` | 30 条起始句子和关键词 |
| `vocab.txt` | 每个场景词表里都有的词 |
| `run.ts` | 跑引擎、打分、写报告 |
| `engines.ts` | 各家的调用方式 |
| `engines/local_mlx.py` | Qwen3-ASR 本机进程（模型常驻，预热后计时） |
| `engines/local_whisper.py` | Whisper 本机进程（同上） |
| `engines/local_mlx_audio.py` | 用 mlx-audio 加载的模型（中文版 Whisper） |
| `engines/local_cohere.py` | Cohere Transcribe 本机进程 |
| `engines/apple.swift` | Apple SpeechTranscriber 本机程序 |
| `score.ts` | 打分 |
| `import_ascend.py` | 从 ASCEND 公开数据集抽真人录音 |

## 声音（朗读）的比较

给 Alfred 开口选默认声音，背景和结果见 [docs/design/voice.md](../../docs/design/voice.md) 第 6 节。

```bash
cd scripts/voice-bench
uv run --no-project --python 3.12 --with mlx-audio==0.6.7 --with "misaki[zh]" --with soundfile python -I tts.py kokoro results/tts
uv run --no-project --python 3.12 --with mlx-audio==0.6.7 --with "misaki[zh]" --with soundfile python -I tts.py qwen results/tts
uv run --no-project --python 3.12 --with mlx-qwen3-asr==0.4.4 python -I tts-check.py results/tts
```

- 句子在 `tts-lines.json`。系统声音的样本用 `say -v Tingting --file-format=WAVE --data-format=LEI16@24000 -o results/tts/say-Tingting-1.wav "…"` 这样生成，文件名照 `<引擎>-<声音>-<第几句>.wav`。
- `tts-check.py` 把每个样本交给 Qwen3-ASR 再听一遍，算回听错误率：只说明念得清不清楚。好不好听要自己听。
- 第一次运行会下载模型：Kokoro 约 400MB，Qwen3-TTS 0.6B 约 2GB。
