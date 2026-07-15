# @naulon/wayfarer

The paying agent. Give it a topic and a budget; it discovers tolled articles,
decides which are worth citing, pays only those, and answers from what it bought.

The point isn't automation for its own sake — it's that the agent makes a real
budget decision at each step instead of paying for everything. It ranks candidates
by relevance-per-dollar, buys greedily under the budget down to a relevance floor,
reuses anything already paid for, and logs *why* for every candidate. The
reasoning is the artifact.

## Run

```bash
npm run -w @naulon/tollgate dev &                    # the gate to pay
npm run -w @naulon/wayfarer -- "payment and passage" # the agent
```

```text
decisions:
  [PAY]  the-naulon — relevance 1.00 @ $0.005; $0.095 left
  [SKIP] on-stillness — relevance 0.00 below floor 0.35
  ✓ paid $0.005000 for the-naulon
```

It runs offline against mock settlement. Set `OPENAI_API_KEY` for LLM appraisal
and answer synthesis instead of the keyword heuristic; set `PAYMENT_MODE=gateway`
with a funded buyer wallet to pay for real over Circle's Gateway on Arc.

## What's inside

- **`discover.ts` / `discovery.ts`** — find tollable candidates from a gate or feed.
- **`appraise.ts` / `decide.ts` / `allocation.ts`** — relevance, the pay/skip call, budget allocation.
- **`buyer.ts` / `gateway.ts`** — the x402 payment loop (mock and Circle Gateway).
- **`agent.ts` / `lib.ts`** — the end-to-end research run, also importable as a library.

Exposed as an MCP server by [`@naulon/wayfarer-mcp`](../wayfarer-mcp).

MIT.
