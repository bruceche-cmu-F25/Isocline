# Everyday Zirma, with a real model

Says ordinary things to Zirma ("周四下午要和张伟见面", "牛奶买了", "每周二下午3点有组会") and checks what landed: todos, calendar proposals, questions asked, the reply.

```bash
node scripts/eval/run.ts                       # every scenario once
node scripts/eval/run.ts --repeat 3            # three times each, to see how steady it is
node scripts/eval/run.ts --only flight,weekly-repeat --model openai-codex/gpt-6.1-sol --thinking high
```

- Each scenario gets a throwaway home node in a temp folder (or `--out`), with a few todos and a fake Google that only reads (`harness.ts`, `BASE_SEED`). Nothing is accepted, so nothing is sent anywhere; only the model calls leave the machine.
- The model sign-in is the one in the keychain; the model is `deepseek/deepseek-flash` with low thinking unless `--model` / `--thinking` say otherwise.
- `scenarios.ts` was written for Sunday 2026-11-22 (周四 = 11-26). On another day, update the dates in `D` and `BASE_SEED`.
- Lines starting `note:` are observations, not failures. `results.json` in the output folder has every reply, tool call and proposal; each node's model session is under `nodes/<id>/engine/sessions/`.
- Keep `--jobs` at 3 or so, and never run two evals into the same `--out` at once.
