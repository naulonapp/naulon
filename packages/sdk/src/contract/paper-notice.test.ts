import assert from "node:assert/strict";
import { test } from "node:test";
import { PAPER_NOTICE_TYPES, paperNoticeDataSchema, paperNoticeSchema } from "./paper-notice.ts";

const NOTICE = {
  id: "ntc_1",
  paper: { key: "10.1000/x", title: "On stillness", page: "https://host.example/papers/10.1000/x" },
  type: "retraction",
  date: "2025-03-01",
  seenAt: "2025-03-02T10:00:00.000Z",
  source: "publisher",
  doi: "10.1000/x.retraction",
  served: [{ textRoot: "a".repeat(64), sentences: [3, 4, 9], more: false }],
  instead: [{ key: "10.1000/y", title: "A review", page: "https://host.example/papers/10.1000/y", licence: "cc-by", studyType: "systematic_review", year: 2024 }],
};

test("a full notice parses", () => {
  assert.equal(paperNoticeSchema.safeParse(NOTICE).success, true);
  assert.equal(paperNoticeDataSchema.safeParse({ notices: [NOTICE], more: 0 }).success, true);
});

test("an added field, or a kind the parser does not know, never fails a parse", () => {
  const newer = { ...NOTICE, type: "erratum", paper: { ...NOTICE.paper, doi: "10.1000/x" }, futureField: 1 };
  assert.equal(paperNoticeSchema.safeParse(newer).success, true);
  assert.equal(PAPER_NOTICE_TYPES.includes("erratum" as never), false);
});

test("a delivery with no notice, or a fractional sentence index, is refused", () => {
  assert.equal(paperNoticeDataSchema.safeParse({ notices: [], more: 0 }).success, false);
  const bad = { ...NOTICE, served: [{ textRoot: "r", sentences: [1.5], more: false }] };
  assert.equal(paperNoticeSchema.safeParse(bad).success, false);
});
