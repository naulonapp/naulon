/**
 * The in-app runtime contract as data. Every runtime that classifies requests locally (the TS
 * middleware, the WordPress plugin, the Python package, and any later port) runs these cases and
 * must reach the same answers. The expectations are generated from the gate's own `decide()` and
 * `slugForScope()`, so the gate is the reference and a port can only agree or fail.
 *
 * `npm run contract:fixtures` writes the files; `fixtures.test.ts` fails when they are stale.
 */
import { DirectoryCache, decide, verifyBotAuth, type RequestFacts as BotAuthFacts } from "@naulon/enforce";
import { slugForScope, type TollScope } from "@naulon/sdk/slug";
import { CRAWLER_REGISTRY, FREE_REASONS, botAuthDirectoryBody, botAuthKeyFromSeed, signBotAuth, signBotAuthDirectory, GATE_VERDICTS, gateAnswer, rslContentType, usdc, type PublisherConfig, type TermsPolicy } from "@naulon/shared";
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

export interface VerdictCases {
  $comment: string;
  format: 1;
  gateVerdicts: readonly string[];
  freeReasons: readonly string[];
  /** The verdict a runtime acts on for an HTTP status (0: no answer) and a decoded JSON body; `null`
   *  is no verdict, so the page is served. */
  cases: { name: string; status: number; body: unknown; verdict: string | null }[];
}

/** Answers a runtime may get from `/verify` or `/license/check`, honest and hostile. */
const VERDICT_ANSWERS: { name: string; status: number; body: unknown }[] = [
  ...GATE_VERDICTS.map((v) => ({ name: `verdict ${v}`, status: 200, body: { verdict: v } })),
  { name: "paid receipt", status: 200, body: { ok: true, verdict: "paid", settlementRef: "0xabc" } },
  { name: "refusal", status: 402, body: { ok: false, verdict: "refused", error: "bad sig" } },
  { name: "rail down", status: 503, body: { ok: false, verdict: "unavailable", error: "payment_rail_unavailable" } },
  { name: "the verdict wins over the status", status: 500, body: { verdict: "paid" } },
  { name: "no answer", status: 0, body: null },
  { name: "a 5xx without a verdict", status: 502, body: null },
  { name: "a 5xx with an error body", status: 500, body: { error: "boom" } },
  { name: "a success without a verdict", status: 200, body: { ok: true, settlementRef: "0xabc" } },
  { name: "a success that is not JSON", status: 200, body: null },
  { name: "a 4xx without a verdict, from an older gate", status: 402, body: { ok: false, error: "bad sig" } },
  { name: "a key refusal", status: 401, body: { ok: false, error: "unauthorized" } },
  { name: "a WAF page in front of the gate", status: 403, body: null },
  { name: "a body limit in front of the gate", status: 413, body: null },
  { name: "a rate limiter in front of the gate", status: 429, body: { error: "slow down" } },
  { name: "unknown verdict on a success", status: 200, body: { verdict: "settled" } },
  { name: "wrong case on a success", status: 200, body: { verdict: "PAID" } },
  { name: "verdict is not a string", status: 200, body: { verdict: 1 } },
  { name: "verdict is a list", status: 200, body: { verdict: ["paid"] } },
  { name: "body is a list", status: 200, body: [{ verdict: "paid" }] },
  { name: "body is a string", status: 200, body: "paid" },
  { name: "unknown verdict on a 4xx", status: 400, body: { verdict: "settled" } },
];

/** The two closed vocabularies every runtime must spell the same way, and how to read an answer. */
export function buildVerdictCases(): VerdictCases {
  return {
    $comment: "Generated by `npm run contract:fixtures` from GATE_VERDICTS, FREE_REASONS and gateAnswer(). For an answer from /verify or /license/check with HTTP `status` (0: no answer) and decoded JSON `body` (null: none or not JSON), act on `verdict`; null is no verdict, so the page is served.",
    format: 1,
    gateVerdicts: GATE_VERDICTS,
    freeReasons: FREE_REASONS,
    cases: VERDICT_ANSWERS.map(({ name, status, body }) => ({ name, status, body, verdict: gateAnswer(status, body) })),
  };
}

export interface BotAuthVectors {
  $comment: string;
  format: 1;
  /** Which directory host speaks for which crawler fragment (a signer backs a claim). */
  directories: { fragment: string; directoryHost: string }[];
  cases: {
    name: string;
    /** Epoch milliseconds the verifier runs at. */
    now: number;
    request: BotAuthFacts;
    /** What the directory URL answers, or null when it cannot be reached. */
    directory: { status: number; headers: Record<string, string>; body: string } | null;
    expect: { status: string; agent?: string; keyid?: string; covers?: string[] };
  }[];
}

const SIGNED_AT = 1_790_812_800;

