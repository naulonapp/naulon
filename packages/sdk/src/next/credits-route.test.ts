/**
 * The credits-route adapter pins the 404=free contract and the optional bearer
 * gate. It wraps any CreditsResolver, so a fixtureResolver is the cleanest probe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCreditsRoute } from "./credits-route.ts";
import { fixtureResolver } from "../resolver/fixture.ts";
import type { ArticleCredits } from "../contract/credits.ts";

const CREDITS: ArticleCredits = {
  slug: "on-stillness",
  title: "On Stillness",
  contributors: [{ authorId: "mira", wallet: "0x1111111111111111111111111111111111111111" as ArticleCredits["contributors"][number]["wallet"] }],
};
const resolver = fixtureResolver({ "on-stillness": CREDITS });

function get(slug: string, headers?: Record<string, string>) {
  const req = new Request(`http://pub.test/api/credits/${slug}`, { headers });
  return { req, ctx: { params: Promise.resolve({ slug }) } };
}

test("a known slug → 200 with the ArticleCredits body", async () => {
  const handler = createCreditsRoute(resolver);
  const { req, ctx } = get("on-stillness");
  const res = await handler(req, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), CREDITS);
});

test("an unknown slug → 404 not_found (the free-read signal)", async () => {
  const handler = createCreditsRoute(resolver);
  const { req, ctx } = get("does-not-exist");
  const res = await handler(req, ctx);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("with a token configured, a correct bearer → 200", async () => {
  const handler = createCreditsRoute(resolver, { token: "s3cret" });
  const { req, ctx } = get("on-stillness", { authorization: "Bearer s3cret" });
  const res = await handler(req, ctx);
  assert.equal(res.status, 200);
});

test("with a token configured, a wrong/missing bearer → 401 before resolving", async () => {
  const handler = createCreditsRoute(resolver, { token: "s3cret" });
  const wrong = get("on-stillness", { authorization: "Bearer nope" });
  assert.equal((await handler(wrong.req, wrong.ctx)).status, 401);
  const missing = get("on-stillness");
  assert.equal((await handler(missing.req, missing.ctx)).status, 401);
});

test("with no token configured, no auth is required", async () => {
  const handler = createCreditsRoute(resolver);
  const { req, ctx } = get("on-stillness");
  assert.equal((await handler(req, ctx)).status, 200);
});
