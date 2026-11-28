import assert from "node:assert/strict";
import { lookup as dnsLookup } from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { answerRequest, claimNextRun, CORE_MIGRATIONS, finishRun, getConversation, getRun, openRequest, openWorld, submitRun, withCoreContext, type RunToolContext, type World } from "@zirma/core";
import { exaQuery, parseExaText } from "../src/web/providers/exa.ts";
import { parseBocha } from "../src/web/providers/bocha.ts";
import { SearchError, type ReaderProvider, type SearchProvider, type SearchResult } from "../src/web/providers/index.ts";
import { parseBrave, stripHtml } from "../src/web/providers/brave.ts";
import { parseJina } from "../src/web/providers/jina.ts";
import { parseSearxng, searxng, searxngAddress } from "../src/web/providers/searxng.ts";
import { parseTavily } from "../src/web/providers/tavily.ts";
import { claudeSearch, deepseekQuery, parseClaude, parseDeepSeek, parseGemini, parseOpenAI } from "../src/web/providers/models.ts";
import { parseSerper } from "../src/web/providers/serper.ts";
import { parsePerplexity } from "../src/web/providers/perplexity.ts";
import { firecrawl, firecrawlReader, parseFirecrawlPage, parseFirecrawlSearch } from "../src/web/providers/firecrawl.ts";
import { connectorProvider, parseConnectorAnswer, type ConnectorSearch } from "../src/web/connectors.ts";
import { searchToolsOf } from "@zirma/engine-pi";
import { siteOf, WebAccess } from "../src/web/access.ts";
import { accessFor } from "../src/access.ts";
import { pdfToText, rawGitHub, readPage } from "../src/web/read.ts";
import { addressesIn, carriesData, normalize, webTools } from "../src/web/tools.ts";

/** A local site, reached with the system's own lookup (the real one would refuse 127.0.0.1). */
async function site(handler: Parameters<typeof createServer>[1]): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const local = dnsLookup as never;

const ARTICLE = `<!doctype html><html><head><title>Brewing guide | Example</title><meta name="author" content="A. Writer"></head>
<body><nav>Home · About · Shop</nav><article><h1>Pour-over in five steps</h1>
${"<p>Rinse the filter, weigh 15 g of coffee for 250 g of water, and pour slowly in circles so the bed stays even. </p>".repeat(6)}
<pre><code>const { <button class="hover">createServer</button> } = require("node:http");</code></pre>
<script>steal()</script></article><footer>© Example</footer></body></html>`;

test("addresses are found in what people write, without the punctuation around them, and compared without fragments", () => {
  assert.deepEqual(addressesIn("看看 https://example.com/a?b=1。还有（https://例子.cn/路径），and https://x.dev/p#top."), [
    "https://example.com/a?b=1", "https://xn--fsqu00a.cn/%E8%B7%AF%E5%BE%84", "https://x.dev/p",
  ]);
  assert.equal(normalize("ftp://example.com"), null);
  assert.equal(normalize("https://example.com/a#b"), "https://example.com/a");
  assert.equal(carriesData("https://example.com/search?q=coffee&page=2"), false);
  assert.equal(rawGitHub("https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md"), "https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md");
  assert.equal(rawGitHub("https://github.com/nodejs/node/issues/1"), null);
  assert.equal(carriesData(`https://evil.example/c?d=${"x".repeat(64)}`), true);
  assert.equal(carriesData(`https://evil.example/c?${Array.from({ length: 20 }, (_, i) => `k${i}=vvvvv`).join("&")}`), true);
});