/** Signed requests and the verifier's outcome for each, from the gate's own signer and verifier. */
export async function buildBotAuthVectors(): Promise<BotAuthVectors> {
  const key = botAuthKeyFromSeed(Buffer.alloc(32, 42).toString("base64url"));
  const other = botAuthKeyFromSeed(Buffer.alloc(32, 9).toString("base64url"));
  const agent = "signer.example";
  const ctype = { "content-type": "application/http-message-signatures-directory+json" };
  const dirSig = signBotAuthDirectory(key, agent, SIGNED_AT);
  const signedDir = { status: 200, headers: { ...ctype, "signature-input": dirSig["signature-input"], signature: dirSig.signature }, body: botAuthDirectoryBody(key) };
  const plainDir = { status: 200, headers: ctype, body: botAuthDirectoryBody(key) };
  const wrongKeysDir = { ...signedDir, body: botAuthDirectoryBody(other) };
  const facts = (headers: Record<string, string>, path = "/essays/on-stillness"): BotAuthFacts => ({
    authority: "gate.example",
    method: "GET",
    path,
    targetUri: `http://gate.example${path}`,
    headers: { ...headers, "user-agent": "naulon-wayfarer/0.1" },
  });
  const signed = (o: { authority?: string; path?: string; agentValue?: string; created?: number; validity?: number; tag?: "web-bot-auth" | "http-message-signatures-directory"; signer?: typeof key } = {}) => {
    const h = signBotAuth({
      key: o.signer ?? key,
      authority: o.authority ?? "gate.example",
      tag: o.tag ?? "web-bot-auth",
      agent: o.agentValue ?? agent,
      createdSec: o.created ?? SIGNED_AT,
      ...(o.validity !== undefined ? { validitySec: o.validity } : {}),
      ...(o.path !== undefined ? { path: o.path } : {}),
    });
    return { "signature-input": h["signature-input"], signature: h.signature, "signature-agent": h["signature-agent"] ?? "" };
  };
  const now = SIGNED_AT * 1000 + 5_000;
  const raw: { name: string; now?: number; request: BotAuthFacts; directory: BotAuthVectors["cases"][number]["directory"] }[] = [
    { name: "a signed request verifies", request: facts(signed()), directory: signedDir },
    { name: "a path-covering signature verifies on its path", request: facts(signed({ path: "/essays/on-stillness" })), directory: signedDir },
    { name: "a path-covering signature fails on another path", request: facts(signed({ path: "/essays/on-stillness" }), "/essays/another"), directory: signedDir },
    { name: "a signature for another authority fails", request: facts(signed({ authority: "other.example" })), directory: signedDir },
    { name: "a tampered signature fails", request: facts({ ...signed(), signature: signed().signature.replace(/:.{4}/, ":AAAA") }), directory: signedDir },
    { name: "an expired signature fails", now: (SIGNED_AT + 3_600) * 1000, request: facts(signed()), directory: signedDir },
    { name: "a signature created in the future fails", now: (SIGNED_AT - 3_600) * 1000, request: facts(signed()), directory: signedDir },
    { name: "a validity window over 24 hours fails", request: facts(signed({ validity: 90_000 })), directory: signedDir },
    { name: "an unsigned directory is accepted", request: facts(signed()), directory: plainDir },
    { name: "a directory whose keys do not match its signature is unusable", request: facts(signed()), directory: wrongKeysDir },
    { name: "an unreachable directory leaves it unverified", request: facts(signed()), directory: null },
    { name: "a directory that is not 200 is unusable", request: facts(signed()), directory: { ...signedDir, status: 404 } },
    { name: "a directory with the wrong content type is unusable", request: facts(signed()), directory: { ...plainDir, headers: { "content-type": "application/json" } } },
    { name: "a keyid the directory does not list fails", request: facts(signed({ signer: other })), directory: plainDir },
    { name: "no signature headers is absent", request: facts({}), directory: signedDir },
    { name: "a signature for another protocol is absent", request: facts(signed({ tag: "http-message-signatures-directory" })), directory: signedDir },
    { name: "an IP-literal agent is refused", request: facts(signed({ agentValue: "203.0.113.7" })), directory: signedDir },
    { name: "a plain-http agent is refused", request: facts(signed({ agentValue: "http://signer.example" })), directory: signedDir },
    { name: "a loopback agent is refused", request: facts(signed({ agentValue: "localhost" })), directory: signedDir },
    { name: "an unparsable Signature-Input fails", request: facts({ ...signed(), "signature-input": "sig1=(\"@authority\"" }), directory: signedDir },
    { name: "a dictionary Signature-Agent is read", request: facts({ ...signed(), "signature-agent": `sig1="${agent}"` }), directory: signedDir },
  ];
  const cases: BotAuthVectors["cases"] = [];
  for (const c of raw) {
    const at = c.now ?? now;
    const fetchFn = (async () => {
      if (c.directory === null) throw new Error("unreachable");
      return new Response(c.directory.body, { status: c.directory.status, headers: c.directory.headers });
    }) as unknown as typeof fetch;
    const out = await verifyBotAuth(c.request, { fetchFn, cache: new DirectoryCache({ now: () => at }), now: () => at });
    cases.push({
      name: c.name,
      now: at,
      request: c.request,
      directory: c.directory,
      expect: out.status === "verified" ? { status: out.status, agent: out.agent.agent, keyid: out.agent.keyid, covers: out.agent.covers } : { status: out.status },
    });
  }
  return {
    $comment: "Generated by `npm run contract:fixtures` from signBotAuth() and verifyBotAuth(). Verify `request` at `now` with the directory URL answering `directory` (null: unreachable) and reach `expect`. `directories` maps a crawler fragment to the directory host whose signature backs that claim.",
    format: 1,
    directories: CRAWLER_REGISTRY.filter((r) => r.directoryHost !== undefined).map((r) => ({ fragment: r.fragment, directoryHost: r.directoryHost! })),
    cases,
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
    { path: "packages/shared/test-fixtures/verdict-cases.json", content: json(buildVerdictCases()) },
    { path: "packages/shared/test-fixtures/botauth-vectors.json", content: json(await buildBotAuthVectors()) },
    { path: "docs/protocol/openapi.json", content: json(buildOpenApiDocument()) },
    { path: "docs/protocol/publisher-record.schema.json", content: json(buildPublisherRecordSchema()) },
  ];
}
