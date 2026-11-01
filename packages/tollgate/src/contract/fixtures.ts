/**
 * The in-app runtime contract as data. Every runtime that classifies requests locally (the TS
 * middleware, the WordPress plugin, the Python package, and any later port) runs these cases and
 * must reach the same answers. The expectations are generated from the gate's own `decide()` and
 * `slugForScope()`, so the gate is the reference and a port can only agree or fail.
 *
 * `npm run contract:fixtures` writes the files; `fixtures.test.ts` fails when they are stale.
 */
import { decide } from "@naulon/enforce";
import { slugForScope, type TollScope } from "@naulon/sdk/slug";
import { CRAWLER_REGISTRY, rslContentType, usdc, type PublisherConfig, type TermsPolicy } from "@naulon/shared";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { rulesOf } from "../enforce-api/config.ts";
import { mountEnforceApi } from "../enforce-api/index.ts";
import { OPENAPI_INFO, registerEnforceSecurity } from "../enforce-api/gate.ts";
import { publisherRecordSchema } from "../publisherRecord.ts";

/** The rule lists a case may put the subject's own fragment on. `none` leaves all three empty. */
export const VARIANTS = ["none", "allow", "charge", "block"] as const;
export type Variant = (typeof VARIANTS)[number];

/** One character per expected access decision. */
export const CODES = { blocked: "b", free: "f", continue: "c" } as const;

/** Every terms combination that changes what the rules document says. */
export function termsCombinations(): (TermsPolicy | null)[] {
  const out: (TermsPolicy | null)[] = [];
  for (const search of [undefined, "free", "prohibit"] as const)
    for (const input of [undefined, "prohibit", "free", "priced"] as const)
      for (const train of [undefined, "prohibit", "free"] as const) {
        const p: TermsPolicy = {};
        if (search) p.search = search;
        if (input) p["ai-input"] = input;
        if (train) p["ai-train"] = train;
        out.push(Object.keys(p).length ? p : null);
      }
  return out;
}

