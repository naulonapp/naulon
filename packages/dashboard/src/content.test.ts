import assert from "node:assert/strict";
import { test } from "node:test";
import { isRestartPending } from "./content.ts";

const BOOT = "2026-07-11T10:00:00.000Z";
const BEFORE = "2026-07-11T09:00:00.000Z";
const AFTER = "2026-07-11T11:00:00.000Z";

test("pending when the file was modified after the gate booted", () => {
  assert.equal(isRestartPending({ fileModifiedAt: AFTER, gateStartedAt: BOOT, gateUp: true }), true);
});

test("not pending when the file predates the gate boot (edit already loaded)", () => {
  assert.equal(isRestartPending({ fileModifiedAt: BEFORE, gateStartedAt: BOOT, gateUp: true }), false);
});

test("not pending when the gate is down — no live map to be stale against", () => {
  assert.equal(isRestartPending({ fileModifiedAt: AFTER, gateStartedAt: BOOT, gateUp: false }), false);
});

test("not pending when a timestamp is unknown (no file, or old gate without startedAt)", () => {
  assert.equal(isRestartPending({ fileModifiedAt: null, gateStartedAt: BOOT, gateUp: true }), false);
  assert.equal(isRestartPending({ fileModifiedAt: AFTER, gateStartedAt: null, gateUp: true }), false);
});
