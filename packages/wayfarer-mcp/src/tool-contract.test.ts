/**
 * The tool definition contract, proven in both directions: each rule objects to a definition that
 * breaks it and stays silent on one that holds, and the servers this package builds pass it whole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer, TOOL_NAMES, type BuildServerOptions } from "./server.ts";
import { MAX_TOOL_DESCRIPTION_CHARS, toolContractProblems, toolNamer, type ListedTool } from "./tool-contract.ts";

const PREFIX = "naulon_";

/** A definition that holds every rule, beside a sibling it names. */
function sound(over: Partial<ListedTool> = {}): ListedTool {
  return {
    name: "naulon_alpha",
    title: "Alpha",
    description: "Does alpha and returns a row. For beta, call naulon_beta.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "The query." } } },
    outputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...over,
  };
}
const sibling = (): ListedTool =>
  sound({ name: "naulon_beta", title: "Beta", description: "Does beta and returns a row. For alpha, call naulon_alpha." });

const problemsOf = (tool: ListedTool, instructions?: string): string[] =>
  toolContractProblems([tool, sibling()], { prefix: PREFIX, ...(instructions === undefined ? {} : { instructions }) });

test("a sound pair of definitions has no problems", () => {
  assert.deepEqual(problemsOf(sound()), []);
});

const BROKEN: Array<[rule: string, tool: ListedTool, expected: RegExp]> = [
  ["a camel case name", sound({ name: "naulon_alphaOne" }), /not lower snake case/],
  ["a name without the prefix", sound({ name: "alpha" }), /does not start with naulon_/],
  ["no title", sound({ title: "" }), /no title/],
  ["a title another tool holds", sound({ title: "Beta" }), /shares its title with naulon_alpha/],
  ["no description", sound({ description: " " }), /no description/],
  ["a description another tool holds", sound({ description: sibling().description! }), /shares its description/],
  [
    "a description over the ceiling",
    sound({ description: `For beta, call naulon_beta. ${"x".repeat(MAX_TOOL_DESCRIPTION_CHARS)}` }),
    /over the 1000 allowed/,
  ],
  ["a description naming no sibling", sound({ description: "Does alpha and returns a row." }), /names no sibling tool/],
  ["a description naming only itself", sound({ description: "naulon_alpha does alpha." }), /names no sibling tool/],
  [
    "an argument without a description",
    sound({ inputSchema: { type: "object", properties: { q: { type: "string" } } } }),
    /argument q has no description/,
  ],
  [
    "a nested argument without a description",
    sound({
      inputSchema: {
        type: "object",
        properties: {
          rows: { type: "array", description: "Rows.", items: { type: "object", properties: { id: { type: "string" } } } },
        },
      },
    }),
    /argument rows\[\]\.id has no description/,
  ],
  ["no outputSchema", sound({ outputSchema: undefined }), /no outputSchema/],
  [
    "a hint left to its default",
    sound({ annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }),
    /destructiveHint is not stated/,
  ],
  [
    "read-only and destructive at once",
    sound({ annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: false } }),
    /readOnlyHint and destructiveHint are both true/,
  ],
  [
    "a description naming a tool that is not listed",
    sound({ description: "Does alpha. For beta, call naulon_beta. To buy, call naulon_pay." }),
    /names naulon_pay, which this server does not list/,
  ],
  [
    "an output field naming a tool that is not listed",
    sound({ outputSchema: { type: "object", properties: { url: { type: "string", description: "Pass it to naulon_pay." } } } }),
    /names naulon_pay, which this server does not list/,
  ],
];

for (const [rule, tool, expected] of BROKEN) {
  test(`the contract objects to ${rule}`, () => {
    const problems = problemsOf(tool);
    assert.ok(problems.some((p) => expected.test(p)), `expected ${expected}, got ${JSON.stringify(problems)}`);
  });
}

test("instructions that name a tool the server does not list are a problem", () => {
  assert.deepEqual(problemsOf(sound(), "Call naulon_alpha, then naulon_beta."), []);
  assert.deepEqual(problemsOf(sound(), "Then call naulon_pay."), ["instructions: names naulon_pay, which this server does not list"]);
});

