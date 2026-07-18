# Credits API — `GET /credits/:slug`

> The contract your site serves so the gate knows **who to pay** for a given
> article. One read-only endpoint: a slug in, an author-wallet split out, or a 404
> that means "this one is free." The gate validates every response before a wallet
> can become a payment target, so a malformed or hostile reply is rejected, never
> silently mispaid. Schema lives in `@naulon/sdk` (`creditsSchema`,
> `parseCredits`); the gate consumes it through the `CreditsResolver` seam.

## The endpoint

```
GET ${CREDITS_API_URL}/credits/:slug
```

- **`:slug`** is the article path slug the gate derives from the request URL.
- **Auth** is optional. If you set a bearer token, the gate sends
  `Authorization: Bearer <token>` on every call — set one whenever the endpoint is
  reachable on the public internet (it always is when the cloud fleet calls you).
- **`404` means free.** A 404 is the deliberate "don't gate this slug" signal — the
  gate serves the article to machines for free. This is the seam for everything you
  *don't* want tolled (drafts, membership-only posts, anything without a wallet):
  return 404 and it reads free.
- **`200`** returns JSON in the `ArticleCredits` shape below.
- **Any other non-2xx** is treated as an error — the gate throws rather than guess,
  so a transient outage fails closed instead of mispaying.

## The shape

```jsonc
{
  "slug": "on-stillness",                 // non-empty; should match the request
  "title": "On Stillness",                // non-empty
  "contributors": [                       // at least one
    // a leaf author resolves to a wallet
    { "authorId": "mira", "wallet": "0x1111111111111111111111111111111111111111", "weight": 2 },

    // a composite re-splits among its own members (recursively)
    { "authorId": "the-collective",
      "members": [
        { "authorId": "okonkwo", "wallet": "0x2222222222222222222222222222222222222222" },
        { "authorId": "petrova", "wallet": "0x3333333333333333333333333333333333333333" }
      ] }
  ]
}
```

### Schema rules (a violation = the response is rejected, payment blocked)

| Rule | Detail |
|---|---|
| Leaf **XOR** composite | Each contributor has **exactly one** of `wallet` (leaf) or `members` (composite, ≥1) — never both, never neither. |
| Wallet format | `wallet` matches `^0x[0-9a-fA-F]{40}$`. |
| Weight | `weight` is optional, positive, default `1`. It's a *relative* weight among siblings, normalized to shares. |
| Author id | `authorId` is a non-empty string. |
| Strict | The object is `.strict()` — any unknown key is rejected. |
| Recursion | A member can itself be a composite, nested to any depth. |

The gate runs exactly this schema (`parseCredits`) on every response. A leaf wallet
becomes a `payTo` only after it validates, which is why a typo or an injected field
fails the read instead of routing money somewhere wrong.

### How the split is computed

Weights normalize to integer **micro-USDC** shares; the rounding remainder is
assigned to the largest share so the parts always sum to the whole (no dust). The
on-chain payment leg pays the **primary author** as a single `payTo`, while the full
recursive co-author split is recorded on the settlement event (see
[settlement-contract.md](./settlement-contract.md)). Money is never floated — it is
integer micro-USDC end to end.

## Building it

### With the SDK

`@naulon/sdk/next` ships a one-line App Router handler that pins the
404-means-free semantics for you:

```ts
// app/api/credits/[slug]/route.ts
import { createCreditsRoute } from "@naulon/sdk/next";
import { httpResolver } from "@naulon/sdk";

// Resolve a slug however you like — here, your own CMS endpoint. Or pass a
// fixtureResolver(map) for static credits, or implement CreditsResolver yourself.
export const GET = createCreditsRoute(httpResolver(process.env.MY_CMS_URL!), {
  token: process.env.CREDITS_API_TOKEN, // optional bearer gate
});
```

The resolver is your policy. Everything site-specific — which slugs are free, how an
author maps to a wallet, membership rules — lives in *your* `CreditsResolver`; the
adapter only frames the HTTP (bearer check, `404 = not_found`, else `200`).

### Hand-rolled (no dependency)

The adapter is ~20 lines of HTTP framing; if you'd rather not take the dependency,
the contract is small enough to serve directly:

```ts
// app/api/credits/[slug]/route.ts
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const credits = await lookupCredits(slug);            // your CMS/DB lookup
  if (!credits) return Response.json({ error: "not_found" }, { status: 404 }); // free read
  return Response.json(credits);                         // must match ArticleCredits
}
```

You still want to validate your own output against the contract before shipping —
`buildCredits(obj)` from `@naulon/sdk` runs the same schema and throws on a
malformed payload, so a bad shape surfaces in your tests, not mid-payment.

## Security — this is a money-routing trust boundary

The credits response decides where a payment goes. Two things follow:

- **Secure the endpoint.** The gate validates that a response is *well-formed*, but
  it cannot tell that a *valid* wallet was swapped by a compromised or MITM'd
  endpoint. The integrity of this endpoint is the one path that can reroute a
  payment — keep its auth tight and serve it over TLS.
- **Never emit a wallet you don't mean.** An author with no wallet set should be
  omitted from `contributors`, or the slug should 404 (read free) until a wallet
  exists — never a zero or placeholder address. The gate guards the zero address as
  a backstop, but don't rely on it.

## Reference

A complete, runnable consumer (this endpoint + the settlement receiver, against a
static fixture) lives in
[`packages/sdk/examples/next-credits/`](https://github.com/naulonapp/naulon/tree/main/packages/sdk/examples/next-credits). Copy
it, swap the resolver for your own source, and you have a tollable site.