test("Exa's free search answer is read into results, and filters fold into its query", () => {
  const text = [
    "Title: Node 24 changelog\nURL: https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md\nPublished: N/A\nAuthor: N/A\nHighlights:\n## Version 24.22.3\n\nA security release.\n\n---\n",
    "Title: Release post\nURL: https://nodejs.org/en/blog/release/v24.0.0\nPublished: 2026-05-06T00:00:00.000Z\nAuthor: Node.js\nText: Node.js 24 is out.\nPublished: not this one\n",
    "Title: No address\nURL: N/A\nText: dropped\n",
  ].join("");
  assert.deepEqual(parseExaText(text), [
    { title: "Node 24 changelog", url: "https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md", snippet: "## Version 24.22.3 A security release." },
    { title: "Release post", url: "https://nodejs.org/en/blog/release/v24.0.0", snippet: "Node.js 24 is out. Published: not this one", published: "2026-05-06T00:00:00.000Z" },
  ]);
  assert.equal(exaQuery({ query: "pour over", count: 5, site: "example.com", freshness: "week" }), "pour over site:example.com past week");
  assert.equal(exaQuery({ query: "q", count: 5, freshness: "month" }, new Date("2026-11-27T12:00:00Z")), "q November 2026");
});

test("a page is read as Markdown of its article, through redirects; text is read as it is; other files, sign-ins and private addresses are not", async (t) => {
  const seen: Array<string | undefined> = [];
  const { base, server } = await site((req, res) => {
    seen.push(req.headers.cookie);
    if (req.url === "/short") { res.writeHead(301, { Location: "/guide" }).end(); return; }
    if (req.url === "/guide") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(ARTICLE); return; }
    if (req.url === "/notes.txt") { res.writeHead(200, { "Content-Type": "text/plain" }).end("plain words\n"); return; }
    if (req.url === "/paper.pdf") { res.writeHead(200, { "Content-Type": "application/pdf" }).end("%PDF"); return; }
    if (req.url === "/members") { res.writeHead(302, { Location: "/login?next=/members" }).end(); return; }
    res.writeHead(404).end();
  });
  t.after(() => server.close());
  const page = await readPage(`${base}/short`, { lookup: local });
  assert.equal(page.url, `${base}/guide`);
  assert.equal(page.title, "Brewing guide | Example");
  assert.equal(page.author, "A. Writer");
  assert.match(page.text, /^## Pour-over in five steps/);
  assert.match(page.text, /weigh 15 g of coffee/);
  assert.match(page.text, /const \{ createServer \} = require/);
  assert.doesNotMatch(page.text, /steal\(\)|Home · About/);
  assert.deepEqual(await readPage(`${base}/notes.txt`, { lookup: local }), { url: `${base}/notes.txt`, text: "plain words" });
  await assert.rejects(readPage(`${base}/paper.pdf`, { lookup: local }), { code: "not_html" });
  await assert.rejects(readPage(`${base}/members`, { lookup: local }), { code: "login" });
  await assert.rejects(readPage(`${base}/missing`, { lookup: local }), { code: "status" });
  await assert.rejects(readPage(`${base}/guide`), { code: "private" });
  assert.ok(seen.every((cookie) => cookie === undefined));
});

/** A world with one running turn whose message is `goal`, after an earlier turn whose message was `earlier`. */
function turn(t: { after(fn: () => void): void }, goal: string, earlier?: string): { world: World; run: string } {
  const world = openWorld(":memory:", CORE_MIGRATIONS);
  t.after(() => world.close());
  let conversationId: string | undefined;
  if (earlier) {
    const first = submitRun(world, { requestId: "first", goal: earlier, profile: "assistant" }).run;
    conversationId = first.conversationId;
    claimNextRun(world, "home");
    finishRun(world, first.id, "home", { status: "completed", reply: "ok" });
  }
  const run = submitRun(world, { requestId: "now", goal, profile: "assistant", ...(conversationId ? { conversationId } : {}) }).run;
  claimNextRun(world, "home");
  return { world, run: run.id };
}

function provider(id: string, results: SearchResult[], options: { fail?: SearchError; needs?: SearchProvider["needs"]; seen?: Array<string | null> } = {}): SearchProvider {
  return {
    id, title: id.toUpperCase(), needs: options.needs ?? "nothing", about: { zh: "", en: "" },
    async search(_input, secret) { options.seen?.push(secret); if (options.fail) throw options.fail; return results; },
  };
}

