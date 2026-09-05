/**
 * The x402 `bazaar` discovery extension — how a tolled resource becomes findable.
 *
 * A naulon origin was invisible to every x402 discovery layer. The Bazaar is not a
 * directory anyone submits to: `specs/extensions/bazaar.md` makes it a declaration the
 * RESOURCE SERVER puts on its own 402, which a facilitator then catalogs and exposes at
 * `GET /discovery/resources`. Nothing was declaring it here, so no catalog could list a
 * naulon resource even in principle, and an agent shopping for something to read never
 * saw one.
 *
 * Declaring costs nothing and is not tied to any one facilitator: the extension is part
 * of the open x402 scheme, so a CDP-indexed catalog, a Circle one, or a third-party
 * crawler all read the same block. Unknown extensions are ignored by clients that do not
 * implement them (spec, "Backwards Compatibility"), so a stock x402 buyer is unaffected.
 *
 * WHAT WE DELIBERATELY DO NOT SEND: `iconUrl`. The fleet is multi-tenant and the only
 * icon it could offer is naulon's own, which would brand every publisher's resource with
 * the toll operator's mark in someone else's catalog.
 */

/** Spec: printable ASCII, no control characters, ≤ 32 chars. A field that fails is
 *  DROPPED by the facilitator, so we drop it here rather than send something that will
 *  be discarded — and, for `serviceName`, rather than truncate a hostname into a
 *  different (possibly real) one. */
const MAX_METADATA_LEN = 32;
function validMetadataString(s: string): boolean {
  return s.length > 0 && s.length <= MAX_METADATA_LEN && /^[\x20-\x7E]+$/.test(s);
}

/** Service-level metadata for the 402's `resource` object.
 *
 *  `serviceName` is the HOST, not "naulon": the spec defines it as "the authority that
 *  hosts the resource", and a catalog entry saying `naulon` for every tenant would be
 *  useless to the agent reading it. It is also the one name that cannot leak another
 *  tenant — it is the host the buyer itself addressed. */
export function serviceMetadata(resourceUrl: string, tollKind: string): {
  serviceName?: string;
  tags?: string[];
} {
  let host: string | undefined;
  try {
    host = new URL(resourceUrl).host;
  } catch {
    /* a resource URL we cannot parse gets no metadata rather than a guess */
  }
  // Deduplicated case-insensitively, as the spec requires of a facilitator anyway — a
  // citation toll would otherwise send "citation" twice and have one silently dropped.
  const seen = new Set<string>();
  const tags = ["citation", "x402", tollKind].filter((t) => {
    if (!validMetadataString(t) || seen.has(t.toLowerCase())) return false;
    seen.add(t.toLowerCase());
    return true;
  }).slice(0, 5);
  return {
    ...(host && validMetadataString(host) ? { serviceName: host } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** JSON Schema for the `info` block below. The spec's v2 extension pattern carries the
 *  schema beside the data so a facilitator can validate without knowing naulon. */
const INFO_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    input: {
      type: "object",
      properties: {
        type: { const: "http" },
        method: { const: "GET" },
      },
      required: ["type", "method"],
    },
    output: {
      type: "object",
      properties: {
        type: { type: "string" },
        format: { type: "string" },
      },
      required: ["type"],
    },
  },
  required: ["input", "output"],
} as const;

/**
 * The `bazaar` extension block for a tolled document read.
 *
 * `input` is a bare GET: the resource is identified by its path, and there are no query
 * parameters to demonstrate — a naulon toll never varies by query string. `output` is
 * the publisher's own page, so the honest declaration is the origin's media type, not a
 * JSON envelope naulon does not impose.
 */
export function bazaarExtension(mimeType: string, routeTemplate?: string): {
  info: { input: { type: "http"; method: "GET"; pathParams?: Record<string, string> }; output: { type: string; format: string } };
  schema: typeof INFO_SCHEMA;
  routeTemplate?: string;
} {
  return {
    ...(routeTemplate ? { routeTemplate } : {}),
    info: {
      input: { type: "http", method: "GET" },
      // `type` is the coarse family a catalog filters on; `format` keeps the exact
      // media type the origin will actually return.
      output: { type: mimeType.startsWith("application/json") ? "json" : "text", format: mimeType },
    },
    schema: INFO_SCHEMA,
  };
}

/**
 * The catalog KEY for a parameterised toll: `/essays/:slug` rather than
 * `/essays/on-stillness`.
 *
 * Without it a publisher with 500 tolled essays produces 500 near-identical catalog
 * rows — one per URL a crawler happened to hit — and an agent browsing the Bazaar sees
 * a wall of the same offer. The spec makes this the server's job: a facilitator maps
 * every concrete request onto the template, and treats an absent one as "catalog the
 * concrete path".
 *
 * ONLY emitted where the template is exactly what the publisher configured: prefix
 * mode at single-segment depth, where every path under `/<prefix>/` is tolled alike.
 * Site mode and deeper prefix scopes get NO template rather than a generalisation that
 * would claim paths the gate does not actually toll — over-claiming in someone else's
 * catalog is worse than a few extra rows in it.
 */
export function routeTemplateFor(pathname: string, prefixes: readonly string[]): string | undefined {
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const head = `/${prefix.replace(/^\/+|\/+$/g, "")}/`;
    if (!pathname.startsWith(head)) continue;
    // Exactly one segment after the prefix, or this is not the shape we can generalise.
    const rest = pathname.slice(head.length);
    if (rest.length === 0 || rest.includes("/")) return undefined;
    const template = `${head}:slug`;
    return isValidRouteTemplate(template) ? template : undefined;
  }
  return undefined;
}

/**
 * The spec's own validation, applied before we SEND rather than trusting the facilitator
 * to drop it: percent-decode first, then the traversal and scheme checks. A template a
 * facilitator discards is a catalog row that silently splits back into one-per-URL, so
 * the failure is invisible from here — better to know we never sent a bad one.
 */
export function isValidRouteTemplate(template: string): boolean {
  if (!template || !template.startsWith("/")) return false;
  if (!/^\/[a-zA-Z0-9_/:.\-~%]+$/.test(template)) return false;
  let decoded = template;
  try {
    decoded = decodeURIComponent(template);
  } catch {
    return false; // malformed percent-encoding
  }
  return !decoded.includes("..") && !decoded.includes("://");
}
