/** Writes the generated contract files. Run with `npm run contract:fixtures` from the repository root. */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractFiles } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
for (const f of await contractFiles()) {
  const target = join(root, f.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, f.content);
  console.log(`wrote ${f.path}`);
}
