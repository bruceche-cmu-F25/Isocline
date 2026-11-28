import assert from "node:assert/strict";
import { test } from "node:test";
import { HIGHLIGHT_LIMIT, highlight, languageOf } from "../src/highlight.ts";

const join = (code: string, lang?: string) => highlight(code, lang).map((token) => token.text).join("");
const kinds = (code: string, lang: string) => highlight(code, lang).filter((token) => token.kind !== "plain").map((token) => `${token.kind}:${token.text}`);

test("every character comes back, in order, whatever the language", () => {
  const samples: Array<[string, string]> = [
    ["const a = `x ${b}` // c\n/* d */ return 0x1F;", "ts"],
    ['def f(x):\n    """doc\n    more"""\n    return x * 2.5  # tail', "python"],
    ["npm i --save-dev pkg && echo \"$HOME\" # hi", "bash"],
    ["SELECT a FROM t WHERE b = 'it''s' -- note", "sql"],
    ['<div class="a" data-x=\'1\'><!-- c --></div>', "html"],
    ['{"a": [1, true, null], "b": "s\\"q"}', "json"],
    ["unterminated 'string\nnext line", "js"],
    ["@media (max-width: 3px) { a { color: red !important } }", "css"],
  ];
  for (const [code, lang] of samples) assert.equal(join(code, lang), code, lang);
});

test("comments, strings, numbers and keywords are told apart", () => {
  assert.deepEqual(kinds('const x = "hi"; // note', "ts"), ["keyword:const", 'string:"hi"', "comment:// note"]);
  assert.deepEqual(kinds("return 42", "js"), ["keyword:return", "number:42"]);
  assert.deepEqual(kinds("if !this.ok", "js"), ["keyword:if", "literal:this"]);
  assert.deepEqual(kinds("x = None  # empty", "py"), ["literal:None", "comment:# empty"]);
  assert.deepEqual(kinds('s = """a\n"b"\n"""', "py"), ['string:"""a\n"b"\n"""']);
  assert.deepEqual(kinds("v2 = a1", "js"), [], "digits inside a name are not a number");
  assert.deepEqual(kinds("returned", "js"), [], "a keyword inside a longer word is not one");
  assert.deepEqual(kinds('<a href="/x">', "html"), ["tag:<a", "attr: href", 'string:"/x"', "tag:>"]);
});

test("an unknown language, no language, or a very long block stays plain", () => {
  assert.equal(languageOf("brainfuck"), null);
  assert.deepEqual(highlight("const x = 1", undefined), [{ kind: "plain", text: "const x = 1" }]);
  assert.deepEqual(highlight("const x = 1", "mystery"), [{ kind: "plain", text: "const x = 1" }]);
  const long = "x".repeat(HIGHLIGHT_LIMIT + 1);
  assert.deepEqual(highlight(long, "js"), [{ kind: "plain", text: long }]);
});
