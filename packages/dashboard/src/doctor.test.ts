import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChecks, headlineFor, type DoctorInput } from "./doctor.ts";
import type { ConfigSummary } from "./config-view.ts";

const CONFIG: ConfigSummary = {
  originUrl: "http://localhost:3000",
  priceUsdc: 0.001,
  citationMultiplier: 5,
  creditsSource: { mode: "fixture", location: "/tmp/credits.json" },
  articles: [{ slug: "on-stillness", wallets: ["0x1"] }],
  slugCount: 1,
  wallets: ["0x1"],
  observations: "jsonl",
  events: "jsonl",
  warnings: [],
};

const HEALTHY: DoctorInput = {
  config: CONFIG,
  health: { up: true },
  restartPending: false,
  originReachable: true,
  accessMode: "private",
  bind: "127.0.0.1",
  paymentMode: "gateway",
  settlementNetwork: "arcTestnet",
};

const byId = (cs: ReturnType<typeof buildChecks>, id: string) => cs.find((c) => c.id === id)!;

test("a fully healthy gate has no fails and no warns", () => {
  const cs = buildChecks(HEALTHY);
  assert.equal(cs.filter((c) => c.status === "fail").length, 0);
  assert.equal(cs.filter((c) => c.status === "warn").length, 0);
  assert.equal(headlineFor(cs), "Everything checks out. The gate is configured to toll.");
});

test("a down gate fails and says nothing is being tolled", () => {
  const cs = buildChecks({ ...HEALTHY, health: { up: false, detail: "unreachable" } });
  const c = byId(cs, "gate");
  assert.equal(c.status, "fail");
  assert.match(c.fix, /Nothing is being tolled/);
});

test("an unreachable origin warns that humans break too, not just the toll", () => {
  const cs = buildChecks({ ...HEALTHY, originReachable: false });
  const c = byId(cs, "origin");
  assert.equal(c.status, "fail");
  assert.match(c.fix, /humans included/);
});

test("no tollable article is a FAIL, not a warning — nothing can be charged", () => {
  const cs = buildChecks({ ...HEALTHY, config: { ...CONFIG, slugCount: 0, articles: [], wallets: [] } });
  const c = byId(cs, "credits");
  assert.equal(c.status, "fail");
  assert.match(c.fix, /Content page/);
});

test("API-mode credits pass without needing an enumerable article list", () => {
  const cs = buildChecks({
    ...HEALTHY,
    config: { ...CONFIG, creditsSource: { mode: "api", location: "https://x/api/credits" }, articles: null, slugCount: null },
  });
  assert.equal(byId(cs, "credits").status, "pass");
});

test("observations off is a WARN — the toll still works, you just cannot see it", () => {
  const cs = buildChecks({ ...HEALTHY, config: { ...CONFIG, observations: "off" } });
  const c = byId(cs, "observations");
  assert.equal(c.status, "warn");
  assert.match(c.fix, /toll still works/);
});

test("mock payment mode warns that no author is actually paid", () => {
  const cs = buildChecks({ ...HEALTHY, paymentMode: "mock" });
  const c = byId(cs, "payment");
  assert.equal(c.status, "warn");
  assert.match(c.fix, /no author is actually paid/);
});

test("a zero price fails — the gate has nothing to quote", () => {
  const cs = buildChecks({ ...HEALTHY, config: { ...CONFIG, priceUsdc: 0 } });
  assert.equal(byId(cs, "price").status, "fail");
});

test("pending restart warns that saved edits are not being enforced", () => {
  const cs = buildChecks({ ...HEALTHY, restartPending: true });
  const c = byId(cs, "restart");
  assert.equal(c.status, "warn");
  assert.match(c.fix, /not being enforced/);
});

test("a wide bind with no auth is a FAIL and names the wallet exposure", () => {
  const cs = buildChecks({ ...HEALTHY, accessMode: "private", bind: "0.0.0.0" });
  const c = byId(cs, "exposure");
  assert.equal(c.status, "fail");
  assert.match(c.fix, /payout wallets/);
});

test("authed and public exposure both pass", () => {
  assert.equal(byId(buildChecks({ ...HEALTHY, accessMode: "authed", bind: "0.0.0.0" }), "exposure").status, "pass");
  assert.equal(byId(buildChecks({ ...HEALTHY, accessMode: "public", bind: "0.0.0.0" }), "exposure").status, "pass");
});

test("a malformed credits entry surfaces as its own check", () => {
  const cs = buildChecks({ ...HEALTHY, config: { ...CONFIG, warnings: ['credits entry "x" is invalid: bad wallet'] } });
  const c = cs.find((x) => x.id.startsWith("config-warning-"))!;
  assert.equal(c.status, "warn");
  assert.match(c.detail, /bad wallet/);
});

test("warnings the checks already cover are not duplicated", () => {
  const cs = buildChecks({
    ...HEALTHY,
    config: { ...CONFIG, observations: "off", warnings: ["OBSERVATIONS_BACKEND is off — the traffic panel stays empty."] },
  });
  assert.equal(cs.filter((x) => x.id.startsWith("config-warning-")).length, 0, "the observations check already says this");
});

test("the headline names the single blocker when there is exactly one", () => {
  const cs = buildChecks({ ...HEALTHY, health: { up: false } });
  assert.match(headlineFor(cs), /^One thing is stopping this gate from earning/);
});

test("the headline counts multiple blockers", () => {
  const cs = buildChecks({ ...HEALTHY, health: { up: false }, config: { ...CONFIG, slugCount: 0, articles: [] } });
  assert.match(headlineFor(cs), /^2 things are stopping/);
});

test("warnings alone read as working-but-worth-a-look", () => {
  const cs = buildChecks({ ...HEALTHY, paymentMode: "mock" });
  assert.match(headlineFor(cs), /Everything essential is working/);
});
