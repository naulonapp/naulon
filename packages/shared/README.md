# @naulon/shared

The contract layer every naulon package agrees on — the types, validators, and
low-level primitives that define the toll, with no framework or transport
attached.

It holds the env config loader, the credits + license shapes, the settlement and
attribution wire types, the event and observation sinks, and the money primitives
(network constants, EIP-3009 authorization). It builds on
[`@naulon/sdk`](https://www.npmjs.com/package/@naulon/sdk) and re-exports it, so a
package one layer up gets the whole contract from a single import.

## Install

```bash
npm install @naulon/shared
```

You usually don't add this directly — it arrives as a dependency of `@naulon/sdk`
and [`@naulon/enforce`](https://www.npmjs.com/package/@naulon/enforce). Install it
on its own only if you're consuming the shared types or config loader directly.

MIT.
