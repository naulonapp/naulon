/**
 * The gate serves an edge-identity marker itself (never proxied to origin), so a caller can
 * confirm a custom domain actually ROUTES through the gate. Host-independent (like /healthz):
 * reaching it means traffic reached this gate. Registered before the catch-all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "./app.ts";

test("GET /.well-known/naulon-edge returns the naulon marker + echoes the Host", async () => {
  const res = await app.request("/.well-known/naulon-edge", {
    headers: { host: "meridian.example" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { gate: string; host: string };
  assert.equal(body.gate, "naulon", "the marker only a naulon gate emits");
  assert.equal(body.host, "meridian.example", "echoes the Host the gate saw, so the caller confirms the domain it probed");
});

test("edge probe is host-independent — an unknown host still gets the marker (routing != tenant config)", async () => {
  const res = await app.request("/.well-known/naulon-edge", {
    headers: { host: "never-onboarded.example" },
  });
  assert.equal(res.status, 200, "reaching the gate is the signal; whether the host is a known tenant is separate");
  const body = (await res.json()) as { gate: string; host: string };
  assert.equal(body.gate, "naulon");
  assert.equal(body.host, "never-onboarded.example");
});
