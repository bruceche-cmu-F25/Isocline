import assert from "node:assert/strict";
import { lookup as dnsLookup } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { fetchCover } from "../src/fetch.ts";
import { fetchIcon, fetchPage, imageType, isPublicAddress, looksLikeWall, PageFetchError, readHead } from "../src/index.ts";

test("only public addresses are reached: not this machine, a private network or a reserved range", async () => {
  for (const [address, family] of [["127.0.0.1", 4], ["10.1.2.3", 4], ["192.168.1.10", 4], ["172.20.0.1", 4], ["169.254.169.254", 4], ["100.100.100.100", 4], ["0.0.0.0", 4],
    ["::1", 6], ["fe80::1", 6], ["fd00::1", 6], ["::ffff:127.0.0.1", 6], ["::ffff:10.0.0.1", 6]] as const) {
    assert.equal(isPublicAddress(address, family), false, address);
  }
  for (const [address, family] of [["93.184.216.34", 4], ["8.8.8.8", 4], ["2606:4700:4700::1111", 6], ["::ffff:8.8.8.8", 6]] as const) assert.equal(isPublicAddress(address, family), true, address);
  // The real lookup refuses a name or a number that is this machine, before anything is sent.
  for (const url of ["http://127.0.0.1:1/", "http://localhost:1/", "http://[::1]:1/", "http://169.254.169.254/latest/meta-data/"]) {
    await assert.rejects(fetchPage(url), (error: PageFetchError) => error.code === "private", url);
  }
  await assert.rejects(fetchPage("ftp://example.com/x"), (error: PageFetchError) => error.code === "unsupported");
});

test("a page's head is read for what it says of itself; a wall's title is not taken for the page's", () => {
  assert.deepEqual(readHead(`<html><head><title> Plain &amp; simple </title>
    <meta property="og:title" content="RAG from scratch">
    <meta property='og:site_name' content='Example Video'>
    <meta name="author" content="L. Martin"><meta name=description content="Chunking,   embedding &#38; retrieval.">
    </head><body><title>not this one</title></body></html>`),
  { title: "RAG from scratch", site: "Example Video", author: "L. Martin", description: "Chunking, embedding & retrieval." });
  assert.deepEqual(readHead("<title>手冲新手参数</title>"), { title: "手冲新手参数" });
  assert.deepEqual(readHead("<title>Just a moment...</title><meta name='description' content='x'>"), { description: "x" });
  for (const wall of ["Sign in - Google Accounts", "404 Not Found", "安全验证", "小红书 - 你访问的页面不见了", "出错啦! - bilibili.com", "Attention Required! | Cloudflare", "登录 - rednote - share, connect, love"]) assert.equal(looksLikeWall(wall), true, wall);
  for (const real of ["How to design a login form", "Error Handling in Rust", "Forbidden City travel guide", "手冲咖啡入门"]) assert.equal(looksLikeWall(real), false, real);
});

/** A local site, reached with the system's own lookup (the real one would refuse 127.0.0.1). */
async function site(handler: Parameters<typeof createServer>[1]): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const local = dnsLookup as never;

