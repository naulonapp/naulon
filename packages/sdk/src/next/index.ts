/**
 * @naulon/sdk/next — drop-in Next.js App Router adapters over the contract.
 *
 * Both are framework-agnostic web-standard Request→Response handlers (they import
 * nothing from `next`); the subpath name signals the intended consumer. `next` is
 * an OPTIONAL peer dependency.
 */
export * from "./settlement-receiver.ts";
export * from "./credits-route.ts";
