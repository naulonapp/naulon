import { test } from "node:test";
import assert from "node:assert/strict";
import { createExpressCreditsRoute } from "./credits-route.ts";
import type { CreditsResolver } from "../resolver/types.ts";
import type { ArticleCredits } from "../contract/index.ts";

const CREDITS = {
  slug: "on-stillness",
  wallet: "0x1111111111111111111111111111111111111111",
} as unknown as ArticleCredits;

function resolverFor(map: Record<string, ArticleCredits>): CreditsResolver {
  return { resolve: async (slug: string) => map[slug] };
}

function fakeRes() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    status(code: number) { r.statusCode = code; return r; },
    setHeader(name: string, value: string) { r.headers[name.toLowerCase()] = value; },
    send(body: string) { r.body = body; },
  };
  return r;
}

function fakeReq(slug: string, headers: Record<string, string> = {}) {
  return { params: { slug }, headers, body: undefined };
}

test("known slug → 200 with the ArticleCredits body", async () => {
  const handler = createExpressCreditsRoute(resolverFor({ "on-stillness": CREDITS }));
  const res = fakeRes();
  await handler(fakeReq("on-stillness") as never, res as never);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), CREDITS);
});

test("unknown slug → 404 not_found (the free-read signal)", async () => {
  const handler = createExpressCreditsRoute(resolverFor({}));
  const res = fakeRes();
  await handler(fakeReq("nope") as never, res as never);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "not_found" });
});

test("token set, missing/wrong Authorization → 401", async () => {
  const handler = createExpressCreditsRoute(resolverFor({ "on-stillness": CREDITS }), { token: "sekret" });
  const res = fakeRes();
  await handler(fakeReq("on-stillness", { authorization: "Bearer wrong" }) as never, res as never);
  assert.equal(res.statusCode, 401);
});

test("token set, Authorization header entirely absent → 401", async () => {
  const handler = createExpressCreditsRoute(resolverFor({ "on-stillness": CREDITS }), { token: "sekret" });
  const res = fakeRes();
  await handler(fakeReq("on-stillness", {}) as never, res as never); // no authorization key at all
  assert.equal(res.statusCode, 401);
});

test("token set, correct Bearer → 200", async () => {
  const handler = createExpressCreditsRoute(resolverFor({ "on-stillness": CREDITS }), { token: "sekret" });
  const res = fakeRes();
  await handler(fakeReq("on-stillness", { authorization: "Bearer sekret" }) as never, res as never);
  assert.equal(res.statusCode, 200);
});
