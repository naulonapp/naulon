# next-credits — a minimal naulon publisher (Next.js App Router)

The two endpoints naulon calls on your site, built with `@naulon/sdk`. Both
are **receive-side**: naulon (your own gate, or the cloud fleet) calls *you*. You
never call a naulon URL from here.

```
app/api/credits/[slug]/route.ts        GET  — who to pay for a slug (404 = free read)
app/api/naulon-hook/route.ts           POST — the signed settlement webhook (HMAC-verified)
credits.json                           the static credits fixture this demo resolves against
```

## Run it

```bash
npm install next react react-dom @naulon/sdk
NAULON_WEBHOOK_SECRET=whsec_dev npm run dev
```

Then:

```bash
# A known slug → 200 with the credits graph.
curl localhost:3000/api/credits/on-stillness
# An unknown slug → 404 {"error":"not_found"} — the deliberate "free read" signal.
curl -i localhost:3000/api/credits/anything-else
```

To exercise the webhook receiver offline (no production delivery), feed it a signed
fixture from the SDK:

```ts
import { makeSignedWebhookFixture } from "@naulon/sdk";
const { rawBody, headers } = makeSignedWebhookFixture({ secret: "whsec_dev" });
await fetch("http://localhost:3000/api/naulon-hook", { method: "POST", headers, body: rawBody });
// → 200 {"ok":true,"deduped":false}; POST the same bytes again → {"deduped":true}.
```

## Going to production

- Swap `fixtureResolver(credits)` for `httpResolver(process.env.CREDITS_API_URL)` or
  your own `CreditsResolver` (a DB/CMS lookup).
- **Replace `memoryIdempotencyStore()`** — it is NOT durable (lost on restart,
  useless across instances). Back `claim(eventId)` with a DB unique constraint on
  the event id, or a redelivery counts the same payout twice.
- Rotate the webhook secret by passing `secrets: [newSecret, oldSecret]` for the
  overlap window, then drop the old one.
- Register the endpoint: `NAULON_WEBHOOK_ENDPOINTS` on your own gate, or
  Settings → API & webhooks as a cloud tenant.
