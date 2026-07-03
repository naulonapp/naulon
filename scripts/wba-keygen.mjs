/**
 * Generate a Web Bot Auth signing identity (WBA slice 3).
 *
 * Prints the env line for the gate + wayfarer (BOT_AUTH_SIGNING_KEY), plus the
 * public JWK and its RFC 7638 thumbprint (the keyid every signature will carry
 * and the entry a verifier sees in our key directory). The seed is a secret —
 * it goes in .env / SSM, never in the repo.
 *
 * Run: node scripts/wba-keygen.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { createPrivateKey, createPublicKey } from "node:crypto";

const seed = randomBytes(32);
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const { x } = createPublicKey(privateKey).export({ format: "jwk" });
const keyid = createHash("sha256")
  .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
  .digest("base64url");

console.log("# Web Bot Auth signing identity — keep the seed secret (.env / SSM)");
console.log(`BOT_AUTH_SIGNING_KEY=${seed.toString("base64url")}`);
console.log(`# advertise the host that serves OUR directory, e.g.:`);
console.log(`# BOT_AUTH_SIGNATURE_AGENT=naulon.app`);
console.log("");
console.log(`# public JWK (what the directory will publish):`);
console.log(`#   ${JSON.stringify({ kty: "OKP", crv: "Ed25519", x })}`);
console.log(`# keyid (RFC 7638 thumbprint): ${keyid}`);
