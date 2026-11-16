import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWire, summarize } from "./transform.ts";

const CANON = {
  id: "d1",
  type: "settlement.completed" as const,
  eventId: "s1",
  createdAt: 0,
  data: { tenant: "acme.test", acked: 3, grossMicroUsdc: 1_250_000 },
};

test("raw returns the canonical JSON verbatim", () => {
  assert.deepEqual(JSON.parse(renderWire("raw", "settlement.completed", CANON).body), CANON);
});

test("slack wire is { text }", () => {
  const b = JSON.parse(renderWire("slack", "settlement.completed", CANON).body);
  assert.equal(typeof b.text, "string");
  assert.match(b.text, /settlement/i);
  assert.deepEqual(Object.keys(b), ["text"]);
});

test("discord wire is { content, embeds[] }", () => {
  const b = JSON.parse(renderWire("discord", "settlement.completed", CANON).body);
  assert.equal(typeof b.content, "string");
  assert.ok(Array.isArray(b.embeds));
  assert.equal(b.embeds[0].title, "settlement.completed");
});

test("teams wire is the adaptive-card message envelope", () => {
  const b = JSON.parse(renderWire("teams", "settlement.completed", CANON).body);
  assert.equal(b.type, "message");
  assert.equal(b.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(b.attachments[0].content.type, "AdaptiveCard");
});

test("summarize is channel-agnostic and event-specific", () => {
  assert.match(summarize("anomaly.detected", { detail: "no earnings" }), /no earnings/);
  assert.match(summarize("ping", {}), /ping/i);
});

test("a paper notice names the paper and states its kind plainly", () => {
  const one = { notices: [{ type: "retraction", paper: { title: "On stillness" } }], more: 0 };
  assert.equal(summarize("paper.notice", one), 'A paper you read changed: "On stillness" was retracted.');
  const corr = { notices: [{ type: "correction", paper: { title: "On stillness" } }, { type: "concern", paper: { title: "B" } }], more: 1 };
  assert.equal(summarize("paper.notice", corr), 'A paper you read changed: "On stillness" was corrected (2 more paper notices waiting).');
  assert.doesNotMatch(summarize("paper.notice", corr), /retract/);
});

test("a paper notice with a kind the line does not know still reads as a sentence", () => {
  assert.equal(summarize("paper.notice", { notices: [{ type: "erratum", paper: {} }], more: 0 }), "A paper you read has a new notice.");
  assert.equal(summarize("paper.notice", {}), "A paper you read has a new notice.");
});
