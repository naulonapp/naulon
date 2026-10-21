import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { clientAddress } from "./client-address.ts";

const app = new Hono();
app.get("/", (c) => c.text(clientAddress(c) ?? "none"));

test("with no socket, the forwarded address is the caller (a serverless adapter)", async () => {
  const res = await app.request("/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
  assert.equal(await res.text(), "10.0.0.1");
});

test("nothing identifying the caller records no address rather than a guess", async () => {
  assert.equal(await (await app.request("/")).text(), "none");
});
