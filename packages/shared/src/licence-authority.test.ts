import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLicenceAuthorization } from "./licence-authority.ts";

test("reads the token from Authorization: License", () => {
  assert.equal(parseLicenceAuthorization("License abc.def"), "abc.def");
});
test("the scheme is case-insensitive, per RFC 7235", () => {
  assert.equal(parseLicenceAuthorization("license abc"), "abc");
});
test("Bearer, an empty token and a missing header are not a licence", () => {
  assert.equal(parseLicenceAuthorization("Bearer abc"), null);
  assert.equal(parseLicenceAuthorization("License "), null);
  assert.equal(parseLicenceAuthorization(null), null);
});
test("a token with whitespace inside is refused, not truncated", () => {
  assert.equal(parseLicenceAuthorization("License abc def"), null);
});
