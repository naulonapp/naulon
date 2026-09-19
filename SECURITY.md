# Security

This project moves money. A read is paid for with real USDC, the payout address comes from a
publisher's own credits source, and a citation license is a signed claim that a payment happened.
This page is how to report a bug in any of that, and what happens next.

## Reporting a vulnerability

**Report privately, never as a public issue.** Use
[Report a vulnerability](https://github.com/naulonapp/naulon/security/advisories/new), which opens
a private advisory only you and the maintainers can read.

Include what an attacker gains, the smallest way to reproduce it, and the version or commit you
tested. A failing test is the fastest possible report.

What to expect, from a small team rather than a staffed security desk:

- an acknowledgement within 3 business days
- an assessment, or a question, within 10 business days
- credit in the advisory and the release notes when a fix ships, unless you would rather not

Give us a chance to ship a fix before you publish. There is no bug bounty.

## Supported versions

The project is pre-1.0 and every release is a `0.x` minor. Only the latest minor of each published
package receives fixes; there are no long-term support branches. Upgrading to the current release
is the supported remedy for anything already fixed.

## In scope

The invariants below are the ones this project exists to hold. Anything that breaks one is a
vulnerability even when nothing crashes.

- **Money reaches the wrong address.** A credits source that can inject a `payTo`, a split that
  pays someone not credited, or a payout that survives a validation it should not have.
- **The gate holds funds.** Settlement is buyer to author. Any path that pools, escrows or takes
  custody of USDC is a defect in the business model, not only in the code.
- **A human is charged.** Humans read free, and no configuration may put a price on a human
  request. A classifier bypass that reads a person as an agent counts here.
- **A payment is replayed or skipped.** A 402 nonce that can be reused, a payment that verifies
  against a quote it did not authorize, or a read served without settling one.
- **A citation license lies.** A token that can be forged, replayed past its window, altered
  without breaking the signature, or that entitles more than it was minted for. The spec is
  [docs/citation-license.md](./docs/citation-license.md).
- **The operator console leaks.** It shows payout wallets and earnings and it writes to your
  credits file, so an exposure or a write reachable without the configured credential is in scope.
- **A crawler is trusted it should not be.** Web Bot Auth verification accepting an unsigned,
  expired or wrongly keyed signature.
- **The buying agent is steered by the text it reads.** A page whose content changes what the
  agent pays, fetches or reports. Source text is data, and the fence that keeps it data is a
  security boundary.
- **A secret escapes.** A key, token or wallet private key reaching a log, a response body, an
  error message or a published package.

The hosted service at [naulon.app](https://naulon.app) runs this code. If you found it there,
report it the same way.

## Out of scope

- A deployment configured against its own documentation, for example a console given a public bind
  and no credential. That combination already refuses to serve; making it serve anyway is in scope,
  choosing it is not.
- `PAYMENT_MODE=mock`, which settles nothing and holds no keys by design.
- Volumetric denial of service, and findings that need physical or local access to a machine you
  already control.
- Reports produced only by a scanner, with no working path to impact.

## Handling your report

Advisories are drafted in private, fixed on a private fork when the fix would otherwise disclose
the issue, and published with the release that carries the fix. The release notes name the
versions affected and the version to upgrade to.
