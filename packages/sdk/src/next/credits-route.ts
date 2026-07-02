/**
 * The credits-route adapter — deliberately minimal (~20 lines of HTTP framing
 * around the `CreditsResolver` seam). It earns its place by pinning the one thing
 * publishers get wrong: `404 = free read` (the deliberate don't-gate signal),
 * distinct from a `200` with credits. The docs also show the hand-rolled
 * equivalent for publishers who'd rather not take the dependency.
 *
 * Returns a Next App Router GET handler shape — `(req, ctx)` where `ctx.params`
 * is the async params object Next 15+ passes. Wire it as:
 *   export const GET = createCreditsRoute(resolver);
 */
import type { CreditsResolver } from "../resolver/types.ts";

export function createCreditsRoute(
  resolver: CreditsResolver,
  opts?: { token?: string },
): (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response> {
  return async (req, ctx) => {
    // Optional bearer gate — set a token when the endpoint is public-internet
    // reachable (the cloud-tenant case; the fleet sends `Authorization: Bearer`).
    if (opts?.token) {
      if (req.headers.get("authorization") !== `Bearer ${opts.token}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }
    const { slug } = await ctx.params;
    const credits = await resolver.resolve(slug);
    if (credits === undefined) {
      return Response.json({ error: "not_found" }, { status: 404 }); // 404 = free read
    }
    return Response.json(credits);
  };
}
