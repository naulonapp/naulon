/**
 * Discovery entry point — find candidate essays for a topic. The agent reads
 * only the free, public teaser (title + summary) here; it hasn't paid yet.
 *
 * The source is chosen from config (RSS feed, catalog endpoint, or the bundled
 * demo); see discovery.ts for the seam and the selection precedence.
 */
import type { Candidate } from "./types.ts";
import { selectSource } from "./discovery.ts";

export async function discover(topic: string): Promise<Candidate[]> {
  return selectSource().discover(topic);
}
