import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLinksModule, type LinksSnapshot } from "@alfred/module-links";
import type { StateResponse } from "@alfred/protocol";
import { createHttpServer, openHome } from "../src/index.ts";

type SampleResponse = { snapshot: LinksSnapshot; revision: number; replayed?: boolean };
const image = { type: "image/png", bytes: Uint8Array.of(1, 2, 3) };

async function start(dataDir: string) {
  const links = createLinksModule({
    fetcher: async (url) => ({ url, cover: "https://example.org/poster.png" }),
    icons: async () => null,
    covers: async () => image,
  });
  const home = openHome({ dataDir, engine: { async submit() { throw new Error("unused"); } }, modules: [links] });
  const server = createHttpServer(home, { port: 0, uiDir: "/nonexistent" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sample = async () => (await (await fetch(base + "/api/link-sample")).json()) as SampleResponse;
  const post = async (path: string, requestId: string, input?: unknown) => {
    const response = await fetch(base + "/api/link-sample/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, input }),
    });
    assert.equal(response.status, 200);
    return await response.json() as SampleResponse;
  };
  const personal = async () => ((await (await fetch(base + "/api/state")).json() as StateResponse).modules.link as LinksSnapshot);
  return { base, sample, post, personal, close() { server.close(); server.closeAllConnections(); home.close(); } };
}

test("the interactive shelf has its own durable videos, folders, cached covers and replayable restore", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alfred-link-sample-"));
  let app = await start(dataDir);
  try {
    assert.equal((await app.personal()).clips.length, 0);
    assert.equal(existsSync(join(dataDir, "link-sample.sqlite")), false);
    const first = await app.sample();
    const { clips, places } = first.snapshot;
    assert.deepEqual(clips.map((clip) => new URL(clip.url).searchParams.get("v")),
      ["O_zcc6Xl12g", "aircAruvnKk", "WhWc3b3KhnY", "6avJHaC3C2U", "fNk_zzaMoSs"]);
    assert.ok(clips.every((clip) => clip.type === "video" && clip.author && clip.state === "unread"));
    assert.deepEqual(places.map((place) => place.title), ["Google", "Gmail", "YouTube"]);
    let loaded = first;
    for (let retry = 0; retry < 50 && loaded.snapshot.clips.some((clip) => !clip.cover); retry++) {
      await delay(10);
      loaded = await app.sample();
    }
    assert.ok(loaded.snapshot.clips.every((clip) => clip.cover), "both batches of sample posters finish");
    const file = loaded.snapshot.clips[0].cover;
    const poster = await fetch(app.base + "/api/link-sample/files/" + file);
    assert.equal(poster.headers.get("Content-Type"), "image/png");
    assert.deepEqual(new Uint8Array(await poster.arrayBuffer()), image.bytes);
    assert.equal((await fetch(app.base + "/api/modules/link/files/" + file)).status, 404);

    const [google, gmail, youtube] = places;
    const group = { id: gmail.id, targetId: google.id, title: "Work" };
    const grouped = await app.post("ops/link.group", "group", group);
    assert.ok(grouped.revision > first.revision);
    const folder = grouped.snapshot.folders![0];
    assert.equal(folder.title, "Work");
    assert.equal((await app.post("ops/link.group", "group", group)).replayed, true);
    const added = await app.post("ops/link.move", "move-in", { id: youtube.id, folderId: folder.id });
    assert.equal(added.snapshot.places.find((item) => item.id === youtube.id)?.folderId, folder.id);
    const moved = await app.post("ops/link.move", "move-out", { id: gmail.id });
    assert.equal(moved.snapshot.places.find((place) => place.id === gmail.id)?.folderId, undefined);
    const deleted = await app.post("ops/link.remove", "delete", { id: clips[0].id });
    assert.equal(deleted.snapshot.clips.length, 4);
    await app.post("ops/link.update", "seen", { id: clips[1].id, patch: { state: "seen", note: "Keep this note" } });
    await app.post("ops/link.save", "extra", { url: "https://example.org/saved", title: "Keep this page" });
    await app.post("ops/link.remove", "unpin", { id: google.id });

    app.close();
    app = await start(dataDir);
    const reopened = (await app.sample()).snapshot;
    assert.equal(reopened.clips.some((clip) => clip.id === clips[0].id), false);
    assert.equal(reopened.clips.find((clip) => clip.id === clips[1].id)?.state, "seen");
    assert.equal(reopened.places.find((place) => place.id === youtube.id)?.folderId, folder.id);
    const restored = (await app.post("restore", "restore")).snapshot;
    assert.equal(restored.clips.filter((clip) => clip.type === "video" && clip.state === "unread").length, 5);
    assert.ok(restored.clips.some((clip) => clip.title === "Keep this page"));
    assert.equal(restored.clips.find((clip) => clip.id === clips[1].id)?.note, "Keep this note");
    assert.deepEqual(restored.places, reopened.places);
    const back = restored.clips.find((clip) => clip.url === clips[0].url)!;
    await app.post("ops/link.remove", "delete-again", { id: back.id });
    assert.equal((await app.post("restore", "restore")).snapshot.clips.some((clip) => clip.url === back.url), false);
    const personal = await app.personal();
    assert.equal(personal.clips.length, 0);
    assert.deepEqual(personal.places.map((place) => [place.title, place.folderId]), places.map((place) => [place.title, undefined]));
  } finally {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