test("a choice of shapes is described when every branch is, and a branch's properties are still read", () => {
  const choice = (branches: object[]): ListedTool =>
    sound({ inputSchema: { type: "object", properties: { q: { anyOf: branches } } } as ListedTool["inputSchema"] });
  assert.deepEqual(problemsOf(choice([{ type: "string", description: "A DOI." }, { type: "number", description: "A PMID." }])), []);
  assert.deepEqual(problemsOf(choice([{ type: "string", description: "A DOI." }, { type: "number" }])), ["naulon_alpha: argument q has no description"]);
  assert.deepEqual(
    problemsOf(choice([{ type: "object", description: "A range.", properties: { from: { type: "string" } } }])),
    ["naulon_alpha: argument q.from has no description"],
  );
});

test("a local $ref is followed, and one that points at itself ends the walk", () => {
  const withRef = (defs: Record<string, object>): ListedTool =>
    sound({ inputSchema: { type: "object", properties: { row: { $ref: "#/$defs/Row" } }, $defs: defs } as ListedTool["inputSchema"] });
  assert.deepEqual(problemsOf(withRef({ Row: { type: "object", description: "A row.", properties: { id: { type: "string", description: "Its id." } } } })), []);
  assert.deepEqual(
    problemsOf(withRef({ Row: { type: "object", description: "A row.", properties: { id: { type: "string" } } } })),
    ["naulon_alpha: argument row.id has no description"],
  );
  assert.deepEqual(
    problemsOf(withRef({ Row: { type: "object", description: "A row. Pass it to naulon_pay.", properties: { next: { $ref: "#/$defs/Row" } } } })).sort(),
    ["naulon_alpha: argument row.next has no description", "naulon_alpha: its text names naulon_pay, which this server does not list"],
  );
});

test("a prefix is matched as written, not as a pattern", () => {
  const dotted = (name: string, description: string): ListedTool => sound({ name, title: name, description });
  const tools = [dotted("a.b_one", "Does one. For two, call a.b_two."), dotted("a.b_two", "Does two. For one, call a.b_one. See axb_three.")];
  const problems = toolContractProblems(tools, { prefix: "a.b_" }).filter((p) => /names /.test(p));
  assert.deepEqual(problems, [], "axb_three does not carry the prefix a.b_, so it is not read as a tool");
});

test("a lone tool is not asked to name a sibling", () => {
  assert.deepEqual(toolContractProblems([sound({ description: "Does alpha and returns a row." })], { prefix: PREFIX }), []);
});

test("a namer keeps only the tools a server lists", () => {
  const named = toolNamer(["naulon_alpha", "naulon_beta", "naulon_gamma"]);
  assert.equal(named("naulon_alpha"), "naulon_alpha");
  assert.equal(named("naulon_alpha", "naulon_pay"), "naulon_alpha");
  assert.equal(named("naulon_alpha", "naulon_beta"), "naulon_alpha or naulon_beta");
  assert.equal(named("naulon_alpha", "naulon_pay", "naulon_beta", "naulon_gamma"), "naulon_alpha, naulon_beta or naulon_gamma");
  assert.equal(named("naulon_pay"), "");
  assert.equal(named.lists("naulon_pay"), false);
  assert.equal(toolNamer(null)("naulon_pay"), "naulon_pay", "no allowlist lists everything");
});

/** `tools/list` and `instructions` exactly as a client of this server receives them. */
async function listed(opts?: BuildServerOptions): Promise<{ tools: ListedTool[]; instructions: string }> {
  const server = buildServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-contract-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return { tools: tools as ListedTool[], instructions: client.getInstructions() ?? "" };
}

test("the full server holds the contract", async () => {
  const { tools, instructions } = await listed();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), "TOOL_NAMES is the listing, no more and no less");
  assert.deepEqual(toolContractProblems(tools, { prefix: PREFIX, instructions }), []);
});

test("a price-only server holds the contract over the tools it keeps", async () => {
  const { tools, instructions } = await listed({
    priceOnly: true,
    surface: { tools: ["naulon_discover", "naulon_appraise", "naulon_quote"], prompts: [] },
  });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["naulon_appraise", "naulon_discover", "naulon_quote"]);
  assert.deepEqual(toolContractProblems(tools, { prefix: PREFIX, instructions }), []);
});
