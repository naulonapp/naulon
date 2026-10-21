/**
 * Integration test for the INTERACTIVE `naulon init` path — spawns the real CLI, pipes
 * keystrokes to its readline prompts, and asserts the files it writes. Complements
 * init.test.ts (flag parsing) and plan.test.ts (pure core) by covering the one seam those
 * can't: the prompt loop itself (defaults, validate→reprompt, the overwrite [y/N] confirm).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./naulon.ts", import.meta.url));

function runInteractive(dir: string, lines: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "init", "--dir", dir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000); // never hang the suite
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
    // A couple of trailing blanks are harmless (leftover, unread); too few would hang.
    child.stdin.write(lines.join("\n") + "\n\n");
    child.stdin.end();
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "naulon-init-"));
}

test("interactive: all defaults (Enter through) → mock .env + an EMPTY credits file", async () => {
  const dir = tmp();
  // origin, price, citation, prefixes, port, mode, wallet, slug, title — all blank = accept default
  const { code, out } = await runInteractive(dir, ["", "", "", "", "", "", "", "", ""]);
  assert.equal(code, 0);
  const env = readFileSync(join(dir, ".env"), "utf8");
  assert.match(env, /^PAYMENT_MODE=mock$/m);
  assert.match(env, /^ORIGIN_URL=http:\/\/localhost:3000$/m);
  // Skipping the wallet prompt used to scaffold the burn address here, so the file stayed valid
  // forever and a later PAYMENT_MODE=gateway tolled readers into it. No wallet now means no
  // entries, which the contract already reads as "free".
  const credits = JSON.parse(readFileSync(join(dir, "credits.json"), "utf8"));
  assert.deepEqual(credits, {});
  assert.match(out, /read(s)? FREE/i);
});

test("interactive: validation re-prompts, gateway branch asks network, real wallet lands", async () => {
  const dir = tmp();
  const { code } = await runInteractive(dir, [
    "not-a-url", // rejected → re-prompt
    "https://good.com", // accepted
    "0", // price rejected (not > 0) → re-prompt
    "0.003", // accepted
    "", // citation default
    "", // prefixes default
    "", // port default
    "gateway", // mode → triggers the network prompt
    "", // network default (arcTestnet)
    "0x2222222222222222222222222222222222222222", // wallet
    "hello", // slug
    "Hello", // title
  ]);
  assert.equal(code, 0);
  const env = readFileSync(join(dir, ".env"), "utf8");
  assert.match(env, /^PAYMENT_MODE=gateway$/m);
  assert.match(env, /^SETTLEMENT_NETWORK=arcTestnet$/m);
  assert.match(env, /^ORIGIN_URL=https:\/\/good\.com$/m);
  assert.match(env, /^DEFAULT_PRICE_USDC=0\.003$/m);
  const credits = JSON.parse(readFileSync(join(dir, "credits.json"), "utf8"));
  assert.equal(credits["hello"].contributors[0].wallet, "0x2222222222222222222222222222222222222222");
});

test("interactive: refuses to clobber on 'n', overwrites on 'y'", async () => {
  const dir = tmp();
  writeFileSync(join(dir, ".env"), "SENTINEL=keep-me\n");
  const defaults = ["", "", "", "", "", "", "", "", ""]; // 9 answer prompts (mock)

  // credits.json doesn't exist yet → only .env triggers the overwrite confirm.
  const declined = await runInteractive(dir, [...defaults, "n"]);
  assert.equal(declined.code, 0);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /SENTINEL=keep-me/); // kept
  assert.ok(existsSync(join(dir, "credits.json"))); // the non-existing one still got written

  // Now both exist → answer 'y' to both overwrite prompts.
  const accepted = await runInteractive(dir, [...defaults, "y", "y"]);
  assert.equal(accepted.code, 0);
  assert.doesNotMatch(readFileSync(join(dir, ".env"), "utf8"), /SENTINEL/); // overwritten
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^PAYMENT_MODE=mock$/m);
});

function runYes(dir: string, extra: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "init", "--yes", "--dir", dir, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
  });
}

test("beside a docker-compose.yml: credits land where compose mounts them, with Docker next steps", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
  const { code, out } = await runYes(dir, ["--wallet", "0x1111111111111111111111111111111111111111"]);
  assert.equal(code, 0, out);
  assert.ok(existsSync(join(dir, "config", "credits.json")), "credits.json in ./config");
  assert.ok(!existsSync(join(dir, "credits.json")));
  assert.match(out, /docker compose up -d/);
  assert.doesNotMatch(out, /make dev/);
  const env = readFileSync(join(dir, ".env"), "utf8");
  assert.match(env, /^CREDITS_FIXTURES=\.\/config\/credits\.json$/m);
  assert.match(env, /^CONSOLE_ADMIN_PASSWORD=[A-Za-z0-9_-]{24}$/m, "a generated first password");
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600, ".env holds a password, so only its owner reads it");
});

test("two runs never share a password", async () => {
  const pw = async () => {
    const dir = tmp();
    await runYes(dir);
    return /^CONSOLE_ADMIN_PASSWORD=(.+)$/m.exec(readFileSync(join(dir, ".env"), "utf8"))?.[1];
  };
  const [a, b] = await Promise.all([pw(), pw()]);
  assert.ok(a && b && a !== b);
});
