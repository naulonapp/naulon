import { createCreditsRoute } from "@naulon/sdk/next";
import { fixtureResolver, type ArticleCredits } from "@naulon/sdk";
import credits from "../../../../credits.json";

// A real site swaps fixtureResolver for httpResolver(process.env.CREDITS_API_URL!)
// or its own CreditsResolver (a DB/CMS lookup). The adapter handles 404 = free read
// and an optional `{ token }` bearer gate; everything else stays your policy.
export const GET = createCreditsRoute(fixtureResolver(credits as Record<string, ArticleCredits>));
