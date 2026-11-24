"""Reads every sample in a folder back through Qwen3-ASR 0.6B and scores it against the line it was made from
(mixed error rate: Han characters one by one, other words whole). A rough check that a voice says the words clearly;
it says nothing about how pleasant it sounds.

    uv run --no-project --python 3.12 --with mlx-qwen3-asr==0.4.4 python -I tts-check.py results/tts
"""
import json, re, sys
from collections import defaultdict
from pathlib import Path
from mlx_qwen3_asr import Session

def tokens(text):
    text = re.sub(r"[^\w\s]", " ", text.lower())
    return re.findall(r"[一-鿿]|[a-z0-9]+", text)

def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (x != y))
    return row[-1]

folder = Path(sys.argv[1])
lines = json.loads((Path(__file__).parent / "tts-lines.json").read_text())
session = Session(model="Qwen/Qwen3-ASR-0.6B")
scores = defaultdict(lambda: [0, 0])
for wav in sorted(folder.glob("*.wav")):
    engine_voice, n = wav.stem.rsplit("-", 1)
    ref = tokens(lines[int(n) - 1])
    heard = session.transcribe(str(wav)).text
    errors = distance(ref, tokens(heard))
    scores[engine_voice][0] += errors; scores[engine_voice][1] += len(ref)
    print(json.dumps({"sample": wav.stem, "errors": errors, "heard": heard}, ensure_ascii=False), flush=True)
for name, (errors, total) in sorted(scores.items()):
    print(f"{name}: {errors / total:.1%} ({errors}/{total})")
