import { test } from "node:test";
import assert from "node:assert/strict";
import { ARM_VERIFIED_MIN, ARM_WINDOW_MS, DISARM_MIN_FORGED, MemoryArmingStore } from "./arming.ts";
import type { IdentityResult } from "./identity.ts";

const r = (check: IdentityResult["check"], op = "google"): IdentityResult => ({ check, claims: [{ operatorId: op, operator: "Google", fragment: "googlebot", check }] });
const T = Date.UTC(2026, 9, 1);

test("a fresh store is unarmed (a restart re-arms from zero, the safe direction)", () => {
  assert.equal(new MemoryArmingStore().isArmed("p", "google"), false);
});

test("arms at exactly ARM_VERIFIED_MIN verified within the window", () => {
  const s = new MemoryArmingStore();
  for (let i = 0; i < ARM_VERIFIED_MIN - 1; i++) s.record("p", r("ip-verified"), T + i);
  assert.equal(s.isArmed("p", "google"), false);
  s.record("p", r("ip-verified"), T + 100);
  assert.equal(s.isArmed("p", "google"), true);
  assert.equal(s.isArmed("other", "google"), false);
  assert.equal(s.isArmed("p", "bing"), false);
});

test("verified hits older than the window do not count", () => {
  const s = new MemoryArmingStore();
  for (let i = 0; i < ARM_VERIFIED_MIN - 1; i++) s.record("p", r("ip-verified"), T);
  s.record("p", r("ip-verified"), T + ARM_WINDOW_MS + 3_600_000); // the window counts whole hours
  assert.equal(s.isArmed("p", "google"), false);
});

test("forged and unverified never arm", () => {
  const s = new MemoryArmingStore();
  for (let i = 0; i < 100; i++) { s.record("p", r("forged"), T + i); s.record("p", r("unverified"), T + i); }
  assert.equal(s.isArmed("p", "google"), false);
});

const HOUR = 3_600_000;
const armAt = (s: MemoryArmingStore, start: number, spacing = 1) => {
  for (let i = 0; i < ARM_VERIFIED_MIN; i++) s.record("p", r("ip-verified"), start + i * spacing);
};

test("a proxy change (real crawler stops verifying, forged keeps coming) disarms, then must re-earn", () => {
  const s = new MemoryArmingStore();
  armAt(s, T);
  assert.equal(s.isArmed("p", "google"), true);
  const later = T + 4 * 24 * HOUR; // longer than any silence threshold
  for (let i = 0; i < DISARM_MIN_FORGED; i++) s.record("p", r("forged"), later + i);
  assert.equal(s.isArmed("p", "google"), false);
  const st = s.status("p", later + 100).find((x) => x.operatorId === "google")!;
  assert.ok(st.disarmedAt);
  s.record("p", r("ip-verified"), later + 200);
  assert.equal(s.isArmed("p", "google"), false);
});

test("I2: a forger out-requesting the real crawler cannot disarm it", () => {
  const s = new MemoryArmingStore();
  armAt(s, T, HOUR); // the real crawler visits hourly
  let t = T + ARM_VERIFIED_MIN * HOUR;
  for (let day = 0; day < 5; day++) {
    for (let i = 0; i < 24; i++) {
      for (let k = 0; k < 200; k++) s.record("p", r("forged"), t + k); // 200 forged an hour
      s.record("p", r("ip-verified"), t + 500); // the real crawler keeps verifying
      t += HOUR;
    }
  }
  assert.equal(s.isArmed("p", "google"), true);
});

test("I2: right after arming, a burst of forgeries does not disarm", () => {
  const s = new MemoryArmingStore();
  armAt(s, T);
  for (let i = 0; i < 21; i++) s.record("p", r("forged"), T + 100 + i);
  assert.equal(s.isArmed("p", "google"), true);
});

test("I1: memory and the decision do not depend on request volume", () => {
  const s = new MemoryArmingStore();
  armAt(s, T, HOUR);
  let t = T + ARM_VERIFIED_MIN * HOUR;
  for (let i = 0; i < 12_000; i++) {
    s.record("p", r(i % 4 === 0 ? "forged" : "ip-verified"), t + i);
  }
  assert.equal(s.isArmed("p", "google"), true);
});

test("a quiet site's silence threshold is capped, so a proxy change disarms within 3 days", () => {
  const s = new MemoryArmingStore();
  armAt(s, T, 16 * HOUR); // one real visit every 16h: 20 visits fit in 14 days
  const last = T + (ARM_VERIFIED_MIN - 1) * 16 * HOUR;
  assert.equal(s.isArmed("p", "google"), true);
  for (let i = 0; i < DISARM_MIN_FORGED; i++) s.record("p", r("forged"), last + 72 * HOUR + 1 + i);
  assert.equal(s.isArmed("p", "google"), false);
});

test("one request naming two operators counts once for each", () => {
  const s = new MemoryArmingStore();
  const two: IdentityResult = { check: "ip-verified", claims: [
    { operatorId: "google", operator: "Google", fragment: "googlebot", check: "ip-verified" },
    { operatorId: "bing", operator: "Microsoft", fragment: "bingbot", check: "ip-verified" } ] };
  for (let i = 0; i < ARM_VERIFIED_MIN; i++) s.record("p", two, T + i);
  assert.equal(s.isArmed("p", "google"), true);
  assert.equal(s.isArmed("p", "bing"), true);
});
