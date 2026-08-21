import { test } from "node:test";
import assert from "node:assert/strict";
import { CSP, CSP_DIRECTIVES, shouldNotStore } from "./security-headers.ts";

const directive = (name: string): string | undefined =>
  CSP_DIRECTIVES.find((d) => d.startsWith(`${name} `) || d === name);

test("form-action allows this origin — 'none' silently breaks every sign-in form", () => {
  // The incident: form-action was 'none' from when the console had no forms. It does NOT
  // fall back to default-src, so the browser refused the login, first-run and account POSTs
  // before sending them. The server saw nothing, so no request-level test could fail.
  assert.equal(directive("form-action"), "form-action 'self'");
  assert.notEqual(directive("form-action"), "form-action 'none'");
});

test("form-action is never widened past this origin", () => {
  // 'self' is the point: a form on the console must not be able to POST an operator's
  // password to another host.
  const value = directive("form-action") ?? "";
  assert.doesNotMatch(value, /\*/);
  assert.doesNotMatch(value, /https?:/);
});

test("the directives that keep the console locked down are still there", () => {
  assert.equal(directive("default-src"), "default-src 'self'");
  assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive("base-uri"), "base-uri 'none'");
  // No inline anything: the login page ships its own stylesheet and no script at all,
  // rather than buying convenience with 'unsafe-inline'.
  assert.doesNotMatch(CSP, /unsafe-inline/);
  assert.doesNotMatch(CSP, /unsafe-eval/);
  assert.equal(directive("style-src"), "style-src 'self'");
  assert.equal(directive("script-src"), "script-src 'self'");
});

test("the policy serialises to one header value", () => {
  assert.equal(CSP, CSP_DIRECTIVES.join("; "));
  assert.doesNotMatch(CSP, /;\s*;/, "an empty directive would silently drop a rule");
});

test("HTML is never stored, static assets still are", () => {
  // The regression: /account carried no Cache-Control, so Back after a sign-out
  // re-rendered the operator roster from history. Keyed on content type so a new HTML
  // route cannot forget to join the rule.
  assert.equal(shouldNotStore("text/html; charset=UTF-8"), true);
  assert.equal(shouldNotStore("text/html"), true);
  assert.equal(shouldNotStore("text/css; charset=utf-8"), false, "the login page must render on a cold cache");
  assert.equal(shouldNotStore("font/woff2"), false);
  assert.equal(shouldNotStore("application/json"), false);
  assert.equal(shouldNotStore(null), false);
  assert.equal(shouldNotStore(undefined), false);
});