test("a page is fetched through redirects, in its own encoding, without cookies, and only if it is a web page", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { base, server } = await site((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, agent: req.headers["user-agent"] });
    if (req.url === "/short") { res.writeHead(302, { Location: "/video?id=7" }).end(); return; }
    if (req.url === "/loop") { res.writeHead(302, { Location: "/loop" }).end(); return; }
    if (req.url === "/gbk") { res.writeHead(200, { "Content-Type": "text/html; charset=gbk" }).end(Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xbf, 0xa7, 0xb7, 0xc8, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e])); return; }
    if (req.url === "/file") { res.writeHead(200, { "Content-Type": "application/zip" }).end("PK"); return; }
    if (req.url === "/missing") { res.writeHead(404).end(); return; }
    if (req.url === "/members/post") { res.writeHead(302, { Location: "/login?next=%2Fmembers%2Fpost" }).end(); return; }
    if (req.url?.startsWith("/login")) { res.writeHead(200, { "Content-Type": "text/html" }).end("<title>Sign in</title>"); return; }
    if (req.url === "/forbidden") { res.writeHead(403).end(); return; }
    if (req.url === "/big") { res.writeHead(200, { "Content-Type": "text/html" }); res.write("<title>Big page</title>"); res.end("x".repeat(2_000_000)); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<title>The video</title><meta property='og:site_name' content='Tube'>");
  });
  try {
    assert.deepEqual(await fetchPage(`${base}/short`, undefined, local), { url: `${base}/video?id=7`, title: "The video", site: "Tube" });
    assert.equal((await fetchPage(`${base}/gbk`, undefined, local)).title, "咖啡");
    assert.equal((await fetchPage(`${base}/big`, undefined, local)).title, "Big page", "a long page is cut off, not refused");
    await assert.rejects(fetchPage(`${base}/file`, undefined, local), (error: PageFetchError) => error.code === "not_html");
    await assert.rejects(fetchPage(`${base}/missing`, undefined, local), (error: PageFetchError) => error.code === "status");
    await assert.rejects(fetchPage(`${base}/loop`, undefined, local), (error: PageFetchError) => error.code === "redirects");
    // A page that sends you to its sign-in is behind a wall; the sign-in page is never taken for it.
    await assert.rejects(fetchPage(`${base}/members/post`, undefined, local), (error: PageFetchError) => error.code === "login");
    await assert.rejects(fetchPage(`${base}/forbidden`, undefined, local), (error: PageFetchError) => error.code === "status");
    assert.deepEqual(await fetchPage(`${base}/login`, undefined, local), { url: `${base}/login` }, "a sign-in page saved on purpose is read, though its title says nothing");
    assert.ok(seen.every((request) => request.cookie === undefined && /Alfred link reader/.test(String(request.agent))));
  } finally { server.close(); server.closeAllConnections(); }
});

test("a compressed video head supplies its title, poster and duration even when the server ignores identity", async () => {
  const title = "[Agent记忆] 公开记忆架构";
  const html = `<meta property="og:title" content="${title}_哔哩哔哩_bilibili"><meta property="og:image" content="//i.example/poster.jpg">
    <meta property="og:image:secure_url" content="https://i.example/poster.jpg"><meta property="video:duration" content="204"><meta name="author" content="作者">`;
  const lookup: NonNullable<Parameters<typeof fetchPage>[2]> = (_host, _options, respond) => respond(null, [{ address: "127.0.0.1", family: 4 }]);
  const { base, server } = await site((req, res) => {
    const kind = req.url?.split("/").at(-1);
    const large = html + "x".repeat(2_000_000);
    res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": kind === "invalid" ? "gzip" : kind });
    res.end(kind === "gzip" ? gzipSync(large) : kind === "deflate" ? deflateSync(html) : kind === "br" ? brotliCompressSync(html) : Buffer.from("invalid"));
  });
  const host = base.replace("127.0.0.1", "www.bilibili.com");
  try {
    for (const coding of ["gzip", "br", "deflate"]) {
      const url = host + "/video/BV1example/" + coding;
      assert.deepEqual(await fetchPage(url, undefined, lookup), { url, title, author: "作者", cover: "https://i.example/poster.jpg", durationSeconds: 204 });
    }
    await assert.rejects(fetchPage(host + "/invalid", undefined, lookup), (e: PageFetchError) => e.code === "network");
    await assert.rejects(fetchPage(host + "/unknown", undefined, lookup), (e: PageFetchError) => e.code === "not_html");
  } finally { server.close(); server.closeAllConnections(); }
});

test("an icon is whatever image the page names, else /favicon.ico; what is not an image is never kept", async () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0]);
  assert.deepEqual([PNG, ICO, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), Buffer.from("<html><body>not an icon</body></html>"), Buffer.from("GIF89a..........")].map(imageType),
    ["image/png", "image/x-icon", "image/svg+xml", null, "image/gif"]);
  assert.deepEqual(readHead(`<link rel="icon" href="/favicon-32.png"><link rel='apple-touch-icon' href='/touch.png'><link rel="mask-icon" href="/mask.svg"><link rel="stylesheet" href="/a.css">`).icons,
    ["/touch.png", "/favicon-32.png"], "the touch icon first; a mask icon and a stylesheet are not icons");

  const { base, server } = await site((req, res) => {
    if (req.url === "/page") { res.writeHead(200, { "Content-Type": "text/html" }).end("<title>A page</title><link rel='icon' href='img/icon.png'>"); return; }
    if (req.url === "/img/icon.png") { res.writeHead(200, { "Content-Type": "image/png" }).end(PNG); return; }
    if (req.url === "/favicon.ico") { res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(ICO); return; }
    if (req.url === "/fake.png") { res.writeHead(200, { "Content-Type": "image/png" }).end("<html>sign in</html>"); return; }
    if (req.url === "/huge.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.write(PNG); res.end(Buffer.alloc(400_000)); return; }
    res.writeHead(404).end();
  });
  try {
    assert.deepEqual((await fetchPage(`${base}/page`, undefined, local)).icons, [`${base}/img/icon.png`], "written relative to the page");
    assert.deepEqual(await fetchIcon(`${base}/page`, [`${base}/img/icon.png`], undefined, local), { type: "image/png", bytes: PNG });
    // A candidate that is missing, too big, or not an image at all is passed over for the site's favicon.
    assert.equal((await fetchIcon(`${base}/page`, [`${base}/missing.png`, `${base}/huge.png`, `${base}/fake.png`], undefined, local))?.type, "image/x-icon");
  } finally { server.close(); server.closeAllConnections(); }
  // An icon address that points at this machine is refused like any other.
  assert.equal(await fetchIcon("https://example.invalid/page", ["http://127.0.0.1:1/icon.png"]), null);
});