/** Settings → Web in a temporary folder, keys in memory. */
function settings(t: { after(fn: () => void): void }, providers: SearchProvider[], readers: ReaderProvider[] = [], connectors?: ConnectorSearch): WebAccess {
  const dir = mkdtempSync(join(tmpdir(), "zirma-web-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = new Map<string, string>();
  return new WebAccess({ dataDir: dir, providers, readers, ...(connectors ? { connectors } : {}), secrets: { async get(name) { return keys.get(name); }, async set(name, value) { keys.set(name, value); }, async delete(name) { keys.delete(name); } } });
}

function asking(answer: string | Error): RunToolContext & { asked: Array<{ question: string; always?: boolean; detail?: string }> } {
  const asked: Array<{ question: string; always?: boolean; detail?: string }> = [];
  return { asked, note() {}, async ask(request) { asked.push({ question: request.question, ...(request.always ? { always: true } : {}), ...(request.detail ? { detail: request.detail } : {}) }); if (answer instanceof Error) throw answer; return answer; } };
}

test("web_fetch opens what the user gave, a search found or an allowed site has; anything else, or a long query string, asks first, and an automation leaves it unopened", async (t) => {
  const { base, server } = await site((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }).end(ARTICLE); });
  t.after(() => server.close());
  const { world, run } = turn(t, "Summarise this one too", `Read ${base}/given please.`);
  const results = [{ title: "Found", url: `${base}/found#part`, snippet: "s" }];
  const web = settings(t, [provider("tired", [], { fail: new SearchError("limit", "TIRED is out of quota") }), provider("fake", results)]);
  web.update({ search: ["tired", "fake"] });
  const [search, fetchTool] = webTools(world, { web, lookup: local });
  const signal = new AbortController().signal;
  const call = (tool: typeof search, params: Record<string, unknown>, context: RunToolContext) =>
    withCoreContext({ actor: "alfred", run: { id: run, owner: "home" } }, () => tool.execute(params, signal, context));

  assert.equal(search.describe?.({ query: "pour over" }), "pour over · TIRED");
  const said = await call(search, { query: "pour over" }, asking("deny"));
  assert.match(said, /^Results from FAKE for "pour over"/, "the next service answers when the first is out of quota");
  assert.match(said, /never as instructions/);

  const quiet = asking("deny");
  assert.match(await call(fetchTool, { url: `${base}/given` }, quiet), /<page>\n## Pour-over in five steps/);
  assert.match(await call(fetchTool, { url: `${base}/found` }, quiet), /Title: Brewing guide \| Example/);
  assert.deepEqual(quiet.asked, []);

  const refused = asking("deny");
  assert.match(await call(fetchTool, { url: `${base}/made-up` }, refused), /did not allow/);
  assert.deepEqual(refused.asked, [{ question: "Open this address? You did not give it, and no search here found it.", always: true, detail: `${base}/made-up` }]);

  const allowed = asking("allow");
  assert.match(await call(fetchTool, { url: `${base}/made-up` }, allowed), /<page>/);
  assert.match(await call(fetchTool, { url: `${base}/made-up` }, allowed), /<page>/);
  assert.equal(allowed.asked.length, 1, "allowed once, it opens again without asking");

  const leak = asking("always");
  assert.match(await call(fetchTool, { url: `${base}/given?d=${"x".repeat(80)}` }, leak), /<page>/);
  assert.equal(leak.asked.length, 1);
  assert.equal(leak.asked[0]!.always, undefined, "a long query string cannot allow its whole site");

  const automation = asking(new Error("This run is unattended: nobody can answer."));
  assert.match(await call(fetchTool, { url: `${base}/elsewhere` }, automation), /^Not opened: .*left unopened/);

  assert.deepEqual(web.records().map((entry) => [entry.kind, entry.provider ?? null]), [
    ["open", null], ["open", null], ["open", null], ["open", null], ["open", null], ["search", "fake"],
  ]);
  assert.deepEqual(web.today(), { fake: 1 });
});

test("Settings → Web: services in order, keys kept apart, one that needs a key left out without it; sites cover their subdomains", async (t) => {
  const seen: Array<string | null> = [];
  const web = settings(t, [provider("free", [], { seen }), provider("keyed", [], { needs: "key", seen })]);
  assert.deepEqual(web.config(), { on: true, search: [], read: [], sites: [], addresses: {} }, "the default services are not among these");
  web.update({ search: ["keyed", "free"] });
  assert.deepEqual((await web.order()).map((entry) => entry.provider.id), ["free"]);
  await web.setKey("keyed", " k-123 ");
  assert.deepEqual((await web.order()).map((entry) => [entry.provider.id, entry.secret]), [["keyed", "k-123"], ["free", null]]);
  await assert.rejects(web.setKey("keyed", "two words"), /one word/);
  assert.throws(() => web.update({ search: ["nope"] }), /known services/);
  assert.throws(() => web.update({ sites: ["not a host"] }), /host name/);
  web.allowSite("https://www.Docs.Example.com/guide?x=1");
  assert.deepEqual(web.config().sites, ["docs.example.com"]);
  assert.equal(web.allowed("https://api.docs.example.com/v1"), true);
  assert.equal(web.allowed("https://example.com/"), false);
  assert.equal(web.allowed("https://evildocs.example.com.attacker.dev/"), false);
  assert.equal(siteOf("https://github.com/nodejs/node"), "github.com");
  await web.deleteKey("keyed");
  assert.deepEqual((await web.order()).map((entry) => entry.provider.id), ["free"]);
  web.clearRecords();
  assert.deepEqual(web.records(), []);
});

test("博查's answer is read into results, and a site is kept to itself", () => {
  const answer = { code: 200, data: { webPages: { value: [
    { name: "手冲咖啡入门", url: "https://www.example.cn/coffee", summary: "研磨度 中细\n水温 92 度", datePublished: "2026-11-01T08:00:00+08:00" },
    { name: "别处", url: "https://other.cn/x", snippet: "s" },
    { name: "没有地址" },
  ] } } };
  assert.deepEqual(parseBocha(answer), [
    { title: "手冲咖啡入门", url: "https://www.example.cn/coffee", snippet: "研磨度 中细 水温 92 度", published: "2026-11-01T08:00:00+08:00" },
    { title: "别处", url: "https://other.cn/x", snippet: "s" },
  ]);
  assert.deepEqual(parseBocha(answer, "example.cn").map((result) => result.url), ["https://www.example.cn/coffee"]);
  assert.throws(() => parseBocha({ code: 403, msg: "余额不足" }), /余额不足/);
});

test("web_search says why when every service fails", async (t) => {
  const { world, run } = turn(t, "search something");
  const web = settings(t, [provider("tired", [], { fail: new SearchError("limit", "TIRED is out of quota") })]);
  web.update({ search: ["tired"] });
  const [search] = webTools(world, { web });
  await assert.rejects(
    async () => withCoreContext({ actor: "alfred", run: { id: run, owner: "home" } }, () => search.execute({ query: "x" }, new AbortController().signal, asking("deny"))),
    /Searching failed: TIRED is out of quota/,
  );
});

test("answering \"always\" to a web address allows its site, and changes nothing about the conversation", (t) => {
  const { world, run } = turn(t, "open it");
  const before = getConversation(world, getRun(world, run).run.conversationId);
  const asked = openRequest(world, run, "home", { kind: "permission", question: "Open this address?", detail: "https://docs.example.com/a", detailKind: "site", always: true, grant: "docs.example.com" });
  assert.deepEqual(asked.options, ["allow", "deny", "always"]);
  assert.equal(asked.detailKind, "site");
  withCoreContext({ actor: "user" }, () => answerRequest(world, run, { requestId: asked.id, answer: "always" }));
  assert.equal(getConversation(world, before.id).mode, before.mode);
});

test("Settings → Web is reached only from this machine: it holds keys", () => {
  for (const [method, path] of [["GET", "/api/web"], ["POST", "/api/web"], ["POST", "/api/web/keys/bocha"], ["POST", "/api/web/test/exa"], ["POST", "/api/web/records/clear"]] as const) {
    assert.equal(accessFor(method, path), "local", `${method} ${path}`);
  }
});

test("Tavily, Brave and SearXNG answers are read into results; Brave's marks are taken out; a site is kept to itself", () => {
  assert.deepEqual(parseTavily({ results: [
    { title: "Pour-over", url: "https://example.com/a", content: "Rinse  the\nfilter", published_date: "2026-11-02" },
    { title: "No address" },
  ] }), [{ title: "Pour-over", url: "https://example.com/a", snippet: "Rinse the filter", published: "2026-11-02" }]);
  assert.throws(() => parseTavily({ detail: "x" }), /cannot read/);

  assert.equal(stripHtml("<strong>Pour</strong>-over &amp; grind&#39;s &hellip;"), "Pour-over & grind's …");
  const brave = { web: { results: [
    { title: "<strong>Coffee</strong>", url: "https://docs.example.com/c", description: "Water &lt;95&deg;", page_age: "2026-10-01" },
    { title: "Elsewhere", url: "https://other.org/" },
  ] } };
  assert.deepEqual(parseBrave(brave), [
    { title: "Coffee", url: "https://docs.example.com/c", snippet: "Water <95°", published: "2026-10-01" },
    { title: "Elsewhere", url: "https://other.org/", snippet: "" },
  ]);
  assert.deepEqual(parseBrave(brave, "example.com").map((result) => result.url), ["https://docs.example.com/c"]);
  assert.deepEqual(parseBrave({ query: { original: "x" } }), [], "no web results at all is an empty list");

  assert.deepEqual(parseSearxng({ results: [{ title: "T", url: "https://example.com/s", content: "c", publishedDate: "2026-11-03" }, { url: "ftp://x" }] }),
    [{ title: "T", url: "https://example.com/s", snippet: "c", published: "2026-11-03" }]);
  assert.equal(searxngAddress("localhost:8080/search?q=x"), "http://localhost:8080");
  assert.equal(searxngAddress("https://search.example.org/searx/"), "https://search.example.org/searx");
  assert.equal(searxngAddress("https://user:pw@search.example.org"), null);
  assert.equal(searxngAddress("ftp://search.example.org"), null);
});

test("SearXNG without its JSON answer says how to switch it on", async (t) => {
  const { base, server } = await site((req, res) => {
    if (req.url?.includes("format=json") && req.url.includes("q=on")) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results: [{ title: "Hit", url: "https://example.com/hit", content: "c" }] }));
    else res.writeHead(403).end("Forbidden");
  });
  t.after(() => server.close());
  const signal = new AbortController().signal;
  assert.deepEqual((await searxng.search({ query: "on", count: 5 }, base, signal)).map((result) => result.url), ["https://example.com/hit"]);
  await assert.rejects(async () => searxng.search({ query: "off", count: 5 }, `${base}/search`, signal), /add json under search: formats:/);
  await assert.rejects(async () => searxng.search({ query: "on", count: 5 }, null, signal), /no address/);
});

