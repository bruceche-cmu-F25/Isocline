/** The library and its index (docs/research/notes-editor.md §4, tests 4b, 5, 9 and 10; notes-two-layers.md 4.6):
 * saves never write over a file that changed, a rename takes its links along and says which it could not, short
 * Chinese words are found, and a change can be taken back while its lines are as it left them. Every library is a
 * temporary folder of made-up pages. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_MIGRATIONS, openWorld, type World } from "@zirma/core";
import { invokeOp, runQuery } from "@zirma/module-kit";
import {
  createNotesModule, fingerprint, flipHistory, indexLibrary, Library, listHistory, pageDetail, savePage, searchPages, swapBack, ZIRMA_DIR,
  type NotesSnapshot, type PageDetail,
} from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "zirma-notes-test-"));
  const module = createNotesModule({ defaultRoot: root });
  const world: World = openWorld(":memory:", [...CORE_MIGRATIONS, ...module.migrations]);
  const { library, id } = module.library(world);
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, `${path}.md`), text); };
  const index = () => indexLibrary(world, library);
  let n = 0;
  const op = (name: string, input: unknown) => invokeOp(world, [module], { op: name, requestId: `r${++n}`, input }).result as Record<string, unknown>;
  const query = <T>(name: string, input: unknown) => runQuery([module], world, name, input) as T;
  return { root, module, world, library, libraryId: id, write, index, op, query };
}

test("a new library is the folder, Zirma's layer in it, and a .gitignore for About you", () => {
  const { root } = setup();
  assert.ok(existsSync(join(root, ZIRMA_DIR)));
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /zirma_notes\/关于你\.md/);
});

test("the index lists pages in pages, folders as pages, skips hidden things, and resolves alias links", () => {
  const { write, index, world, module, root } = setup();
  write("手冲", "---\nicon: cup\n---\n周末在家冲咖啡的记录。\n");
  write("手冲/V60 参数", "水温 92 度。见 [[项目|别名]] 和 [[手冲]]。\n");
  write("项目", "# 项目\n");
  mkdirSync(join(root, "只有文件夹/里面"), { recursive: true });
  writeFileSync(join(root, "只有文件夹/里面/一页.md"), "x\n");
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian/workspace.md"), "hidden\n");
  write(`${ZIRMA_DIR}/咖啡`, "- 常用 V60（[[V60 参数]]）\n");
  index();
  const snapshot = module.snapshot!(world) as NotesSnapshot;
  const byId = new Map(snapshot.pages.map((page) => [page.id, page]));
  assert.deepEqual([...byId.keys()].sort(), ["手冲", "手冲/V60 参数", "只有文件夹", "只有文件夹/里面", "只有文件夹/里面/一页", "项目", `${ZIRMA_DIR}/咖啡`].sort());
  assert.equal(byId.get("手冲/V60 参数")!.parent, "手冲");
  assert.equal(byId.get("手冲")!.icon, "cup");
  assert.equal(byId.get("只有文件夹")!.file, false);
  assert.equal(byId.get(`${ZIRMA_DIR}/咖啡`)!.zirma, true);
  assert.equal(byId.get(`${ZIRMA_DIR}/咖啡`)!.parent, null);
  // The link with an alias is a mention of 项目; Zirma's page mentions V60 参数, listed after the user's own.
  const detail = (id: string) => runQuery([module], world, "note.page", { id }) as PageDetail;
  assert.deepEqual(detail("项目").mentions.map((page) => page.id), ["手冲/V60 参数"]);
  assert.deepEqual(detail("手冲").mentions.map((page) => page.id), ["手冲/V60 参数"]);
  assert.deepEqual(detail("手冲/V60 参数").mentions.map((page) => page.id), [`${ZIRMA_DIR}/咖啡`]);
});

test("10. two-character Chinese words are found; longer ones use the index", () => {
  const { write, index, world } = setup();
  write("周会", "今天的会议记录：许可证对比。\n");
  write("Reading", "Chapter one is about two systems.\n");
  index();
  assert.deepEqual(searchPages(world, "会议").map((hit) => hit.id), ["周会"]);
  assert.deepEqual(searchPages(world, "会议记").map((hit) => hit.id), ["周会"]);
  assert.equal(searchPages(world, "会议记").length, 1);
  assert.deepEqual(searchPages(world, "two systems").map((hit) => hit.id), ["Reading"]);
  assert.deepEqual(searchPages(world, "周会").map((hit) => hit.id), ["周会"], "titles are searched");
  assert.equal(searchPages(world, "100%_").length, 0, "LIKE wildcards are words");
  assert.equal(searchPages(world, "\"quote").length, 0);
});

test("5a. a save from a file that changed since is refused, and the file on disk is not replaced", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "原来的\n");
  index();
  const opened = library.read("页")!;
  writeFileSync(join(library.root, "页.md"), "别处改了\n");
  const answer = savePage(world, library, libraryId, { library: libraryId, id: "页", base: opened.fp, text: "我改的\n" });
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && answer.reason === "changed" && answer.current?.text === "别处改了\n");
  assert.equal(readFileSync(join(library.root, "页.md"), "utf8"), "别处改了\n");
});

test("5b. two saves from the same version: the first goes in, the second is refused", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "v0\n");
  index();
  const base = library.read("页")!.fp;
  const first = savePage(world, library, libraryId, { library: libraryId, id: "页", base, text: "phone\n" });
  const second = savePage(world, library, libraryId, { library: libraryId, id: "页", base, text: "desktop\n" });
  assert.ok(first.ok);
  assert.ok(!second.ok && second.reason === "changed");
  assert.equal(readFileSync(join(library.root, "页.md"), "utf8"), "phone\n");
});

test("5c. three autosaves in a row, each from the last one's fingerprint, all go in", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "a\n");
  index();
  let base: string = library.read("页")!.fp;
  for (const text of ["ab\n", "abc\n", "abcd\n"]) {
    const answer = savePage(world, library, libraryId, { library: libraryId, id: "页", base, text });
    assert.ok(answer.ok);
    base = answer.fp;
  }
  assert.equal(readFileSync(join(library.root, "页.md"), "utf8"), "abcd\n");
  assert.equal(listHistory(world, "页").length, 1, "saves close together are one change");
});

test("5d. after the library changed, a late save meant for the old one is refused, even for the same path", () => {
  const { write, index, world, library, libraryId, op } = setup();
  write("页", "same\n");
  index();
  const base = library.read("页")!.fp;
  const other = mkdtempSync(join(tmpdir(), "zirma-notes-other-"));
  writeFileSync(join(other, "页.md"), "same\n");
  const changed = op("note.library", { root: other });
  assert.notEqual(changed.id, libraryId);
  const late = savePage(world, new Library(other), changed.id as string, { library: libraryId, id: "页", base, text: "late\n" });
  assert.ok(!late.ok && late.reason === "library");
  assert.equal(readFileSync(join(other, "页.md"), "utf8"), "same\n");
});

test("5e. another app writing in the very moment of a save: its version is kept aside, and the save is reported", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "v0\n");
  index();
  const base = library.read("页")!.fp;
  const answer = savePage(world, library, libraryId, { library: libraryId, id: "页", base, text: "mine\n" }, {
    beforeSwap: () => writeFileSync(join(library.root, "页.md"), "obsidian wrote this\n"),
  });
  assert.ok(!answer.ok && answer.reason === "changed");
  assert.equal(answer.ok === false && answer.reason === "changed" && answer.current?.text, "obsidian wrote this\n");
  const kept = readdirSync(join(library.root, ".trash/.versions"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(library.root, ".trash/.versions", kept[0]), "utf8"), "obsidian wrote this\n", "their words are not lost");
});

test("an ordinary save leaves nothing behind in .trash/.versions", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "v0\n");
  index();
  const answer = savePage(world, library, libraryId, { library: libraryId, id: "页", base: library.read("页")!.fp, text: "v1\n" });
  assert.ok(answer.ok);
  assert.ok(!existsSync(join(library.root, ".trash/.versions")) || readdirSync(join(library.root, ".trash/.versions")).length === 0);
});

test("Zirma's layer cannot be written by a save from the editor", () => {
  const { write, index, world, library, libraryId } = setup();
  write(`${ZIRMA_DIR}/咖啡`, "- x\n");
  index();
  const answer = savePage(world, library, libraryId, { library: libraryId, id: `${ZIRMA_DIR}/咖啡`, base: library.read(`${ZIRMA_DIR}/咖啡`)!.fp, text: "mine now\n" });
  assert.ok(!answer.ok && answer.reason === "zirma");
});

test("paths that would leave the library are refused", () => {
  const { library } = setup();
  for (const bad of ["../escape", "a/../../b", ".obsidian/x", "/abs", "a//b"]) assert.throws(() => library.file(bad), /library|Outside/, bad);
});

test("9. a rename takes the links along; a page being changed elsewhere is skipped and named", () => {
  const { write, index, world, library, op } = setup();
  write("旧名", "内容\n");
  write("甲", "看 [[旧名]] 和 [[旧名|别名]] 还有 [[旧名#小节]]。\n");
  write("乙", "也提到 ![[旧名]]。\n");
  write("丙", "还有 [[旧名]]。\n");
  index();
  // 丙 changes on disk after the index read it: the rename must not write over it.
  const realSave = Library.prototype.save;
  Library.prototype.save = function (this: Library, id, base, text, hooks) {
    if (id === "丙") writeFileSync(join(library.root, "丙.md"), "别处刚改：[[旧名]]\n");
    return realSave.call(this, id, base, text, hooks);
  };
  let result: Record<string, unknown>;
  try { result = op("note.move", { id: "旧名", title: "新名" }); } finally { Library.prototype.save = realSave; }
  assert.equal(result.id, "新名");
  assert.deepEqual((result.changed as string[]).sort(), ["乙", "甲"]);
  assert.deepEqual(result.skipped, ["丙"]);
  assert.equal(readFileSync(join(library.root, "甲.md"), "utf8"), "看 [[新名]] 和 [[新名|别名]] 还有 [[新名#小节]]。\n");
  assert.equal(readFileSync(join(library.root, "乙.md"), "utf8"), "也提到 ![[新名]]。\n");
  assert.equal(readFileSync(join(library.root, "丙.md"), "utf8"), "别处刚改：[[旧名]]\n");
  assert.ok(existsSync(join(library.root, "新名.md")) && !existsSync(join(library.root, "旧名.md")));
});

test("a title is the file name: a page whose properties say another title shows its file name", () => {
  const { write, index, world, module } = setup();
  write("文件名", "---\ntitle: 属性里的名字\n---\nx\n");
  index();
  const snapshot = module.snapshot!(world) as NotesSnapshot;
  assert.equal(snapshot.pages.find((page) => page.id === "文件名")!.title, "文件名");
});

test("pages in pages: a new sub-page makes the folder, a move takes the sub-pages, the trash takes both", () => {
  const { op, root, world, module } = setup();
  const parent = op("note.create", { title: "手冲" }).id as string;
  const child = op("note.create", { parent, title: "V60 参数" }).id as string;
  assert.equal(child, "手冲/V60 参数");
  assert.ok(existsSync(join(root, "手冲.md")) && existsSync(join(root, "手冲/V60 参数.md")));
  assert.equal(op("note.create", { title: "手冲" }).id, "手冲 2", "a taken name gets a number");
  const moved = op("note.move", { id: "手冲", parent: "手冲 2" });
  assert.equal(moved.id, "手冲 2/手冲");
  assert.ok(existsSync(join(root, "手冲 2/手冲/V60 参数.md")));
  op("note.delete", { id: "手冲 2" });
  const ids = (module.snapshot!(world) as NotesSnapshot).pages.map((page) => page.id);
  assert.deepEqual(ids, []);
  assert.ok(readdirSync(join(root, ".trash")).length >= 1);
});

test("a change is taken back while its lines are as it left them, and put back again", () => {
  const { write, index, world, library, libraryId, op } = setup();
  write("页", "第一行\n第二行\n第三行\n");
  index();
  let answer = savePage(world, library, libraryId, { library: libraryId, id: "页", base: library.read("页")!.fp, text: "第一行\n第二行改了\n第三行\n" });
  assert.ok(answer.ok);
  const [entry] = listHistory(world, "页");
  assert.deepEqual(entry.lines, [{ k: "del", text: "第二行" }, { k: "add", text: "第二行改了" }]);
  // A later change elsewhere in the page does not stop it.
  const later = Date.now();
  world.db.prepare("UPDATE note_history SET at = ? WHERE id = ?").run(new Date(later - 60 * 60_000).toISOString(), entry.id);
  answer = savePage(world, library, libraryId, { library: libraryId, id: "页", base: answer.ok ? answer.fp : "", text: "第一行\n第二行改了\n第三行\n第四行\n" });
  assert.ok(answer.ok);
  assert.deepEqual(op("note.undo", { entry: entry.id }), { ok: true });
  assert.equal(readFileSync(join(library.root, "页.md"), "utf8"), "第一行\n第二行\n第三行\n第四行\n");
  assert.deepEqual(op("note.undo", { entry: entry.id, redo: true }), { ok: true });
  assert.equal(readFileSync(join(library.root, "页.md"), "utf8"), "第一行\n第二行改了\n第三行\n第四行\n");
  // Once its lines change again, it cannot be taken back.
  writeFileSync(join(library.root, "页.md"), "第一行\n第二行又改了\n第三行\n第四行\n");
  index();
  assert.deepEqual(flipHistory(world, library, entry.id), { ok: false, reason: "changed" });
});

test("undoing a rename, a delete and a new page", () => {
  const { op, root, world } = setup();
  const id = op("note.create", { title: "页" }).id as string;
  op("note.move", { id, title: "新名" });
  const rename = listHistory(world, "新名").find((entry) => entry.kind === "rename")!;
  assert.deepEqual(op("note.undo", { entry: rename.id }), { ok: true });
  assert.ok(existsSync(join(root, "页.md")) && !existsSync(join(root, "新名.md")));
  op("note.delete", { id: "页" });
  const deleted = listHistory(world, "页").find((entry) => entry.kind === "delete")!;
  assert.deepEqual(op("note.undo", { entry: deleted.id }), { ok: true });
  assert.ok(existsSync(join(root, "页.md")));
  const created = listHistory(world, "页").find((entry) => entry.kind === "create")!;
  assert.deepEqual(op("note.undo", { entry: created.id }), { ok: true });
  assert.ok(!existsSync(join(root, "页.md")));
});

test("swapping a change back finds its lines anywhere in the page, once", () => {
  assert.equal(swapBack("a\nB\nc\n", "a\nb\nc\n", "a\nB\nc\n"), "a\nb\nc\n");
  assert.equal(swapBack("x\na\nB\nc\n", "a\nb\nc\n", "a\nB\nc\n"), "x\na\nb\nc\n");
  assert.equal(swapBack("a\nb2\nc\n", "a\nb\nc\n", "a\nB\nc\n"), null, "its lines changed since");
  assert.equal(swapBack("a\nc\nz\n", "a\nb\nc\n", "a\nc\n"), "a\nb\nc\nz\n", "a removed line comes back");
  assert.equal(swapBack("a\nb\nnew\nc\n", "a\nb\nc\n", "a\nb\nnew\nc\n"), "a\nb\nc\n", "an added line goes");
});

test("an icon is a name in the page's properties; only that line changes", () => {
  const { write, index, op, library } = setup();
  write("页", "---\ntags: [a]\n---\n正文\n");
  index();
  assert.ok((op("note.icon", { id: "页", icon: "book" }) as { ok: boolean }).ok);
  assert.equal(readFileSync(join(library.root, "页.md"), "utf8"), "---\ntags: [a]\nicon: book\n---\n正文\n");
});

test("a page moved in another app keeps its history (same words, new path)", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "v0\n");
  index();
  savePage(world, library, libraryId, { library: libraryId, id: "页", base: library.read("页")!.fp, text: "v1\n" });
  mkdirSync(join(library.root, "文件夹"));
  writeFileSync(join(library.root, "文件夹/页.md"), readFileSync(join(library.root, "页.md")));
  unlinkSync(join(library.root, "页.md"));
  index();
  assert.equal(listHistory(world, "文件夹/页").length, 1);
  assert.equal(fingerprint("v1\n"), library.read("文件夹/页")!.fp);
});

test("Zirma's proposed edit goes in only while its words are still there, once", () => {
  const { write, index, op, library } = setup();
  write("V60", "水温 92 度，焖蒸 30 秒。\n");
  index();
  assert.ok((op("note.edit", { id: "V60", find: "92 度", replace: "94 度" }) as { ok?: boolean }).ok);
  assert.equal(readFileSync(join(library.root, "V60.md"), "utf8"), "水温 94 度，焖蒸 30 秒。\n");
  assert.match(String((op("note.edit", { id: "V60", find: "92 度", replace: "90 度" }) as { error?: string }).error), /changed/);
});

test("reading a page answers its text, fingerprint and library", () => {
  const { write, index, world, library, libraryId } = setup();
  write("页", "正文\n");
  index();
  const detail = pageDetail(world, library, libraryId, "页");
  assert.equal(detail.text, "正文\n");
  assert.equal(detail.fp, fingerprint("正文\n"));
  assert.equal(detail.library, libraryId);
});

test("attachments go where Obsidian would put them, are named as it names them, and are found by name", () => {
  const { library, root } = setup();
  assert.equal(library.attachmentDir("页"), "Attachments", "no Obsidian setting: Attachments/");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const pasted = library.saveAttachment("手冲/V60", "image.png", png);
  assert.match(pasted.name, /^Pasted image \d{14}\.png$/);
  assert.equal(pasted.path, `Attachments/${pasted.name}`);
  const named = library.saveAttachment(null, "收据.PDF", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  const again = library.saveAttachment(null, "收据.pdf", new Uint8Array([1]));
  assert.deepEqual([named.name, again.name], ["收据.pdf", "收据 1.pdf"], "a taken name gets a number");
  assert.equal(library.findFile(pasted.name, "手冲/V60"), join(root, "Attachments", pasted.name), "found by name alone");
  assert.equal(library.findFile("Attachments/收据.pdf", null), join(root, "Attachments", "收据.pdf"), "found by path");
  assert.equal(library.findFile("../etc/passwd", null), null);
  assert.ok(!library.list().some((page) => page.id === "Attachments"), "a folder of only files is not a page");
  assert.equal(library.findFile(".obsidian/app.json", null), null);
  // Obsidian's setting wins: next to the page, or in a folder under it.
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: "./assets" }));
  assert.equal(library.attachmentDir("手冲/V60"), "手冲/assets");
  writeFileSync(join(root, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: "/" }));
  assert.equal(library.attachmentDir("手冲/V60"), "");
  // A picture next to the page, written as a path from it.
  mkdirSync(join(root, "手冲/img"), { recursive: true });
  writeFileSync(join(root, "手冲/img/a.png"), png);
  assert.equal(library.findFile("img/a.png", "手冲/V60"), join(root, "手冲/img/a.png"));
});
