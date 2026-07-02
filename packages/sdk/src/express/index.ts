/**
 * `@naulon/sdk/express` — Express adapters for publishers on Express instead
 * of Next. Thin bridges over the framework-neutral handlers, so the contract logic
 * is identical to `@naulon/sdk/next`. `express` is an optional peer dep; the
 * adapters use structural req/res types so they need no `@types/express` to build.
 */
export { createExpressCreditsRoute } from "./credits-route.ts";
export { createExpressSettlementReceiver } from "./settlement-receiver.ts";
export type { ExpressReqLike, ExpressResLike, ExpressHandler } from "./_bridge.ts";