test("Settings → Web: a service the user runs needs its address; reading services keep their own order; a used-up service goes last for the day", async (t) => {
  const seen: Array<string | null> = [];
  const own = provider("searxng", [], { needs: "address", seen });
  const web = settings(t, [provider("free", []), own], [reader("reader", "x".repeat(300))]);
  web.update({ search: ["searxng", "free"], read: ["reader"] });
  assert.deepEqual((await web.order()).map((entry) => entry.provider.id), ["free"], "no address, left out");
  assert.throws(() => web.setAddress("free", "http://localhost:8080"), /takes no address/);
  assert.throws(() => web.setAddress("searxng", "ftp://x"), /http or https/);
  web.setAddress("searxng", "localhost:8888/");
  assert.deepEqual((await web.order()).map((entry) => [entry.provider.id, entry.secret]), [["searxng", "http://localhost:8888"], ["free", null]]);
  web.markLimited("searxng");
  assert.deepEqual((await web.order()).map((entry) => entry.provider.id), ["free", "searxng"]);
  assert.equal(web.limitedToday("searxng", new Date(Date.now() + 86_400_000)), false, "tomorrow it is tried first again");
  assert.deepEqual((await web.readerOrder()).map((entry) => entry.reader.id), ["reader"]);
  assert.throws(() => web.update({ read: ["free"] }), /known services/);
  web.setAddress("searxng", "");
  assert.deepEqual(web.config().addresses, {});
});

