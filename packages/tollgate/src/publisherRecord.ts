/**
 * A publisher as plain data, so a platform written in any language can describe its sites to the
 * gate over HTTP (`httpPublisherResolver`).
 *
 * `PublisherConfig` carries functions (a credits resolver, fee and memo hooks), so it cannot cross
 * a wire. `PublisherRecord` is its serializable subset, validated strictly: an unknown field is
 * refused rather than dropped, because a dropped field is a setting the platform believes is live
 * and the gate silently ignores. Money is integer micro-USDC on the wire; the conversion to the
 * gate's `Usdc` happens once, here.
 */
import { z } from "zod";
import { httpResolver, parseCredits, payeeWalletSchema, type ArticleCredits, type CreditsResolver } from "@naulon/sdk";
import { NETWORKS, usdc, walletAddress, type NetworkName, type PublisherConfig } from "@naulon/shared";
import { termsPolicySchema } from "./rsl/terms-policy.ts";

const priceRuleSchema = z
  .object({
    pattern: z.string().min(1),
    priceUsdc: z.number().nonnegative().optional(),
    citationMultiplier: z.number().positive().optional(),
  })
  .strict();

const gateScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("prefixes"), depth: z.enum(["segment", "rest"]).optional() }).strict(),
  z
    .object({
      mode: z.literal("site"),
      excludePrefixes: z.array(z.string()),
      includeExtensions: z.array(z.string()).optional(),
    })
    .strict(),
]);

const networkSchema = z
  .string()
  .refine((n): n is NetworkName => Object.prototype.hasOwnProperty.call(NETWORKS, n), "unknown settlement network");

export const publisherRecordSchema = z
  .object({
    id: z.string().min(1),
    hosts: z.array(z.string().min(1)).min(1),
    originUrl: z.string().url(),
    articlePrefixes: z.array(z.string()),
    priceMicro: z.number().int().nonnegative(),
    citationMultiplier: z.number().positive().optional(),
    priceRules: z.array(priceRuleSchema).optional(),
    defaultPayoutAddress: payeeWalletSchema.optional(),
    creditsInline: z.record(z.string(), z.unknown()).optional(),
    creditsApiUrl: z.string().url().optional(),
    tollMode: z.enum(["charge", "observe"]).optional(),
    termsPolicy: termsPolicySchema.optional(),
    gateScope: gateScopeSchema.optional(),
    settlementNetwork: networkSchema.optional(),
    suspended: z.boolean().optional(),
    enforceKeySha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 digest").optional(),
  })
  .strict();

/** The wire shape. `creditsInline` values are validated with `parseCredits` when the config is built. */
export type PublisherRecord = Omit<z.infer<typeof publisherRecordSchema>, "settlementNetwork"> & {
  settlementNetwork?: NetworkName;
};

/** Default citation multiplier when a record names none, matching the single-tenant gate. */
const DEFAULT_CITATION_MULTIPLIER = 1;

function sitePayeeResolver(wallet: string): CreditsResolver {
  const payee = walletAddress(wallet);
  return {
    async resolve(slug) {
      return { slug, title: slug, contributors: [{ authorId: "site", wallet: payee }] };
    },
  };
}

function creditsFor(record: PublisherRecord): CreditsResolver {
  const base: CreditsResolver | undefined = record.creditsApiUrl
    ? httpResolver(record.creditsApiUrl)
    : record.defaultPayoutAddress
      ? sitePayeeResolver(record.defaultPayoutAddress)
      : undefined;
  const pins = new Map<string, ArticleCredits>();
  for (const [slug, raw] of Object.entries(record.creditsInline ?? {})) {
    pins.set(slug, parseCredits(raw, `creditsInline["${slug}"]`));
  }
  return {
    async resolve(slug) {
      return pins.get(slug) ?? (base ? base.resolve(slug) : undefined);
    },
  };
}

/** Build the gate's runtime config from a validated record. */
export function publisherFromRecord(record: PublisherRecord): PublisherConfig {
  return {
    id: record.id,
    originUrl: record.originUrl,
    articlePrefixes: record.articlePrefixes,
    price: usdc(record.priceMicro / 1_000_000),
    citationMultiplier: record.citationMultiplier ?? DEFAULT_CITATION_MULTIPLIER,
    ...(record.priceRules ? { priceRules: record.priceRules } : {}),
    credits: creditsFor(record),
    licenseIdentity: `naulon:${record.id}`,
    ...(record.tollMode ? { tollMode: record.tollMode } : {}),
    ...(record.termsPolicy ? { termsPolicy: record.termsPolicy } : {}),
    ...(record.gateScope ? { gateScope: record.gateScope } : {}),
    ...(record.settlementNetwork ? { settlementNetwork: record.settlementNetwork } : {}),
    ...(record.suspended !== undefined ? { suspended: record.suspended } : {}),
    ...(record.enforceKeySha256 ? { enforceKeySha256: record.enforceKeySha256 } : {}),
  };
}

/** Validate an untrusted record. Returns the record, or the reason it was refused. */
export function parsePublisherRecord(raw: unknown): { ok: true; record: PublisherRecord } | { ok: false; error: string } {
  const parsed = publisherRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  try {
    const record = parsed.data as PublisherRecord;
    for (const [slug, credits] of Object.entries(parsed.data.creditsInline ?? {})) {
      parseCredits(credits, `creditsInline["${slug}"]`);
    }
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
