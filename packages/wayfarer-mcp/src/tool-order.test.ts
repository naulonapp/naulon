/**
 * `orderTools`, proven through a real `tools/list` over the SDK's in-memory transport. Nothing
 * here reads the server's internals, so a release of the SDK that moves what `orderTools` relies
 * on fails these tests instead of passing them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { buildServer, TOOL_NAMES } from "./server.ts";
import { orderTools } from "./tool-order.ts";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-order-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const namesOf = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((t) => t.name);

/** Register a host's own tool on a built server, as a host does after `buildServer` returns. */
function mount(server: McpServer, name: string): void {
  server.registerTool(name, { description: `Host tool ${name}.` }, async () => ({ content: [{ type: "text", text: name }] }));
}

test("with no order stated, the listing is registration order", async () => {
  const server = buildServer();
  mount(server, "host_search");
  assert.deepEqual(await namesOf(await connect(server)), [...TOOL_NAMES, "host_search"]);
});

test("named tools come first in the order given, the rest keep registration order", async () => {
  const server = buildServer();
  mount(server, "host_search");
  mount(server, "host_read");
  orderTools(server, ["host_search", "naulon_quote", "naulon_discover"]);
  const rest = [...TOOL_NAMES.filter((n) => n !== "naulon_quote" && n !== "naulon_discover"), "host_read"];
  assert.deepEqual(await namesOf(await connect(server)), ["host_search", "naulon_quote", "naulon_discover", ...rest]);
});

test("the order covers a tool registered after it was stated", async () => {
  const server = buildServer();
  orderTools(server, ["host_late", "naulon_status"]);
  const client = await connect(server);
  // Not registered yet: the name is ignored and nothing else moves out of place.
  assert.deepEqual(await namesOf(client), ["naulon_status", ...TOOL_NAMES.filter((n) => n !== "naulon_status")]);
  mount(server, "host_late");
  mount(server, "host_other");
  assert.deepEqual(await namesOf(client), ["host_late", "naulon_status", ...TOOL_NAMES.filter((n) => n !== "naulon_status"), "host_other"]);
});

test("a name with no tool and a repeated name are ignored", async () => {
  const server = buildServer();
  orderTools(server, ["naulon_absent", "naulon_quote", "naulon_quote"]);
  const names = await namesOf(await connect(server));
  assert.deepEqual(names, ["naulon_quote", ...TOOL_NAMES.filter((n) => n !== "naulon_quote")]);
  assert.equal(names.length, TOOL_NAMES.length, "no tool is listed twice and none is dropped");
});

test("an empty order leaves the listing as it was", async () => {
  const server = buildServer();
  orderTools(server, []);
  assert.deepEqual(await namesOf(await connect(server)), [...TOOL_NAMES]);
});

test("stating the order again replaces it", async () => {
  const server = buildServer();
  orderTools(server, ["naulon_quote"]);
  orderTools(server, ["naulon_appraise"]);
  assert.deepEqual(await namesOf(await connect(server)), ["naulon_appraise", ...TOOL_NAMES.filter((n) => n !== "naulon_appraise")]);
});

test("the order respects a narrowed surface", async () => {
  const server = buildServer({ surface: { tools: ["naulon_discover", "naulon_quote"] } });
  orderTools(server, ["naulon_quote", "naulon_pay_and_read"]);
  assert.deepEqual(await namesOf(await connect(server)), ["naulon_quote", "naulon_discover"]);
});

test("ordering changes the listing only: every definition is intact and a moved tool still answers", async () => {
  const plain = await (await connect(buildServer())).listTools();
  const server = buildServer();
  mount(server, "host_search");
  orderTools(server, ["host_search", "naulon_appraise"]);
  const client = await connect(server);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const tool of plain.tools) assert.deepEqual(byName.get(tool.name), tool, `${tool.name} is listed as it was`);

  const host = await client.callTool({ name: "host_search", arguments: {} });
  assert.deepEqual(host.content, [{ type: "text", text: "host_search" }]);
  const own = await client.callTool({ name: "naulon_appraise", arguments: { topic: "passage", candidates: [{ slug: "a", title: "Passage", summary: "On passage." }] } });
  assert.notEqual(own.isError, true, JSON.stringify(own.content));
  assert.equal((own.structuredContent as { appraised: unknown[] }).appraised.length, 1);
});

test("a server with no tool registered refuses, and says what to do", () => {
  assert.throws(() => orderTools(new McpServer({ name: "empty", version: "0.0.0" }), ["a"]), /lists no tools yet/);
});

test("an SDK that no longer holds its handlers where they are read is named, not guessed around", () => {
  const moved = { server: {} } as unknown as McpServer;
  assert.throws(() => orderTools(moved, ["a"]), /this version of the MCP SDK/);
});