function reader(id: string, text: string, seen?: string[]): ReaderProvider {
  return { id, title: id.toUpperCase(), needs: "nothing", about: { zh: "", en: "" }, async read(url) { seen?.push(url); return { title: "Read elsewhere", text }; } };
}

test("web_fetch hands a page Zirma cannot read to the reading service, never one whose address carries data", async (t) => {
  const { base, server } = await site((req, res) => {
    if (req.url?.startsWith("/blocked")) res.writeHead(403).end("no robots");
    else res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body><div id=app></div><script>render()</script></body></html>");
  });
  t.after(() => server.close());
  const { world, run } = turn(t, "Read these", `Read ${base}/app and ${base}/blocked and ${base}/app?d=${"y".repeat(80)}`);
  const handed: string[] = [];
  const web = settings(t, [], [reader("reader", `Rendered ${"text ".repeat(60)}`, handed)]);
  web.update({ read: ["reader"] });
  const [, fetchTool] = webTools(world, { web, lookup: local });
  const call = (url: string, context = asking("allow")) => withCoreContext({ actor: "alfred", run: { id: run, owner: "home" } }, () => fetchTool.execute({ url }, new AbortController().signal, context));

  const scripted = await call(`${base}/app`);
  assert.match(scripted, /Read through: READER/);
  assert.match(scripted, /<page>\nRendered text/);
  assert.match(await call(`${base}/blocked`), /Read through: READER/);
  const data = await call(`${base}/app?d=${"y".repeat(80)}`);
  assert.match(data, /almost no text/, "an address with data is not handed on");
  assert.deepEqual(handed, [`${base}/app`, `${base}/blocked`]);
  assert.deepEqual(web.records().slice(0, 3).map((entry) => entry.provider ?? null), [null, "reader", "reader"]);

  web.update({ read: [] });
  assert.match(await call(`${base}/blocked`), /^Not read: The page is behind a sign-in/);
});

