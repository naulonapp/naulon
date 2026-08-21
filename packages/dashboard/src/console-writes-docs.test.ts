import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The console writes, and for a long time six documented places said it did not.
 *
 * `server.ts` mounts POST routes for the crawler policy (which bots are charged at all)
 * and for `credits.json` (who gets paid). Meanwhile `packages/dashboard/README.md`,
 * `docs/operating.md` and the root `README.md` all called it "a read-only window", and
 * the worst of them was the root README's SECURITY section — the one paragraph an
 * operator reads when deciding how hard to protect it. Someone sizing exposure off that
 * sentence protects a viewer and gets a payout editor.
 *
 * So the claim is now tied to the code. If the write routes go away, this test says so
 * and the docs may go back to claiming read-only. While they exist, they may not.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const SERVER = readFileSync(join(HERE, "server.ts"), "utf8");
const DOCS = [
  ["packages/dashboard/README.md", join(REPO, "packages/dashboard/README.md")],
  ["docs/operating.md", join(REPO, "docs/operating.md")],
  ["README.md", join(REPO, "README.md")],
] as const;

/** The routes that make the console a writer, not a viewer. */
const WRITE_ROUTES = ['app.post("/api/crawlers"', 'app.post("/api/content"'];

test("the console still has the write routes this rule is about", () => {
  for (const route of WRITE_ROUTES) {
    assert.ok(SERVER.includes(route), `${route} is gone — if the console no longer writes, relax the docs rule below`);
  }
});

test("no doc calls the console read-only while it rewrites credits and policy", () => {
  for (const [name, path] of DOCS) {
    const text = readFileSync(path, "utf8");
    // "a read-only leak" / "shows read-only" describe something else; the banned shape is
    // the console ITSELF being called read-only.
    const offenders = [
      /console is read-only/i,
      /read-only window/i,
      /read-only (?:server|console|dashboard)/i,
      /you don't configure anything here/i,
    ].filter((re) => re.test(text));
    assert.deepEqual(
      offenders.map(String),
      [],
      `${name} calls the console read-only, but it rewrites credits.json and the crawler policy`,
    );
  }
});

test("the console's own hero does not claim it either", () => {
  const html = readFileSync(join(HERE, "public", "overview.html"), "utf8");
  assert.ok(
    !/console is read-only/i.test(html),
    "overview.html renders the read-only claim directly above a nav group of three writing pages",
  );
});
