## What this changes

<!-- One or two sentences. What the code does now that it did not before. -->

## Why

<!-- The problem this solves. If it fixes a bug, say what the bug was and what caused it. -->

## How it was verified

<!--
What you actually ran, and what it said. "Tests pass" is not this; naming the test file and
the case it covers is. If you drove it by hand, say against what: `make demo`, a real 402,
a funded testnet wallet.
-->

## Checklist

- [ ] `make lint && make test` pass with no new type errors
- [ ] Tests cover the new branch, not only the happy path
- [ ] Docs updated in this PR if an integrator-facing surface moved (`README.md`, `docs/`, `DEPLOY.md`)
- [ ] `.env.example` updated if a new environment variable was added
- [ ] No secrets, keys or wallet private keys in the diff
- [ ] Title is a Conventional Commit subject under 72 characters, written in the imperative

If this PR touches settlement, also confirm:

- [ ] Money is integer micro-USDC in every split, never a float
- [ ] Settlement stays buyer to author, with nothing pooled or held in between
- [ ] Humans still read free

<!--
The title becomes the commit subject when this is squashed, so it labels the change rather than
headlining a finding: "fix(tollgate): resolve the publisher from Host", not "fix(tollgate): the
gate answered any Host". CONTRIBUTING.md has the full contract.
-->
