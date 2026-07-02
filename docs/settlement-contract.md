# Settlement contract — `POST /api/credits/settlement`

> The contract naulon uses to tell your site **a payment settled**. After an agent
> pays the toll on-chain, the gate POSTs a signed event to your receiver; you store
> it as your canonical earnings ledger. This is the money-in trust boundary, so the
> rules are exact: verify the HMAC over the raw bytes, reject a stale timestamp,
> validate the body, and **dedupe on the event id** — an authentic POST is replayable
> for the length of the skew window. The verify side lives in `@naulon/sdk`
> (`verifySettlement`, `settlementBodySchema`), mirroring the gate's signer exactly.

## Direction

You are the receiver. naulon — your own gate if you self-host, or the cloud fleet if
you're a tenant — calls **you**. The SDK is receive-side only; it never makes an
outbound call to a "naulon API," and there is no naulon base URL in it. You declare
your receiver's URL to naulon; you never point the SDK at naulon's.

```
naulon (your gate OR the fleet)  ──POST /api/credits/settlement──▶  your receiver
```

## Headers

| Header | Value |
|---|---|
| `x-naulon-timestamp` | Unix **seconds** when the event was signed. |
| `x-naulon-signature` | `sha256=` + HMAC-SHA256, hex, over the string `` `${timestamp}.${rawBody}` ``. |

The signature is over the **exact bytes** of the request body. Read the raw text and
verify *that* — never re-serialize the parsed JSON first, or a whitespace difference
breaks the HMAC.

## Body

```jsonc
{
  "eventId": "11111111-2222-4333-8444-555555555555", // stable id — your dedupe key
  "slug": "on-stillness",
  "txHash": "0xfeed…",
  "chainId": 5042002,
  "currency": "USDC",
  "grossAmount": "5000",                  // integer micro-USDC, as a string
  "paidTo": "0x1111111111111111111111111111111111111111",   // the on-chain recipient
  "payer": "0x3333333333333333333333333333333333333333",    // or null
  "settledAt": "2026-06-25T12:00:00.000Z",
  "splits": [
    { "authorId": "mira",
      "wallet": "0x1111111111111111111111111111111111111111",
      "amount": "5000",                   // integer micro-USDC, as a string
      "weight": 1000,                     // permille; decorative — `amount` is the truth
      "primary": true }                   // exactly one split carries this
  ]
}
```

Two invariants the schema enforces (a violation is rejected as malformed):

- **Σ `splits[].amount` === `grossAmount`** — the split conserves the gross, to the
  micro-USDC. No dust.
- **Exactly one split is `primary: true`** — the wallet the on-chain leg paid. The
  remaining splits are the recorded co-author shares.

## Verifying — and why the status codes matter

The gate's retry behavior keys off the response status, so return the right one:

| Outcome | Status | Meaning |
|---|---|---|
| Missing / non-numeric timestamp | **401** | transient — the gate retries |
| Timestamp skewed more than **300s** from now | **401** | transient — retries |
| Signature doesn't match any accepted secret | **401** | transient — retries |
| Body isn't valid JSON | **400** | permanent — the gate gives up |
| Body fails the schema (bad shape, Σ mismatch, no/dup primary) | **400** | permanent — gives up |
| Valid | **200** | stored (or already stored — see idempotency) |

**401 is transient, 400 is permanent.** A clock or signature problem is worth
retrying; a malformed body never is. Get this backwards and you either drop a real
payment or make the gate hammer a hopeless one.

`verifySettlement` returns this exactly:

```ts
import { verifySettlement } from "@naulon/sdk";

const result = verifySettlement({
  rawBody,                                         // await req.text()
  timestampHeader: req.headers.get("x-naulon-timestamp"),
  signatureHeader: req.headers.get("x-naulon-signature"),
  secrets: [process.env.CREDITS_SETTLEMENT_SECRET!],
});
// result is { ok: true, event } | { ok: false, status: 400 | 401, reason }
```

## Secret rotation

`secrets` is an array because rotating a shared secret can't be atomic across two
systems. To roll: start signing with the new secret on the naulon side while your
receiver accepts **both**:

```ts
secrets: [process.env.SETTLEMENT_SECRET_NEW!, process.env.SETTLEMENT_SECRET_OLD!]
```

Each candidate is checked in constant time. Once the overlap window passes and you're
confident nothing is signing with the old one, drop it.

## Idempotency is mandatory — this is a money path

`verifySettlement` proves a request is **authentic**. It does not make storing it
**exactly once** — that's stateful, and it's on you. The 300-second skew window means
an authentic POST is **replayable for five minutes**: a network retry, a redelivery,
or a captured-and-replayed request all present the same valid event. Without a dedupe
guard, that's a **double payout**.

So dedupe on `eventId`, backed by your database:

```sql
-- The durable guard: a unique constraint turns a replay into a no-op insert.
create unique index on article_payouts (event_id);
```

```ts
// Claim the eventId first; only pay out if this is the first time we've seen it.
// INSERT … ON CONFLICT (event_id) DO NOTHING → rowCount 1 = first, 0 = replay.
const isFirst = await db.claimEvent(event.eventId);
if (!isFirst) return Response.json({ ok: true, deduped: true });       // a replay
await recordPayout(event);                                             // pay exactly once
```

The SDK models this as an `IdempotencyStore` the receiver adapter **requires**. It
ships a `memoryIdempotencyStore()` so the type is satisfiable in development — but it
is **NOT durable** (lost on restart, useless across instances). Using it in
production is the double-payout footgun above. Back `claim(eventId)` with the unique
constraint.

## Building it

### With the SDK

`@naulon/sdk/next` wraps verify + the mandatory idempotency gate into one
handler:

```ts
// app/api/credits/settlement/route.ts
import { createSettlementReceiver } from "@naulon/sdk/next";

export const POST = createSettlementReceiver({
  secrets: [process.env.SETTLEMENT_SECRET_NEW!, process.env.SETTLEMENT_SECRET_OLD!],
  idempotency: myDurableStore,            // back claim(eventId) with a DB unique constraint
  onEvent: async (event) => {
    // Runs at most once per eventId. Persist the payout + splits to your ledger.
    await savePayout(event);
  },
});
```

A replay short-circuits to `200 {deduped: true}` before `onEvent` runs; a verify
failure returns the right 401/400 with no side effect.

### Hand-rolled

If you'd rather own the loop, `verifySettlement` gives you the verdict and you supply
the persistence and the dedupe (see the SQL above). The contract is identical either
way — the adapter just saves you the wiring.

## Testing it offline — there is no dry-run

A money receiver gets no public "pretend" mode, so there's no dry-run header to POST
in production. Instead, exercise your receiver in **your own** test harness with a
signed fixture:

```ts
import { makeSignedSettlementFixture } from "@naulon/sdk";

const { rawBody, headers } = makeSignedSettlementFixture({ secret: "test-secret" });
// Feed rawBody + headers into your receiver; assert a 200 and a written payout.
// POST the same bytes twice; assert the second is deduped and pays out nothing.
```

That replay assertion is the one that matters — it's the difference between a correct
ledger and a double payout.
