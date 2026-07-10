/**
 * `@naulon/sdk/enforce` — in-app toll enforcement for a publisher's own runtime.
 *
 * A thin re-export of the OSS `@naulon/enforce` kernel so a publisher who vendors
 * the SDK tarball (Turbopack can't resolve an out-of-root workspace symlink) gets
 * the framework-agnostic middleware without a `sdk → tollgate → sdk` cycle. The
 * gate (`@naulon/tollgate`) and this SDK both sit ABOVE `@naulon/enforce`.
 *
 * Custody-free: the payment leg POSTs the buyer's signature to the hosted
 * `/verify`, which settles buyer→author directly. This code never holds USDC.
 */
export * from "@naulon/enforce";
