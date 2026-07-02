import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInitFlags } from "./init.ts";

test("parseInitFlags: booleans + a full answer set", () => {
  const f = parseInitFlags([
    "--yes", "--force",
    "--origin", "https://mysite.com",
    "--price", "0.005",
    "--mode", "gateway",
    "--network", "base",
    "--port", "9000",
    "--prefixes", "essays,posts",
    "--wallet", "0x1111111111111111111111111111111111111111",
    "--slug", "hello", "--title", "Hello", "--author-id", "me",
  ]);
  assert.equal(f.yes, true);
  assert.equal(f.force, true);
  assert.equal(f.originUrl, "https://mysite.com");
  assert.equal(f.priceUsdc, "0.005");
  assert.equal(f.paymentMode, "gateway");
  assert.equal(f.settlementNetwork, "base");
  assert.equal(f.tollgatePort, "9000");
  assert.equal(f.articlePrefixes, "essays,posts");
  assert.equal(f.defaultWallet, "0x1111111111111111111111111111111111111111");
  assert.equal(f.starterSlug, "hello");
});

test("parseInitFlags: -y/-f short forms + default dir is cwd", () => {
  const f = parseInitFlags(["-y", "-f"]);
  assert.equal(f.yes, true);
  assert.equal(f.force, true);
  assert.equal(f.dir, process.cwd());
});

test("parseInitFlags: --help sets help, unknown flags are ignored (not crashed)", () => {
  const f = parseInitFlags(["--help", "--bogus", "x"]);
  assert.equal(f.help, true);
  assert.equal(f.yes, false);
});
