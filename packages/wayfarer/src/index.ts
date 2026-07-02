/**
 * Wayfarer CLI — an autonomous research agent that pays per citation.
 *
 *   npm run wayfarer -- "what does the author say about payment and passage?"
 *
 * It discovers essays, decides which are worth paying to cite under a budget
 * (visible reasoning, not hardcoded), pays the naulon through the tollgate, and
 * grounds a cited answer. Requires a running tollgate (npm run tollgate).
 */
import { run } from "./lib.ts";

const topic = process.argv.slice(2).join(" ").trim();
if (!topic) {
  console.error('usage: npm run wayfarer -- "<research topic>"');
  process.exit(1);
}

const result = await run(topic, (line) => console.log(line));

console.log("\n" + "─".repeat(60));
console.log(result.answer);
