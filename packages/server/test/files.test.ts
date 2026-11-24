import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getFile, type EnginePort, type EngineRequest } from "@isocline/core";
import { todoModule } from "@isocline/module-todo";
import type { ConversationDetail, FileInfo, SubmitRunResponse } from "@isocline/protocol";
import { createHttpServer, openHome, sniff, type Home } from "../src/index.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

async function start(home: Home): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const upload = (base: string, name: string, bytes: Uint8Array | string, type = "application/octet-stream") =>
  fetch(`${base}/api/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": type }, body: bytes });

test("what a file is, is made out from its bytes: an image, a PDF, text, or nothing Isocline takes", () => {
  assert.deepEqual(sniff(PNG), { kind: "image", type: "image/png" });
  assert.deepEqual(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { kind: "image", type: "image/jpeg" });
  assert.deepEqual(sniff(PDF), { kind: "pdf", type: "application/pdf" });
  assert.deepEqual(sniff(Buffer.from('{"a": "中文"}\n')), { kind: "text", type: "text/plain" });
  assert.equal(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), null, "a zip");
  assert.equal(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])), null, "a program");
  assert.equal(sniff(Buffer.from([0xc3, 0x28, 0x61])), null, "not UTF-8");
});

test("files are uploaded, sent with one message, handed to the engine, and shown back", async () => {
  const seen: EngineRequest[] = [];
  const engine: EnginePort = { async submit(request) { seen.push(request); return { reply: "Read them." }; } };
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-files-"));
  const home = openHome({
    dataDir, engine, modules: [todoModule],
    // Stands in for pdftotext: the first PDF has text, a "scan" has none.
    readPdf: async (pdf, out) => { const scan = readFileSync(pdf).includes("scan"); if (!scan) writeFileSync(out, "Lease agreement. Rent is due on the first."); return { pages: 3, readable: !scan }; },
  });
  const { server, base } = await start(home);
  try {
    const image = await (await upload(base, "../../etc/shot.png", PNG, "text/html")).json() as FileInfo;
    assert.deepEqual([image.name, image.kind, image.type, image.size], ["shot.png", "image", "image/png", PNG.length], "the name is its last part; the type is what the bytes are");
    const notes = await (await upload(base, "notes.md", "# Plan\n\n- call the landlord\n")).json() as FileInfo;
    const long = await (await upload(base, "log.txt", "line\n".repeat(20_000))).json() as FileInfo;
    const lease = await (await upload(base, "lease.pdf", PDF)).json() as FileInfo;
    const scan = await (await upload(base, "scan.pdf", Buffer.concat([PDF, Buffer.from("scan")]))).json() as FileInfo;
    assert.deepEqual([notes.kind, notes.type, lease.kind, lease.pages, lease.readable, scan.readable], ["text", "text/markdown", "pdf", 3, true, false]);

    for (const [name, bytes, status, code] of [["a.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), 415, "file_unsupported"], ["empty.txt", Buffer.alloc(0), 400, "file_empty"]] as const) {
      const refused = await upload(base, name, bytes);
      assert.deepEqual([refused.status, (await refused.json() as { code: string }).code], [status, code], name);
    }
    const big = await fetch(`${base}/api/files?name=big.txt`, { method: "POST", headers: { "Content-Length": String(21 * 1024 * 1024) }, body: "x" }).catch(() => null);
    assert.ok(big === null || big.status === 413, "a file past 20 MB is refused");

    // Sent with a message: the run carries them, the engine gets where they are, the conversation shows them.
    const ids = [image.id, notes.id, long.id, lease.id, scan.id];
    const submitted = await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "f-1", goal: "what do these say?", attachments: ids }) });
    assert.equal(submitted.status, 202);
    const { run } = await submitted.json() as SubmitRunResponse;
    await home.idle();
    const got = seen[0].attachments!;
    assert.deepEqual(got.map((file) => [file.name, file.as, !!file.path]), [["shot.png", "image", true], ["notes.md", "text", true], ["log.txt", "text", true], ["lease.pdf", "text", true], ["scan.pdf", "text", false]]);
    assert.equal(readFileSync(got[3].path!, "utf8"), "Lease agreement. Rent is due on the first.", "a PDF reaches the model as the text read out of it");
    assert.match(got[3].note!, /^PDF, 3 pages, the text read out of it/);
    assert.match(got[4].note!, /no text could be read from it/);
    assert.equal(getFile(home.world, image.id).runId, run.id);

    const detail = await (await fetch(`${base}/api/conversations/${run.conversationId}`)).json() as ConversationDetail;
    assert.deepEqual(detail.files![run.id].map((file) => file.name), ["shot.png", "notes.md", "log.txt", "lease.pdf", "scan.pdf"]);

    // The same request again is the same run; the same file cannot go with another message, nor can one that is gone.
    const again = await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "f-1", goal: "what do these say?", attachments: ids }) });
    assert.equal(again.status, 200);
    for (const [attachments, code] of [[[image.id], "file_taken"], [["nope"], "file_missing"]] as const) {
      const refused = await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: `f-${code}`, goal: "and this?", attachments }) });
      assert.equal((await refused.json() as { code: string }).code, code);
    }
    const tooMany = await Promise.all(Array.from({ length: 11 }, (_, i) => upload(base, `n${i}.txt`, `file ${i}`).then((response) => response.json() as Promise<FileInfo>)));
    const eleven = await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "f-11", goal: "all of these", attachments: tooMany.map((file) => file.id) }) });
    assert.equal((await eleven.json() as { code: string }).code, "file_too_many");

    // Shown back as what it is: an image as an image, anything else as a download, neither able to run anything.
    const shown = await fetch(`${base}/api/files/${image.id}`);
    assert.deepEqual([shown.status, shown.headers.get("content-type"), shown.headers.get("x-content-type-options"), shown.headers.get("content-disposition")], [200, "image/png", "nosniff", null]);
    const text = await fetch(`${base}/api/files/${notes.id}`);
    assert.match(text.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''notes\.md$/);
    assert.match(text.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal((await fetch(`${base}/api/files/nope`)).status, 404);

    // A file never sent is forgotten after a day, bytes and all; one that was sent stays.
    const stray = tooMany[0];
    assert.ok(existsSync(home.files.path(stray.id)));
    assert.equal(home.files.sweep(Date.now() + 25 * 3600_000), 11);
    assert.ok(!existsSync(home.files.path(stray.id)) && existsSync(home.files.path(image.id)));
  } finally { server.close(); server.closeAllConnections(); home.close(); }
});
