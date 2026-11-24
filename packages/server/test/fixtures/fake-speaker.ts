/** Stands in for voice/speak.py: says it is ready, then writes each request's text and voice into its file. */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const job = JSON.parse(line) as { id: string; text: string; voice: string; lang: string; out: string };
  writeFileSync(job.out, `RIFF....WAVEmodel ${job.voice} ${job.lang}|${job.text}`);
  console.log(JSON.stringify({ id: job.id, ms: 3, seconds: 1 }));
}