test("a shared video cover is resolved against its page; only a bounded raster image is kept", async () => {
  assert.equal(readHead('<meta itemprop="duration" content="PT1H04M37S">').durationSeconds, 3877);
  assert.equal(readHead('<meta property="video:duration" content="-5">').durationSeconds, undefined);
  const { default: sharp } = await import("sharp");
  const jpeg = await sharp({ create: { width: 64, height: 36, channels: 3, background: "#c84" } }).jpeg().toBuffer();
  const { base, server } = await site((req, res) => {
    if (req.url === "/v/7") { res.end("<meta property='og:image' content='../cover.jpg'>"); return; }
    if (req.url === "/cover.jpg") { res.end(jpeg); return; }
    if (req.url === "/large") { res.write(jpeg); res.end(Buffer.alloc(4 * 1024 * 1024)); return; }
    res.end("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  });
  try {
    assert.equal((await fetchPage(`${base}/v/7`, undefined, local)).cover, `${base}/cover.jpg`);
    const cover = (await fetchCover(`${base}/cover.jpg`, undefined, local))!;
    assert.ok(["image/jpeg", "image/webp"].includes(cover.type) && cover.bytes.length <= jpeg.length);
    assert.deepEqual([(await sharp(cover.bytes).metadata()).width, (await sharp(cover.bytes).metadata()).height], [64, 36], "a small cover is not enlarged");
    for (const path of ["/large", "/vector"]) assert.equal(await fetchCover(base + path, undefined, local), null);
    assert.equal(await fetchCover(`${base}/cover.jpg`), null);
  } finally { server.close(); server.closeAllConnections(); }
});

test("a Xiaohongshu note is asked for as a phone, which it shows; anyone else is sent to its sign-in", async () => {
  const lookup: NonNullable<Parameters<typeof fetchPage>[2]> = (_host, _options, respond) => respond(null, [{ address: "127.0.0.1", family: 4 }]);
  const agents: string[] = [];
  const { base, server } = await site((req, res) => {
    agents.push(String(req.headers["user-agent"]));
    if (!/iPhone/.test(String(req.headers["user-agent"]))) { res.writeHead(302, { Location: "/login?redirectPath=x" }).end(); return; }
    if (req.url === "/explore/1") { res.writeHead(200, { "Content-Type": "text/html" }).end("<title>rednote (小红书) - global lifestyle hub</title>"); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<meta property="og:site_name" content="rednote">
      <meta property="og:title" content="手冲咖啡入门 - rednote"><meta property="og:description" content="三个参数就够">`);
  });
  const port = new URL(base).port;
  try {
    assert.deepEqual(await fetchPage(`http://www.xiaohongshu.com:${port}/explore/1?xsec_token=A`, undefined, lookup),
      { url: `http://www.xiaohongshu.com:${port}/explore/1?xsec_token=A`, title: "手冲咖啡入门", description: "三个参数就够" });
    assert.deepEqual(await fetchPage(`http://www.xiaohongshu.com:${port}/explore/1`, undefined, lookup), { url: `http://www.xiaohongshu.com:${port}/explore/1` },
      "without its token a note address lands on the front page, whose title is not the note's");
    assert.ok(agents.every((agent) => /iPhone/.test(agent) && /Alfred link reader/.test(agent)));
    assert.equal(looksLikeWall("小红书 - 你的生活指南"), true);
  } finally { server.close(); server.closeAllConnections(); }
});
