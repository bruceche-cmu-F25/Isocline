"""Whisper on this Mac (mlx-whisper). Same job format and output as local_mlx.py.

    uv run --no-project --with mlx-whisper==0.4.3 --with opencc-python-reimplemented==0.1.7 \
        python engines/local_whisper.py <hf-repo> <jobs.json>

Whisper is told the speech is Chinese (it otherwise guesses one language per clip and may pick English for
mostly-English sentences). It sometimes writes traditional characters, which Zirma would convert anyway, so the
text is converted to simplified; the untouched output is kept as "raw". The word list goes in as the initial prompt.
"""
import json
import sys
import time

import dataclasses

import mlx_whisper
import mlx_whisper.load_models as load_models
from opencc import OpenCC

# Some converted checkpoints (BELLE's Chinese fine-tune) carry config keys mlx-whisper does not know; drop them.
_Dims = load_models.whisper.ModelDimensions
_known = {field.name for field in dataclasses.fields(_Dims)}
load_models.whisper.ModelDimensions = lambda **config: _Dims(**{k: v for k, v in config.items() if k in _known})


def report_stats() -> None:
    """Last line: peak memory of this process and of MLX's GPU buffers, in MB."""
    import resource
    import mlx.core as mx
    peak = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024  # bytes on macOS
    print(json.dumps({"stats": {"rss_mb": round(rss), "gpu_mb": round(peak() / 1024 / 1024)}}), flush=True)


def main() -> None:
    repo, jobs_path = sys.argv[1], sys.argv[2]
    with open(jobs_path, encoding="utf-8") as f:
        jobs = json.load(f)
    t2s = OpenCC("t2s")
    run = lambda wav, prompt: mlx_whisper.transcribe(
        wav, path_or_hf_repo=repo, language="zh", initial_prompt=prompt or None,
        condition_on_previous_text=False, verbose=None,
    )
    if jobs:
        run(jobs[0]["wav"], None)  # warm-up: download/load weights once
    for job in jobs:
        start = time.perf_counter()
        try:
            raw = run(job["wav"], "，".join(job.get("terms") or []))["text"].strip()
            out = {"id": job["id"], "text": t2s.convert(raw), "raw": raw}
        except Exception as error:  # report and keep going
            out = {"id": job["id"], "error": f"{type(error).__name__}: {error}"}
        out["ms"] = round((time.perf_counter() - start) * 1000)
        print(json.dumps(out, ensure_ascii=False), flush=True)
    report_stats()


if __name__ == "__main__":
    main()
