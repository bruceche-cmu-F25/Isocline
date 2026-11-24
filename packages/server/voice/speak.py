"""Alfred's text-to-speech worker: Qwen3-TTS on this Mac (MLX), kept loaded while the home node needs it.

    uv run --no-project --python 3.12 --with mlx-audio==0.6.7 --with soundfile python -I speak.py [model]

The first run downloads the model (about 2 GB) into the Hugging Face cache.

Protocol, one JSON object per line:
  out  {"ready": true}                                    once the model is loaded and warmed up
  in   {"id": "...", "text": "...", "voice": "Vivian", "speed": 1.0, "lang": "Chinese", "out": "/abs/path.wav"}
  out  {"id": "...", "ms": 123, "seconds": 4.2}   or   {"id": "...", "error": "..."}
The home node owns the files; this only writes the one it is given.
"""
import json
import sys
import time

import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model


def speak(model, text, voice, speed, lang):
    parts, rate = [], 24000
    for result in model.generate(text=text, voice=voice, speed=speed, lang_code=lang):
        parts.append(np.array(result.audio))
        rate = getattr(result, "sample_rate", rate)
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32), rate


def main() -> None:
    model = load_model(sys.argv[1] if len(sys.argv) > 1 else "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit")
    speak(model, "你好。", "Vivian", 1.0, "Chinese")  # warm-up: compile kernels
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        start = time.perf_counter()
        try:
            audio, rate = speak(model, job["text"], job.get("voice") or "Vivian", float(job.get("speed") or 1.0), job.get("lang") or "Chinese")
            sf.write(job["out"], audio, rate, subtype="PCM_16")
            out = {"id": job["id"], "seconds": round(len(audio) / rate, 2)}
        except Exception as error:  # report and keep serving
            out = {"id": job["id"], "error": f"{type(error).__name__}: {error}"}
        out["ms"] = round((time.perf_counter() - start) * 1000)
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
