import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsablePublicIp, parseCidr, parseIp, RangeSet, truncateIp } from "./ipRange.ts";

test("parseIp: IPv4, IPv6, mapped, bracketed, zone id, junk", () => {
  assert.deepEqual(parseIp("66.249.66.1"), { family: 4, value: 0x42f94201n });
  assert.equal(parseIp("2001:4860:4801:10::1")?.family, 6);
  assert.deepEqual(parseIp("::ffff:66.249.66.1"), { family: 4, value: 0x42f94201n });
  assert.equal(parseIp("[2001:db8::1]")?.family, 6);
  assert.equal(parseIp("fe80::1%eth0")?.family, 6);
  for (const bad of ["", "1.2.3", "1.2.3.256", "01.2.3.4x", "1::2::3", "1:2:3:4:5:6:7:8:9", "gggg::", "abc"]) {
    assert.equal(parseIp(bad), null, bad);
  }
});

test("parseCidr: masks host bits, rejects too-broad and malformed", () => {
  const c = parseCidr("66.249.66.7/24");
  assert.ok(c);
  assert.equal(c.start, 0x42f94200n);
  assert.equal(c.end, 0x42f942ffn);
  assert.equal(parseCidr("0.0.0.0/0"), null);
  assert.equal(parseCidr("10.0.0.0/8"), null); // shorter than /12
  assert.equal(parseCidr("::/0"), null);
  assert.equal(parseCidr("2001:db8::/16"), null); // shorter than /28
  assert.ok(parseCidr("2001:4860:4801:10::/64"));
  assert.equal(parseCidr("1.2.3.4/33"), null);
  assert.equal(parseCidr("1.2.3.4"), null);
  assert.ok(parseCidr("::ffff:66.249.66.0/120")); // mapped prefix becomes a v4 /24
  assert.equal(parseCidr("::ffff:66.249.66.0/120")?.family, 4);
});

test("RangeSet: membership across merged and adjacent ranges, both families", () => {
  const { set, rejected } = RangeSet.fromStrings(["66.249.64.0/27", "66.249.64.32/27", "2001:4860:4801:10::/64", "bogus"]);
  assert.equal(rejected, 1);
  assert.equal(set.has(parseIp("66.249.64.40")!), true);
  assert.equal(set.has(parseIp("66.249.64.64")!), false);
  assert.equal(set.has(parseIp("2001:4860:4801:10::abcd")!), true);
  assert.equal(set.has(parseIp("2001:4860:4801:11::1")!), false);
  assert.equal(set.has(parseIp("::ffff:66.249.64.1")!), true);
});

test("isUsablePublicIp: reserved ranges and untrusted proxies are unusable", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "240.0.0.1", "0.1.2.3", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
    assert.equal(isUsablePublicIp(parseIp(ip)!), false, ip);
  }
  assert.equal(isUsablePublicIp(parseIp("66.249.66.1")!), true);
  const cf = RangeSet.fromStrings(["173.245.48.0/20"]).set;
  assert.equal(isUsablePublicIp(parseIp("173.245.48.5")!, [cf]), false);
  assert.equal(isUsablePublicIp(parseIp("173.245.48.5")!), true);
});

test("truncateIp: /24 and /48", () => {
  assert.equal(truncateIp(parseIp("9.9.9.9")!), "9.9.9.0/24");
  assert.equal(truncateIp(parseIp("2a01:4f8:c0c:1234::1")!), "2a01:4f8:c0c::/48");
});
