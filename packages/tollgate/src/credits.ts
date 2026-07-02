/**
 * Credits resolution — the publisher-agnostic seam.
 *
 * The resolvers (httpResolver, fixtureResolver, fixtureResolverFromFile) now live
 * in @naulon/sdk so a publisher can install the exact same code the gate
 * runs. Re-exported here so existing tollgate importers (publisher.ts) are
 * unchanged. Bring your own by implementing the `CreditsResolver` interface.
 */
export { httpResolver, fixtureResolver, fixtureResolverFromFile } from "@naulon/sdk";