test("Jina's answer is read as Markdown, and a page still loading counts as not read", () => {
  assert.deepEqual(parseJina({ code: 200, data: { title: " Docs ", url: "https://x", content: "# Docs\n\nBody" } }), { title: "Docs", text: "# Docs\n\nBody" });
  assert.deepEqual(parseJina({ data: { content: "Loading..." } }), { title: null, text: "" });
  assert.throws(() => parseJina({ code: 451 }), /cannot read/);
});

test("a connector's search tool: found by its name and its query field, called with the query, its answer read however it comes", async (t) => {
  const tools = searchToolsOf("exa", [
    { name: "web_search_exa", description: "Search  the web", inputSchema: { type: "object", properties: { query: { type: "string" }, numResults: { type: "number" } }, required: ["query"] } },
    { name: "crawling", inputSchema: { properties: { url: { type: "string" } } } },
    { name: "search_with_filters", inputSchema: { properties: { query: { type: "string" }, region: { type: "string" } }, required: ["query", "region"] } },
    { name: "search_paged", inputSchema: { properties: { query: { type: "string" }, page: { type: "integer" } }, required: ["query", "page"] } },
    { name: "deep_search", inputSchema: { properties: { topic: { type: "string" } }, required: ["topic"] } },
  ]);
  assert.deepEqual(tools, [
    { server: "exa", tool: "web_search_exa", description: "Search the web", query: "query", count: "numResults" },
    { server: "exa", tool: "search_with_filters", description: "", query: "query", also: ["region"] },
    { server: "exa", tool: "deep_search", description: "", query: "topic" },
  ]);

  assert.deepEqual(parseConnectorAnswer({ text: "", structured: { data: { results: [{ title: "S", link: "https://example.com/s", description: "d" }] } } }),
    [{ title: "S", url: "https://example.com/s", snippet: "d" }]);
  assert.deepEqual(parseConnectorAnswer({ text: JSON.stringify([{ name: "J", url: "https://example.com/j", content: "c" }]) }),
    [{ title: "J", url: "https://example.com/j", snippet: "c" }]);
  const text = parseConnectorAnswer({ text: "Title: First\nURL: https://example.com/1\nText: one\n\nSee [Second](https://example.com/2). More words.\n\nhttps://example.com/1 again" });
  assert.deepEqual(text.map((result) => [result.title, result.url]), [["First", "https://example.com/1"], ["Second", "https://example.com/2"]]);

  const calls: Array<[string, string, Record<string, unknown>]> = [];
  const source: ConnectorSearch = {
    async searchTools() { return tools; },
    async callTool(server, tool, args) { calls.push([server, tool, args]); return { text: "Title: Hit\nURL: https://example.com/hit\nText: t", isError: false }; },
  };
  const web = settings(t, [provider("free", [])], [], source);
  web.update({ search: ["mcp:exa:web_search_exa", "mcp:gone:search", "free"] });
  assert.deepEqual((await web.order()).map((entry) => entry.provider.id), ["mcp:exa:web_search_exa", "free"], "a connector that is away is skipped");
  assert.deepEqual((await web.test("mcp:exa:search_with_filters", "pour over")).results.length, 1);
  assert.deepEqual((await web.test("mcp:exa:web_search_exa", "pour over")).results.map((result) => result.url), ["https://example.com/hit"]);
  assert.deepEqual(calls, [["exa", "search_with_filters", { region: "pour over", query: "pour over" }], ["exa", "web_search_exa", { query: "pour over", numResults: 3 }]]);
  const failing = connectorProvider({ ...source, async callTool() { return { text: "Rate limit exceeded", isError: true }; } }, tools[0]!);
  await assert.rejects(async () => failing.search({ query: "x", count: 3 }, null, new AbortController().signal), (error) => error instanceof SearchError && error.code === "limit");
  assert.throws(() => web.update({ search: ["mcp:bad name:x"] }), /known services/);
});

