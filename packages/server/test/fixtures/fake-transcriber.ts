/** Stands in for voice/transcribe.py: says it is ready, then answers each recording with its byte count.
 * A recording of exactly 46 bytes makes it fail; one of 48 bytes is answered with the words it was given;
 * FAKE_EXIT_AFTER=n makes it quit after n answers. */
import { statSync } from "node:fs";
import { createInterface } from "node:readline";

const exitAfter = Number(process.env.FAKE_EXIT_AFTER ?? 0);
let answered = 0;
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const job = JSON.parse(line) as { id: string; wav: string; context: string };
  const size = statSync(job.wav).size;
  if (size === 48) console.log(JSON.stringify({ id: job.id, text: `context: ${job.context}`, ms: 1 }));
  else if (size === 46) console.log(JSON.stringify({ id: job.id, error: "cannot hear that", ms: 1 }));
  else console.log(JSON.stringify({ id: job.id, text: `heard ${size} bytes`, ms: 5 }));
  if (exitAfter && ++answered >= exitAfter) process.exit(0);
}
