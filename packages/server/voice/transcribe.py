"""Zirma's speech-to-text worker: Qwen3-ASR on this Mac (MLX), kept loaded while the home node needs it.

    uv run --no-project --python 3.12 --with mlx-qwen3-asr==0.4.4 python -I transcribe.py [model]

Protocol, one JSON object per line:
  out  {"ready": true}                                   once the model is loaded and warmed up
  in   {"id": "...", "wav": "/abs/path.wav", "context": "optional words"}
  out  {"id": "...", "text": "...", "language": "...", "ms": 123}   or   {"id": "...", "error": "...", "ms": 0}
The home node owns the files; this only reads them.
"""
import json
import sys
import time

import numpy as np
from mlx_qwen3_asr import Session


def main() -> None:
    model = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3-ASR-0.6B"
    session = Session(model=model)
    session.transcribe((np.zeros(16000, dtype=np.float32), 16000))  # warm-up: compile kernels
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        start = time.perf_counter()
        try:
            result = session.transcribe(job["wav"], context=job.get("context") or "")
            out = {"id": job["id"], "text": result.text.strip(), "language": result.language}
        except Exception as error:  # report and keep serving
            out = {"id": job["id"], "error": f"{type(error).__name__}: {error}"}
        out["ms"] = round((time.perf_counter() - start) * 1000)
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
