/**
 * `decorateToolResults`, proven through a real `tools/call` over the SDK's in-memory transport, so a
 * release of the SDK that moves the handler it wraps fails here instead of passing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { buildServer } from "./server.ts";
import { decorateToolResults } from "./tool-results.ts";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-results-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function mount(server: McpServer, name: string): void {
  server.registerTool(name, { description: `Host tool ${name}.` }, async () => ({ content: [{ type: "text", text: name }] }));
}

const NOTE = { type: "text" as const, text: "note" };
const prepend = (_c: unknown, r: CallToolResult): CallToolResult => ({ ...r, content: [NOTE, ...r.content] });

test("the decorator sees the host's tools and the package's, and what it returns is sent", async () => {
  const server = buildServer();
  mount(server, "host_read");
  const seen: string[] = [];
  decorateToolResults(server, (c, r) => {
    seen.push(c.name);
    return prepend(c, r);
  });
  const client = await connect(server);
  const host = await client.callTool({ name: "host_read", arguments: {} });
  assert.deepEqual(host.content, [NOTE, { type: "text", text: "host_read" }]);
  const own = await client.callTool({ name: "naulon_appraise", arguments: { topic: "passage", candidates: [{ slug: "a", title: "Passage", summary: "On passage." }] } });
  assert.notEqual(own.isError, true, JSON.stringify(own.content));
  assert.deepEqual((own.content as unknown[])[0], NOTE);
  assert.equal((own.structuredContent as { appraised: unknown[] }).appraised.length, 1, "structured content is untouched");
  assert.deepEqual(seen, ["host_read", "naulon_appraise"]);
});

test("null leaves the result as the tool returned it", async () => {
  const server = buildServer();
  mount(server, "host_read");
  decorateToolResults(server, () => null);
  const r = await (await connect(server)).callTool({ name: "host_read", arguments: {} });
  assert.deepEqual(r.content, [{ type: "text", text: "host_read" }]);
});

test("a decorator that throws or rejects costs the caller nothing, and is reported", async () => {
  const server = buildServer();
  mount(server, "host_read");
  const errors: string[] = [];
  decorateToolResults(server, () => { throw new Error("search down"); }, { onError: (e, c) => errors.push(`${c.name}: ${(e as Error).message}`) });
  const client = await connect(server);
  assert.deepEqual((await client.callTool({ name: "host_read", arguments: {} })).content, [{ type: "text", text: "host_read" }]);
  decorateToolResults(server, async () => { throw new Error("timed out"); }, { onError: (e, c) => errors.push(`${c.name}: ${(e as Error).message}`) });
  assert.deepEqual((await client.callTool({ name: "host_read", arguments: {} })).content, [{ type: "text", text: "host_read" }]);
  assert.deepEqual(errors, ["host_read: search down", "host_read: timed out"]);
});

test("a reporter that throws still costs the caller nothing", async () => {
  const server = buildServer();
  mount(server, "host_read");
  decorateToolResults(server, () => { throw new Error("a"); }, { onError: () => { throw new Error("b"); } });
  assert.deepEqual((await (await connect(server)).callTool({ name: "host_read", arguments: {} })).content, [{ type: "text", text: "host_read" }]);
});

test("a tool registered after the call is decorated too, and the decorator can be replaced", async () => {
  const server = buildServer();
  decorateToolResults(server, prepend);
  mount(server, "host_late");
  const client = await connect(server);
  assert.deepEqual((await client.callTool({ name: "host_late", arguments: {} })).content, [NOTE, { type: "text", text: "host_late" }]);
  decorateToolResults(server, () => null);
  assert.deepEqual((await client.callTool({ name: "host_late", arguments: {} })).content, [{ type: "text", text: "host_late" }]);
});

test("a tool's own error result is still a result: the decorator sees it with isError", async () => {
  const server = buildServer();
  server.registerTool("host_strict", { description: "Needs n.", inputSchema: { n: z.number() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  let sawError: boolean | undefined;
  decorateToolResults(server, (_c, r) => { sawError = r.isError; return null; });
  const r = await (await connect(server)).callTool({ name: "host_strict", arguments: { n: "x" } });
  assert.equal(r.isError, true);
  assert.equal(sawError, true);
});

test("a server with no tool registered refuses, and says what to do", () => {
  assert.throws(() => decorateToolResults(new McpServer({ name: "empty", version: "0.0.0" }), () => null), /decorateToolResults: the server lists no tools yet/);
});

test("an SDK that no longer holds its handlers where they are read is named, not guessed around", () => {
  const moved = { server: {} } as unknown as McpServer;
  assert.throws(() => decorateToolResults(moved, () => null), /this version of the MCP SDK/);
});
