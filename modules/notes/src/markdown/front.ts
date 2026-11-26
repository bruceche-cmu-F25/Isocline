/** Changing one property at the top of a page (`icon: cup`) without touching anything else in the file: only the
 * line of that key changes; other keys, comments and the body stay as they are. Zirma only writes the keys it knows
 * (notes.md 4.4 #4, research 3.1). */
import { parsePage } from "./parse.ts";

const KEY = /^[A-Za-z_][\w-]*$/;

function quoted(value: string): string {
  return /^[\wÀ-￿][\wÀ-￿ .\-/]*$/u.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) && !/^\d/.test(value) ? value : JSON.stringify(value);
}

/** The text with `key` set to `value`, or taken out when `value` is null. */
export function setProperty(text: string, key: string, value: string | null): string {
  if (!KEY.test(key)) throw new Error(`Not a property name: ${key}`);
  const page = parsePage(text);
  const { body, eol, bom } = page;
  const mark = bom ? "﻿" : "";
  if (!page.front) {
    if (value === null) return text;
    return `${mark}---${eol}${key}: ${quoted(value)}${eol}---${eol}${body}`;
  }
  const head = body.slice(0, page.front.end);
  const lines = head.split(/\r?\n/);
  // lines[0] is the opening fence, the last the closing one.
  const at = lines.findIndex((line, i) => i > 0 && i < lines.length - 1 && new RegExp(`^${key}:`).test(line));
  if (value === null) {
    if (at === -1) return text;
    lines.splice(at, 1);
  } else if (at === -1) lines.splice(lines.length - 1, 0, `${key}: ${quoted(value)}`);
  else lines[at] = `${key}: ${quoted(value)}`;
  return mark + lines.join(eol) + body.slice(page.front.end);
}
