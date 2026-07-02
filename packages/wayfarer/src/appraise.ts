/**
 * Appraisal — estimate how relevant each candidate is to the research topic,
 * from its free teaser alone. Returns a 0..1 score plus a one-line rationale
 * that surfaces in the decision log.
 *
 * With OPENAI_API_KEY set, an LLM judges relevance. Without it, a keyword-overlap
 * heuristic stands in, so the agent still makes a real (if blunter) judgement
 * offline — no network, no key, still decides.
 */
import { getConfig } from "@naulon/shared";
import type { Candidate, PricedCandidate, AppraisedCandidate } from "./types.ts";

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "what", "how", "why", "about", "into", "we", "i", "it", "its", "that",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Keyword-overlap relevance in [0,1]: matched topic terms / topic terms. */
function heuristicScore(topic: string, c: Candidate): { relevance: number; rationale: string } {
  const topicTerms = tokens(topic);
  const docTerms = tokens(`${c.title} ${c.summary}`);
  if (topicTerms.size === 0) return { relevance: 0, rationale: "empty topic" };

  const hits = [...topicTerms].filter((t) => docTerms.has(t));
  const relevance = hits.length / topicTerms.size;
  const rationale = hits.length
    ? `shares ${hits.length}/${topicTerms.size} topic terms (${hits.join(", ")})`
    : "no topic-term overlap in the teaser";
  return { relevance, rationale };
}

async function llmScore(
  topic: string,
  c: Candidate,
): Promise<{ relevance: number; rationale: string } | null> {
  try {
    const { ChatOpenAI } = await import("@langchain/openai");
    const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
    const res = await model.invoke(
      `Topic: "${topic}"\nEssay: "${c.title}" — ${c.summary}\n` +
        `Rate 0-100 how useful this essay is for the topic, then one short reason. ` +
        `Reply exactly as: SCORE|reason`,
    );
    const text = String(res.content);
    const [scoreStr, ...rest] = text.split("|");
    const score = Number(scoreStr?.trim());
    if (!Number.isFinite(score)) return null;
    return { relevance: Math.max(0, Math.min(1, score / 100)), rationale: rest.join("|").trim() };
  } catch {
    return null; // any failure → caller falls back to heuristic
  }
}

export async function appraise(
  topic: string,
  candidates: PricedCandidate[],
): Promise<AppraisedCandidate[]> {
  const useLlm = Boolean(getConfig().OPENAI_API_KEY);
  return Promise.all(
    candidates.map(async (c) => {
      const scored = (useLlm ? await llmScore(topic, c) : null) ?? heuristicScore(topic, c);
      return { ...c, relevance: scored.relevance, rationale: scored.rationale };
    }),
  );
}
