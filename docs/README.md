# naulon docs

Deeper references behind the [root README](https://github.com/naulonapp/naulon/blob/main/README.md). Start with whichever
side you're on.

### Getting your site tolled

You run a site and want machines to pay to read or cite it.

- **[integration-guide.md](./integration-guide.md)** — start here. The two
  endpoints you serve with `@naulon/sdk`, in Next.js or Express, plus the
  self-check before you go live.
- **[credits-api.md](./credits-api.md)** — the `GET /credits/:slug` contract: a
  slug in, an author-wallet split out, `404` = free. *Who gets paid.*
- **[settlement-contract.md](./settlement-contract.md)** — the signed
  `POST /api/credits/settlement` naulon sends you when a payment settles. *Your
  earnings ledger, and the HMAC trust boundary.*

### Operating a gate

You run the toll proxy in front of a site.

- **[operating.md](./operating.md)** — the operator console: health, live toll
  traffic, earnings, and config sanity — and how to expose it safely.
- **[DEPLOY.md](https://github.com/naulonapp/naulon/blob/main/DEPLOY.md)** — click-by-click to host the gate on Vercel +
  Supabase in front of a real site.

### Protocol

- **[citation-license.md](./citation-license.md)** — the Citation License Token
  (CLT) spec: a signed, independently verifiable receipt an agent keeps as
  provenance and re-presents for a free re-read. Claims, verifier rules, security
  invariants.

---

The wire contracts (`credits-api`, `settlement-contract`, `citation-license`) are
the breaking-change boundary self-hosters depend on. The runnable counterparts:
[`packages/sdk/examples/next-credits/`](https://github.com/naulonapp/naulon/tree/main/packages/sdk/examples/next-credits) for
the publisher side, [`examples/meridian/`](https://github.com/naulonapp/naulon/tree/main/examples/meridian) for a full toll.