test("Serper, Perplexity and Firecrawl answers are read into results; Serper keeps a site to itself; Firecrawl says why it failed", () => {
  assert.deepEqual(parseSerper({ organic: [
    { title: "Docs", link: "https://docs.example.com/a", snippet: "  one\n two ", date: "2 days ago" },
    { title: "Elsewhere", link: "https://other.org/b", snippet: "x" },
    { title: "No link" },
  ] }, "example.com"), [{ title: "Docs", url: "https://docs.example.com/a", snippet: "one two", published: "2 days ago" }]);
  assert.throws(() => parseSerper({ results: [] }), SearchError);

  assert.deepEqual(parsePerplexity({ results: [{ title: "", url: "https://a.example/x", snippet: "s", date: "2026-11-20" }, { url: "ftp://x" }] }),
    [{ title: "https://a.example/x", url: "https://a.example/x", snippet: "s", published: "2026-11-20" }]);

  assert.deepEqual(parseFirecrawlSearch({ success: true, data: { web: [
    { url: "https://a.example/x", title: "A", description: "about a" },
    { url: "https://a.example/x", title: "Again" },
    { metadata: { sourceURL: "https://b.example/y", title: "B" } },
  ] } }), [{ title: "A", url: "https://a.example/x", snippet: "about a" }, { title: "B", url: "https://b.example/y", snippet: "" }]);
  assert.deepEqual(parseFirecrawlPage({ success: true, data: { markdown: " # Hi\n\ntext ", metadata: { title: "Hi" } } }), { title: "Hi", text: "# Hi\n\ntext" });
  assert.throws(() => parseFirecrawlSearch({ success: false, error: "Insufficient credits" }), /Insufficient credits/);
});

test("Firecrawl's reading side uses the key given for its search, and is left out without one", async (t) => {
  const web = settings(t, [firecrawl], [firecrawlReader]);
  web.update({ read: ["firecrawl-read"] });
  assert.deepEqual(await web.readerOrder(), []);
  await web.setKey("firecrawl", "fc-123");
  assert.equal(await web.key("firecrawl-read"), "fc-123");
  assert.deepEqual((await web.readerOrder()).map((entry) => [entry.reader.id, entry.secret]), [["firecrawl-read", "fc-123"]]);
  await web.deleteKey("firecrawl-read");
  assert.equal(await web.key("firecrawl"), null);
});

