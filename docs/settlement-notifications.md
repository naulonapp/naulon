# Settlement notifications — the signed webhook

> How naulon tells your site **a payment settled**. After an agent pays the toll and
> the gate settles on-chain, a signed `settlement.completed` webhook is POSTed to the
> endpoint you registered; you store it as your canonical earnings ledger. This is a
> money-adjacent boundary, so the rules are exact: verify the HMAC over the raw
> bytes, reject a stale timestamp, and **dedupe on `eventId`** — delivery is
> at-least-once by design. The verify side lives in `@naulon/sdk`
> (`verifyPayload`, `createWebhookReceiver`), and it is the same signing function
> the sender uses, not a mirror of it.

There used to be a second wire — an HMAC-signed `POST {origin}/api/credits/settlement`
straight at your site. It is **deleted**. One fact, one delivery mechanism: if you
want to know that money moved, subscribe to this webhook.

## Direction

You are the receiver. naulon — your own gate if you self-host, or the cloud fleet if
you're a tenant — calls **you**. The SDK is receive-side only; it never makes an
outbound call to a "naulon API", and there is no naulon base URL in it.

```
naulon (your gate OR the fleet)  ──POST your endpoint──▶  your receiver
```

## Subscribing

**Self-host.** One env var, a JSON array — the gate is dark until you set it (no
endpoints ⇒ no timer, no POST):

```bash
NAULON_WEBHOOK_ENDPOINTS='[{"url":"https://you.example/naulon-hook","secret":"whsec_…","events":["settlement.completed"],"hostFilter":null}]'
```

**Cloud tenant.** Settings → API & webhooks. The secret is shown once when you create
the endpoint; store it then.

Either way the endpoint must be **https** — the sender refuses cleartext, and refuses
targets that resolve to a private or loopback address (that block is permanent, not
retried).

## Headers

| Header | Value |
|---|---|
| `Naulon-Signature` | `t=<unix_secs>,v1=<hex HMAC-SHA256>` over `` `${t}.${rawBody}` `` |
| `Naulon-Id` | The delivery id. Changes per delivery; **not** your dedupe key. |
| `Naulon-Event` | The event type, e.g. `settlement.completed`. |

The signature covers the **exact bytes** of the request body. Read the raw text and
verify *that* — never re-serialize the parsed JSON first, or a whitespace difference
breaks the HMAC.

## Body

Every delivery is the same envelope; only `data` varies by event type.

```jsonc
{
  "id": "dlv_…",                    // delivery id — same as Naulon-Id
  "type": "settlement.completed",
  "eventId": "…",                   // the SOURCE event id — stable across redeliveries. Dedupe on this.
  "createdAt": 1719000000000,       // unix MILLIseconds, when the event happened (not send time)
  "data": { }                       // see below
}
```

`type` is an open string on purpose. New event types will appear; switch on the ones
you handle and ignore the rest, and a new one can never break your parse.

### `data` for `settlement.completed`

A self-host gate reports the settled event directly:

```jsonc
{
  "host": "your-site.example",
  "publisherId": "…",
  "eventId": "…",
  "slug": "on-stillness",
  "kind": "read",                   // or "citation"
  "amountMicro": 5000,              // integer micro-USDC — the money source of truth
  "settlementRef": "0x…",           // the on-chain reference
  "chainId": 5042002,
  "at": 1719000000000
}
```

The cloud fleet coalesces a window of settlements and offers two body profiles per
endpoint (`summary` / `detailed`) — see the fleet's own webhooks doc. Both ride this
same envelope and the same signature.

Money is always **integer micro-USDC**. Never parse a formatted string back into a
number.

## Retries — and what your status code does

The sender treats **any non-2xx as a failed attempt** and re-sends with backoff:
5s, 5m, 30m, 2h, 5h, 10h, 10h — 8 attempts, then the delivery is *dead-lettered*
(parked, still owed, revivable by an operator). There is no
"400 means stop trying" shortcut; that was the deleted origin-mirror's contract, not
this one.

So the status you return is a **diagnosis for you**, not a signal to us:

| Outcome | Return | Why |
|---|---|---|
| Stored (or already stored) | **2xx** | the only thing that stops the retries |
| Signature doesn't match | **401** | you have the wrong secret — fix it before the budget runs out |
| Body isn't valid JSON / not an envelope | **400** | it will still be retried; the code is for your logs |
| Your database was down | **5xx** | correct: a retry is exactly what you want |

That last row is the one that matters. If your handler fails, **fail the response**.
Answering 2xx on a write you didn't do is how a settlement disappears.

