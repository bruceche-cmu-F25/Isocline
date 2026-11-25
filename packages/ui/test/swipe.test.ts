import assert from "node:assert/strict";
import { test } from "node:test";
import { axisOf, edgeOf, pageBeside } from "../src/swipe.ts";

test("a touch is a page swipe only when it lands at the very edge of the screen", () => {
  assert.equal(edgeOf(4, 390), "left");
  assert.equal(edgeOf(386, 390), "right");
  assert.equal(edgeOf(120, 390), null, "on a mail row: that row's swipe");
});

test("a swipe is decided once the finger has gone a little way, and only mostly sideways is sideways", () => {
  assert.equal(axisOf(4, 3), null);
  assert.equal(axisOf(30, 6), "x");
  assert.equal(axisOf(-30, 6), "x");
  assert.equal(axisOf(12, 30), "y", "scrolling the list");
  assert.equal(axisOf(20, 19), "y", "a diagonal is the page scrolling");
});

const dock = ["core.today", "core.inbox", "calendar.week", "todo.list"];
const sidebar = ["core.today", "core.inbox", "calendar.week", "todo.list", "mail.inbox", "link.list", "core.settings"];

test("from the right edge is the next page in the dock, from the left the one before; nothing past either end", () => {
  assert.equal(pageBeside(dock, sidebar, "core.inbox", "right"), "calendar.week");
  assert.equal(pageBeside(dock, sidebar, "core.inbox", "left"), "core.today");
  assert.equal(pageBeside(dock, sidebar, "core.today", "left"), null);
  assert.equal(pageBeside(dock, sidebar, "todo.list", "right"), null);
});

test("a page that is not in the dock sits among its pages where the sidebar has it", () => {
  assert.equal(pageBeside(dock, sidebar, "mail.inbox", "left"), "todo.list");
  assert.equal(pageBeside(dock, sidebar, "mail.inbox", "right"), null);
  const reordered = ["core.today", "mail.inbox", "core.inbox", "calendar.week", "todo.list"];
  assert.equal(pageBeside(dock, reordered, "mail.inbox", "left"), "core.today");
  assert.equal(pageBeside(dock, reordered, "mail.inbox", "right"), "core.inbox");
});
