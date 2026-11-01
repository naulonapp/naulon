import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "@naulon/shared";
import { envPublisherResolver } from "./publisher.ts";

const scopeOf = async (env: Record<string, string>) => (await envPublisherResolver(parseEnv(env)).resolve("h.example"))?.gateScope;

test("a gate configured with no scope stays in prefix mode", async () => {
  assert.equal(await scopeOf({}), undefined);
});

test("GATE_SCOPE=site tolls the whole site minus the excluded sections", async () => {
  assert.deepEqual(await scopeOf({ GATE_SCOPE: "site", GATE_EXCLUDE_PREFIXES: "api, static" }), { mode: "site", excludePrefixes: ["api", "static"] });
});

test("opted-in extensions are normalised the way every other write path normalises them", async () => {
  assert.deepEqual(await scopeOf({ GATE_SCOPE: "site", GATE_INCLUDE_EXTENSIONS: "PDF, json" }), { mode: "site", excludePrefixes: [], includeExtensions: ["json", "pdf"] });
});

test("an unknown GATE_SCOPE fails at boot", () => {
  assert.throws(() => parseEnv({ GATE_SCOPE: "everything" }), /GATE_SCOPE/);
});
