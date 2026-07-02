# next-credits — a minimal naulon publisher (Next.js App Router)

The two endpoints naulon calls on your site, built with `@naulon/sdk`. Both
are **receive-side**: naulon (your own gate, or the cloud fleet) calls *you*. You
never call a naulon URL from here.

```
app/api/credits/[slug]/route.ts        GET  — who to pay for a slug (404 = free read)
app/api/credits/settlement/route.ts    POST — record a settled payout (HMAC-verified)
credits.json                           the static credits fixture this demo resolves against
```

## Run it

```bash
npm install next react react-dom @naulon/sdk
CREDITS_SETTLEMENT_SECRET=dev-secret npm run dev
```

Then:

```bash
# A known slug → 200 with the credits graph.
curl localhost:3000/api/credits/on-stillness
# An unknown slug → 404 {"error":"not_found"} — the deliberate "free read" signal.
curl -i localhost:3000/api/credits/anything-else
```

To exercise the settlement receiver offline (no production POST), feed it a signed
fixture from the SDK:

```ts
import { makeSignedSettlementFixture } from "@naulon/sdk";
const { rawBody, headers } = makeSignedSettlementFixture({ secret: "dev-secret" });
await fetch("http://localhost:3000/api/credits/settlement", { method: "POST", headers, body: rawBody });
// → 200 {"ok":true,"deduped":false}; POST the same bytes again → {"deduped":true}.
```

## Going to production

- Swap `fixtureResolver(credits)` for `httpResolver(process.env.CREDITS_API_URL)` or
  your own `CreditsResolver` (a DB/CMS lookup).
- **Replace `memoryIdempotencyStore()`** — it is NOT durable (lost on restart,
  useless across instances). Back `claim(eventId)` with a DB unique constraint on
  the event id, or you risk a double payout on a replay within the 5-minute window.
- Rotate the settlement secret by passing `secrets: [newSecret, oldSecret]` for the
  overlap window, then drop the old one.
