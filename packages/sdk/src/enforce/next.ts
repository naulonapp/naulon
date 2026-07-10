/**
 * `@naulon/sdk/enforce/next` — the Next.js App Router middleware adapter.
 *
 * A thin re-export of `@naulon/enforce/next` (`createNaulonMiddleware`), the
 * `NextResponse`-shaped wrapper over the framework-agnostic `naulonMiddleware`.
 * Kept a separate subpath so importing the core enforcement surface never pulls
 * in `next/server`.
 */
export * from "@naulon/enforce/next";