/** Requests that are not a registry crawler: people, generic clients, an empty user agent. */
const OTHER_SUBJECTS: { name: string; ua: string; accept: string }[] = [
  { name: "Chrome on macOS", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" },
  { name: "Safari on iPhone", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  { name: "Firefox on Linux", ua: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  { name: "curl", ua: "curl/8.9.1", accept: "*/*" },
  { name: "python-requests", ua: "python-requests/2.32.3", accept: "*/*" },
  { name: "empty user agent", ua: "", accept: "*/*" },
  { name: "browser user agent asking for markdown", ua: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", accept: "text/markdown" },
];

function publisher(terms: TermsPolicy | null, rules: { allow: string[]; block: string[]; charge: string[] }): PublisherConfig {
  return {
    id: "p",
    originUrl: "http://origin.test",
    articlePrefixes: ["essays"],
    price: usdc(0.001),
    citationMultiplier: 1,
    credits: { resolve: async () => undefined },
    licenseIdentity: "naulon:h",
    crawlerPolicy: rules,
    ...(terms ? { termsPolicy: terms } : {}),
  } as PublisherConfig;
}

const QUOTE = async () =>
  ({ slug: "essays/x", kind: "read", title: "X", price: 1000, payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }], extraLegs: [], coauthorSplit: false }) as never;

function codeOf(kind: string): string {
  if (kind === "blocked" || kind === "prohibited") return CODES.blocked;
  if (kind === "free") return CODES.free;
  if (kind === "payment-required") return CODES.continue;
  throw new Error(`unexpected decision ${kind}`);
}

export interface AccessCases {
  $comment: string;
  format: 1;
  variants: readonly Variant[];
  codes: typeof CODES;
  /** The rules document (`rules` in /_naulon/enforce-config) for each terms combination, with empty
   *  allow, block and charge lists. A case fills one list with its subject's fragment. */
  ruleSets: { termsPolicy: TermsPolicy | null; rules: ReturnType<typeof rulesOf> }[];
  subjects: { name: string; ua: string; accept: string; fragment: string | null; expect: string }[];
}

export async function buildAccessCases(): Promise<AccessCases> {
  const terms = termsCombinations();
  const ruleSets = terms.map((t) => ({ termsPolicy: t, rules: rulesOf(publisher(t, { allow: [], block: [], charge: [] })) }));
  const subjects = [
    ...CRAWLER_REGISTRY.map((c) => ({ name: c.name, ua: `Mozilla/5.0 (compatible; ${c.fragment}/1.0)`, accept: "*/*", fragment: c.fragment as string | null })),
    ...OTHER_SUBJECTS.map((s) => ({ ...s, fragment: null })),
  ];
  const out: AccessCases["subjects"] = [];
  for (const s of subjects) {
    let expect = "";
    for (const t of terms) {
      for (const v of VARIANTS) {
        const lists = { allow: [] as string[], block: [] as string[], charge: [] as string[] };
        if (v !== "none" && s.fragment) lists[v].push(s.fragment);
        const d = await decide({
          raw: new Request("http://h/essays/x", { headers: { "user-agent": s.ua, accept: s.accept } }),
          host: "h",
          path: "/essays/x",
          publisher: publisher(t, lists),
          now: 1,
          quote: QUOTE,
        });
        expect += codeOf(d.kind);
      }
    }
    out.push({ ...s, expect });
  }
  return {
    $comment:
      "Generated by `npm run contract:fixtures` from the gate's decide(). For subject s, ruleSets index t and variants index v, " +
      "the expected access decision is s.expect[t * variants.length + v]: b blocked, f free, c continue to pricing. " +
      "Build the case's rules from ruleSets[t].rules, then append s.fragment to the list named by variants[v] unless it is `none` or the fragment is null. " +
      "Classify with that user agent and accept header, no payment header, and no crawler identity ranges.",
    format: 1,
    variants: VARIANTS,
    codes: CODES,
    ruleSets,
    subjects: out,
  };
}

const SCOPES: { name: string; scope: TollScope }[] = [
  { name: "prefixes", scope: { articlePrefixes: ["essays", "articles", "posts"] } },
  { name: "prefixes, rest depth", scope: { articlePrefixes: ["essays"], gateScope: { mode: "prefixes", depth: "rest" } } },
  { name: "site", scope: { articlePrefixes: [], gateScope: { mode: "site", excludePrefixes: ["api", "/static/"] } } },
  { name: "site with pdf", scope: { articlePrefixes: [], gateScope: { mode: "site", excludePrefixes: [], includeExtensions: ["pdf"] } } },
];

const PATHS = [
  "/", "/essays/x", "/essays/x/", "/essays/a/b", "/essays/", "/articles/caf%C3%A9", "/posts/hello?utm_source=x", "/essays/x#part",
  "/essays/%2e%2e/x", "/hello-world/", "/blog/", "/feed/", "/rss/", "/rss.xml", "/feed.xml", "/atom.xml", "/sitemap.xml",
  "/sitemap-posts.xml", "/robots.txt", "/llms.txt", "/favicon.ico", "/static/app.js", "/style.css", "/logo.png", "/paper.pdf",
  "/data.json", "/api/x", "/_naulon/quote", "/.well-known/x402", "/license.xml", "/ESSAYS/X",
];

export interface ScopeCases {
  $comment: string;
  format: 1;
  scopes: { name: string; scope: TollScope }[];
  paths: string[];
  /** expect[scope index][path index]: the slug the path is tolled under, or null when it is free. */
  expect: (string | null)[][];
}

export function buildScopeCases(): ScopeCases {
  return {
    $comment:
      "Generated by `npm run contract:fixtures` from slugForScope(). expect[i][j] is the slug paths[j] is tolled under for scopes[i], or null when it reads free. " +
      "A runtime receives the scope as `enforcement.articlePrefixes` and `enforcement.gateScope` in /_naulon/enforce-config.",
    format: 1,
    scopes: SCOPES,
    paths: PATHS,
    expect: SCOPES.map(({ scope }) => PATHS.map((p) => slugForScope(p, scope))),
  };
}

const ACCEPTS = [
  "",
  "*/*",
  "text/html",
  "TEXT/HTML",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "application/rsl+xml",
  "application/rsl+xml, application/xml;q=0.9",
  "text/html, application/rsl+xml",
  "application/xml",
  "text/html;q=0.1",
];

export interface ContentTypeCases {
  $comment: string;
  format: 1;
  cases: { accept: string; contentType: string }[];
}

/** The Content-Type a runtime serves `/license.xml` with, for each Accept header. */
export function buildContentTypeCases(): ContentTypeCases {
  return {
    $comment: "Generated by `npm run contract:fixtures` from rslContentType(). Serve the RSL licence with `contentType` when the request's Accept header is `accept`.",
    format: 1,
    cases: ACCEPTS.map((accept) => ({ accept, contentType: rslContentType(accept) })),
  };
}

/** The OpenAPI 3.1 document for the enforce API, built from the same route definitions the gate serves. */
export function buildOpenApiDocument(): unknown {
  const api = new OpenAPIHono();
  mountEnforceApi(api, {
    resolver: { resolve: async () => undefined },
    auth: async () => ({ ok: false, status: 401, error: "unauthorized" }),
    observe: () => {},
  });
  registerEnforceSecurity(api);
  return api.getOpenAPI31Document(OPENAPI_INFO);
}

/** JSON Schema for the record a platform answers `GET <NAULON_PLATFORM_URL>?host=` with. */
export function buildPublisherRecordSchema(): unknown {
  return z.toJSONSchema(publisherRecordSchema, { target: "draft-2020-12" });
}

/** Every generated contract file: its path from the repository root, and its content. */
export async function contractFiles(): Promise<{ path: string; content: string }[]> {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return [
    { path: "packages/shared/test-fixtures/access-cases.json", content: json(await buildAccessCases()) },
    { path: "packages/shared/test-fixtures/scope-cases.json", content: json(buildScopeCases()) },
    { path: "packages/shared/test-fixtures/content-type-cases.json", content: json(buildContentTypeCases()) },
    { path: "docs/protocol/openapi.json", content: json(buildOpenApiDocument()) },
    { path: "docs/protocol/publisher-record.schema.json", content: json(buildPublisherRecordSchema()) },
  ];
}
