"""Alfred's text-to-speech bake-off: what each local engine sounds like and how fast it is on this Mac.

    uv run --no-project --python 3.12 --with mlx-audio==0.6.7 --with "misaki[zh]" --with soundfile python -I tts.py ENGINE OUT_DIR

ENGINE is one of: kokoro, qwen. Writes OUT_DIR/<engine>-<voice>-<n>.wav and prints one JSON line per sample:
load time, time to the first audio, total time, audio length, peak memory. Lines come from tts-lines.json.
"""
import json, sys, time
from pathlib import Path
import numpy as np, soundfile as sf
import mlx.core as mx
from mlx_audio.tts.utils import load_model

ENGINES = {
    "kokoro": ("mlx-community/Kokoro-82M-bf16", ["zf_xiaoxiao", "zf_xiaoyi", "zm_yunxi"], {"lang_code": "z"}),
    "qwen": ("mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", ["Vivian", "Serena", "Uncle_Fu"], {"lang_code": "Chinese"}),
}

def main() -> None:
    engine, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    repo, voices, extra = ENGINES[engine]
    lines = json.loads((Path(__file__).parent / "tts-lines.json").read_text())
    start = time.perf_counter()
    model = load_model(repo)
    print(json.dumps({"engine": engine, "load_s": round(time.perf_counter() - start, 2)}), flush=True)
    list(model.generate(text="你好。", voice=voices[0], **extra))  # warm-up
    for voice in voices:
        for n, text in enumerate(lines, 1):
            t = time.perf_counter(); first = None; parts = []; rate = 24000
            for r in model.generate(text=text, voice=voice, **extra):
                first = first or time.perf_counter() - t
                parts.append(np.array(r.audio)); rate = getattr(r, "sample_rate", rate)
            audio = np.concatenate(parts)
            sf.write(out / f"{engine}-{voice}-{n}.wav", audio, rate)
            print(json.dumps({"engine": engine, "voice": voice, "n": n, "first_s": round(first, 2),
                              "total_s": round(time.perf_counter() - t, 2), "audio_s": round(len(audio) / rate, 2),
                              "peak_gb": round(mx.get_peak_memory() / 1e9, 2)}), flush=True)

if __name__ == "__main__":
    main()
