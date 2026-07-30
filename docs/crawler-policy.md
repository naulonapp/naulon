# Crawler policy

By default the gate decides what to do with a request by classifying it: humans read
free, automated readers pay. A crawler policy overrides that per crawler — this one
reads free, that one pays, this other one is refused outright.

The gate has always **enforced** a policy. What it never had was a way to write one:
`decide()` refuses a blocked user-agent before it even classifies, but nothing in the
open core authored the config, so a self-hoster's only route to a blocklist was
implementing their own resolver. `CRAWLER_POLICY_PATH` is that missing half.

## The file

A JSON object with three optional arrays of user-agent fragments:

```json title="data/crawler-policy.json"
{
  "allow": ["googlebot", "bingbot"],
  "charge": ["gptbot", "claudebot"],
  "block": ["scrapy", "python-requests"]
}
```

Point the gate at it (the default is `data/crawler-policy.json` in the repo root):

```bash
CRAWLER_POLICY_PATH=/etc/naulon/crawler-policy.json
```

Each state means:

- **`allow`** — served free, no toll, no 402. Use it for the search crawlers whose
  indexing you want.
- **`charge`** — must pay the toll even if the classifier would have let it through.
- **`block`** — refused with a 403. It never reaches your origin and never gets a
  quote.

Matching is **case-insensitive substring** against the request's user-agent, so
`gptbot` matches `Mozilla/5.0 … GPTBot/1.2`. Fragments are stored trimmed, lowercased
and deduped, which keeps the stored intent identical to the matched intent.

## What the file cannot say

The policy is validated when it is read, and a few things are refused outright:

- **A fragment that would match a real browser.** `mozilla`, `chrome`, `mac os`, and
  any other slice of a real browser's user-agent is rejected in `block` and `charge`.
  Humans read free, forever — and by match time a fragment is just a substring that
  matched, so the only place to catch this is at write time. Fragments are tested
  against whole sample user-agents spanning Blink, WebKit and Gecko on desktop and
  mobile, which is deliberately stronger than a list of five famous tokens: it catches
  `ozill` and `hrome` too. `allow` is exempt — allowing a human is a no-op.
- **The same fragment in two states.** Overlap is a user error (which state did you
  mean?), so it is refused rather than resolved. The gate's own block-wins precedence
  is only a fail-safe for policies this validator never saw.
- **Control characters.** The matched fragment is echoed into the `X-Naulon-Verdict`
  response header, so a stray CR or LF surviving in a stored fragment would be header
  injection. Spaces and dashes are legal — `claude-user` has to work.
- **Anything oversized.** 64 characters per fragment, 200 fragments per list.

## When something is wrong with the file

The failure posture is quiet and open. A missing file, malformed JSON, or a policy the
validator refuses all resolve to "no policy" — classifier defaults, exactly the
behaviour a deploy with no policy file already has. Failing the boot instead would let
a typo in an optional file take a whole site offline.

A refusal is still reported, so the operator console can show what was wrong with the
file while the gate carries on serving. A missing file is not reported at all; that is
the normal state, not an error.

## Verified crawler identity (Web Bot Auth)

A user-agent string is a claim, not a credential — anything can send `GPTBot`. Web Bot
Auth (RFC 9421 HTTP message signatures) is the cryptographic version: the crawler signs
its request, names its key directory in `Signature-Agent`, and the gate fetches that
directory and verifies the signature against it.

Verification happens inside `decide()` for every request, with no configuration. The
outcome is one of:

- **absent** — no signature, or one tagged for some other protocol. This is most
  traffic, and it is not an error.
- **invalid** — a signature that doesn't parse, is missing `created` / `expires` /
  `keyid`, or has expired. A small clock-skew allowance applies.
- **verified** — the signature checks out against the directory the request named.

Two variables control the gate's own **signing** identity, which is a separate thing
from verifying other people's:

| Variable | What it does |
|---|---|
| `BOT_AUTH_SIGNING_KEY` | A base64url 32-byte Ed25519 seed (`node scripts/wba-keygen.mjs`). Set it and the gate serves and self-signs its key directory at `/.well-known/http-message-signatures-directory`, and signs its own outbound fetches — its pull from your origin, and the buying agent's requests. Unset, both surfaces are dark and the traffic is byte-identical to an unsigned deploy. |
| `BOT_AUTH_SIGNATURE_AGENT` | The directory host advertised in `Signature-Agent`. It must actually serve your directory. |
| `BOT_AUTH_ALLOW_HTTP` | Allows `http://` and loopback directories for local test walks only. The directory URL is attacker-supplied, so never set this in production. |

Signing the gate's origin pull is what lets a publisher behind Cloudflare or Vercel
recognize the fetch as a verified bot instead of an anonymous one, without pasting an
IP allowlist.

## Where this fits

`CRAWLER_POLICY_PATH` is the single-tenant gate's route to a policy. A multi-tenant
deployment sets the same `PublisherConfig.crawlerPolicy` per publisher through its own
resolver instead — the enforcement path is identical either way.

Every variable named here is in [configuration.md](./configuration.md).
