/**
 * How a licence document is labelled on the way out.
 *
 * `application/rsl+xml` is what a crawler should see: it names the document exactly. No browser
 * knows the type, though, so a person opening `/license.xml` was handed a file download instead of
 * the terms. A request that asks for HTML and does not ask for the RSL type is a browser, and it
 * gets the same bytes as `application/xml`, which every browser renders. Anything else, including a
 * bare `*\/*` and a missing header, keeps the RSL type.
 *
 * The answer depends on `Accept`, so every licence response carries `Vary: Accept`; without it a
 * shared cache could hand a crawler the browser's label, or the reverse.
 */
export const RSL_MEDIA_TYPE = "application/rsl+xml";

function acceptedTypes(accept: string | null | undefined): string[] {
  if (!accept) return [];
  return accept
    .split(",")
    .map((part) => (part.split(";")[0] ?? "").trim().toLowerCase())
    .filter(Boolean);
}

/** The `Content-Type` a licence response carries for this `Accept` header. */
export function rslContentType(accept: string | null | undefined): string {
  const types = acceptedTypes(accept);
  const browser = types.includes("text/html") && !types.includes(RSL_MEDIA_TYPE);
  return `${browser ? "application/xml" : RSL_MEDIA_TYPE}; charset=utf-8`;
}

/** Both headers a licence response needs, for this `Accept` header. */
export function rslResponseHeaders(accept: string | null | undefined): { "content-type": string; vary: string } {
  return { "content-type": rslContentType(accept), vary: "Accept" };
}
