// A tiny MCP server over stdio for checking Zirma's gate by hand or in tests.
// Tools: lookup_weather (marked read-only) and save_note (not marked: may change things).
// save_note appends to the file named by NOTES_FILE.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = [
  {
    name: "lookup_weather",
    description: "Look up today's weather in a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save_note",
    description: "Save a short note to the user's notes.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];
let saved = 0;
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications
  if (method === "initialize") {
    reply(id, { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1.0.0" } });
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools });
  } else if (method === "tools/call") {
    const args = params?.arguments ?? {};
    if (params?.name === "lookup_weather") reply(id, { content: [{ type: "text", text: `Sunny, 18°C in ${args.city}.` }] });
    else if (params?.name === "save_note") {
      if (process.env.NOTES_FILE) appendFileSync(process.env.NOTES_FILE, `${String(args.text)}\n`);
      reply(id, { content: [{ type: "text", text: `Saved note #${++saved}.` }] });
    } else reply(id, { content: [{ type: "text", text: `Unknown tool ${params?.name}` }], isError: true });
  } else {
    fail(id, -32601, `Method not found: ${method}`);
  }
});