/** A one-page PDF saying `words`, with a title in its details. */
function tinyPdf(words: string, title: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    (() => { const stream = `BT /F1 18 Tf 20 70 Td (${words}) Tj ET`; return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`; })(),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${title}) >>`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const at = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("a PDF is read page by page, titled by its own details, else by its file name; a broken one says so", async () => {
  const page = await pdfToText(tinyPdf("Hello from a PDF", "A Small Report"), new URL("https://example.com/files/q3_report.pdf"));
  assert.equal(page.title, "A Small Report");
  assert.match(page.text, /<!-- Page 1 -->\nHello from a PDF/);
  const untitled = await pdfToText(tinyPdf("Hi", ""), new URL("https://example.com/files/q3_report.pdf"));
  assert.equal(untitled.title, "q3 report");
  await assert.rejects(pdfToText(Buffer.from("not a pdf"), new URL("https://example.com/x.pdf")), /could not be opened/);
});

test("searching with a model's key: Claude's results and excerpts, OpenAI's citations and sources, Gemini's grounding, DeepSeek's results", () => {
  assert.deepEqual(parseClaude([
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [
      { type: "web_search_result", url: "https://a.example/x", title: "A", page_age: "2 days ago", encrypted_content: "…" },
      { type: "web_search_result", url: "https://b.example/y", title: "B", page_age: null, encrypted_content: "…" },
    ] },
    { type: "text", text: "A says so.", citations: [{ type: "web_search_result_location", url: "https://a.example/x", title: "A", cited_text: "  what A\n says ", encrypted_index: "…" }] },
  ]), [
    { title: "A", url: "https://a.example/x", snippet: "what A says", published: "2 days ago" },
    { title: "B", url: "https://b.example/y", snippet: "" },
  ]);
  assert.throws(() => parseClaude([{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }]), (error: unknown) => error instanceof SearchError && error.code === "limit");

  assert.deepEqual(parseOpenAI({ output: [
    { type: "web_search_call", action: { type: "search", sources: [{ type: "url", url: "https://b.example/y" }, { type: "url", url: "https://a.example/x" }] } },
    { type: "message", content: [{ type: "output_text", text: "Lead. A explains it.", annotations: [{ type: "url_citation", url: "https://a.example/x", title: "A", start_index: 20, end_index: 30 }] }] },
  ] }), [
    { title: "A", url: "https://a.example/x", snippet: "Lead. A explains it." },
    { title: "https://b.example/y", url: "https://b.example/y", snippet: "" },
  ]);

  assert.deepEqual(parseGemini({ candidates: [{ content: { parts: [{ text: "x" }] }, groundingMetadata: {
    groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "a.example" } }, { web: { uri: "https://b.example/y", title: "b.example" } }],
    groundingSupports: [{ segment: { text: "B said this." }, groundingChunkIndices: [1] }],
  } }] }), [
    { title: "a.example", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", snippet: "" },
    { title: "b.example", url: "https://b.example/y", snippet: "B said this." },
  ]);

  assert.deepEqual(parseDeepSeek({ results: [{ title: "C", url: "https://c.example/z", summary: "sum", snippet: "snip" }, { title: "No address" }] }), [{ title: "C", url: "https://c.example/z", snippet: "sum" }]);
  const long = "字".repeat(200);
  const query = deepseekQuery({ query: long, count: 5, site: "example.com", freshness: "week" }, Date.UTC(2026, 10, 28));
  assert.equal([...query].length, 128);
  assert.match(query, / site:example\.com after:2026-11-21$/);
});

test("a service that searches with a model's key is used only while Models has a plain key for that provider", async (t) => {
  const keys = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), "zirma-web-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const web = new WebAccess({ dataDir: dir, providers: [claudeSearch], secrets: { async get() { return undefined; }, async set() {}, async delete() {} }, modelKeys: { async apiKey(provider) { return keys.get(provider) ?? null; } } });
  web.update({ search: ["anthropic"] });
  assert.deepEqual(await web.order(), []);
  keys.set("anthropic", "sk-ant-test");
  assert.deepEqual((await web.order()).map((entry) => [entry.provider.id, entry.secret]), [["anthropic", "sk-ant-test"]]);
});