## Verifying

```ts
import { verifyPayload } from "@naulon/sdk";

const rawBody = await req.text();                       // the exact bytes
const ok = verifyPayload(
  process.env.NAULON_WEBHOOK_SECRET!,
  rawBody,
  req.headers.get("naulon-signature") ?? "",
  Math.floor(Date.now() / 1000),                        // your clock, unix SECONDS
);                                                      // → boolean
```

Anything outside a ±300s window of the signed timestamp is rejected — that bound is
what makes a captured request stop being replayable.

### Secret rotation

Rotating a shared secret can't be atomic across two systems, so the SDK receiver takes
an **array** and accepts any of them:

```ts
secrets: [process.env.NAULON_WEBHOOK_SECRET_NEW!, process.env.NAULON_WEBHOOK_SECRET_OLD!]
```

Each candidate is compared in constant time. Once the overlap window passes and
nothing is signing with the old one, drop it.

## Idempotency is mandatory

`verifyPayload` proves a request is **authentic**. It does not make storing it
**exactly once** — that's stateful, and it's on you. Delivery is at-least-once: a
timeout on our side or a retry after your 500 both present the same event again, and
an authentic POST stays replayable for the whole skew window. Without a dedupe guard,
that's a **double-counted payout** in your ledger.

Dedupe on `eventId`, backed by your database:

```sql
-- The durable guard: a unique constraint turns a redelivery into a no-op insert.
create unique index on article_payouts (event_id);
```

```ts
// Claim the eventId first; only record if this is the first time we've seen it.
// INSERT … ON CONFLICT (event_id) DO NOTHING → rowCount 1 = first, 0 = redelivery.
const isFirst = await db.claimEvent(event.eventId);
if (!isFirst) return Response.json({ ok: true, deduped: true });
await recordPayout(event);
```

The SDK models this as an `IdempotencyStore` the receiver adapter **requires**. It
ships a `memoryIdempotencyStore()` so the type is satisfiable in development — but it
is **NOT durable** (lost on restart, useless across instances). Using it in production
is the double-count footgun above.

Best of all: claim inside the **same transaction** that does the work. Then a rollback
releases the claim for you, and a failed write can't leave an event claimed but
unrecorded.

## Building it

### With the SDK

`@naulon/sdk/next` wraps verify + the mandatory idempotency gate into one handler:

```ts
// app/api/naulon-hook/route.ts
import { createWebhookReceiver } from "@naulon/sdk/next";

export const POST = createWebhookReceiver({
  secrets: [process.env.NAULON_WEBHOOK_SECRET!],   // an array — see rotation above
  idempotency: myDurableStore,                     // back claim(eventId) with a DB unique constraint
  onEvent: async (event) => {
    if (event.type !== "settlement.completed") return;
    await savePayout(event.data);                  // runs at most once per eventId
  },
});
```

A redelivery short-circuits to `200 {deduped: true}` before `onEvent` runs. If
`onEvent` throws, the adapter **releases the claim** and rethrows — so your framework
returns a 5xx and the retry is actually processed instead of being deduped into
silence.

On Express, mount it with `express.raw()` so the HMAC sees the exact bytes
(`express.json()` parses and discards them, breaking every signature):

```ts
import express from "express";
import { createExpressWebhookReceiver } from "@naulon/sdk/express";

app.post(
  "/naulon-hook",
  express.raw({ type: "*/*" }),
  createExpressWebhookReceiver({ secrets: [process.env.NAULON_WEBHOOK_SECRET!], idempotency: myDurableStore, onEvent: savePayout }),
);
```

### Hand-rolled

If you'd rather own the loop, `verifyPayload` gives you the verdict and you supply the
persistence and the dedupe (see the SQL above). The contract is identical either way —
the adapter just saves you the wiring.

## Testing it offline — there is no dry-run

A money-adjacent receiver gets no public "pretend" mode, so there's no dry-run header
to POST in production. Instead, exercise your receiver in **your own** test harness
with a signed fixture:

```ts
import { makeSignedWebhookFixture } from "@naulon/sdk";

const { rawBody, headers } = makeSignedWebhookFixture({ secret: "whsec_test" });
// Feed rawBody + headers into your receiver; assert a 200 and a written row.
// POST the same bytes twice; assert the second is deduped and records nothing.
```

That replay assertion is the one that matters — it's the difference between a correct
ledger and a double count. The CLI prints the same fixture:

```bash
npx naulon-kit check https://your-site.example/api --slug a-real-slug --secret whsec_test
```
