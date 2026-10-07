/**
 * The gate's half of the content exits (`@naulon/enforce` `CONTENT_EXITS`): a passthrough response on
 * a route that hands out article text is stripped for anyone the toll would charge.
 *
 * Who counts is `classifyRequester`, the function `decide()` runs on an article page, so a side door
 * applies the same rules as the front door: a person, the gate's own origin pull, a crawler the site
 * lets read free and a site that gives `ai-input` away all get the origin's response untouched. Every
 * other requester gets the body with its article text removed. A refused crawler is a requester the
 * toll would not serve, so it gets the stripped body too, never the full one.
 */
import { contentExitFor, type ContentExit, type Decision, type MachineStanding } from "@naulon/enforce";
import { stampGateCacheHeaders } from "./cacheHeaders.ts";

/** Response header naming the exit that stripped a body, so a teaser is never mistaken for the origin's. */
export const CONTENT_EXIT_HEADER = "X-Naulon-Exit";

export interface ContentExitInput {
  /** The origin's passthrough response. */
  upstream: Response;
  /** The request URL (path and query). */
  url: URL;
  /** Who is asking: `classifyRequester` over the same input `decide()` received. */
  classify: () => Promise<Decision | MachineStanding>;
  /** Buffer a response body, bounded; null when it cannot be (too large, too slow). */
  materialize: (res: Response) => Promise<Response | null>;
  exits?: readonly ContentExit[];
}

export async function throughContentExit(input: ContentExitInput): Promise<Response> {
  const exit = contentExitFor(input.url, input.exits);
  if (!exit) return input.upstream;

  const standing = await input.classify();
  // Served free on the article page, so served whole here. The answer still depends on who asked,
  // so every cache must keep the two apart.
  if (standing.kind === "free") return stampGateCacheHeaders(input.upstream, { noStore: false });

  const buffered = await input.materialize(input.upstream);
  if (!buffered) {
    // Too large or too slow to read. Failing open would hand out the text this exists to protect.
    return stampGateCacheHeaders(new Response(null, { status: 502, headers: { [CONTENT_EXIT_HEADER]: `${exit.id}; unreadable` } }), {
      noStore: true,
    });
  }
  const body = await buffered.text();
  const stripped = exit.strip(body, buffered.headers.get("content-type") ?? "", input.url);
  // Not this exit's shape (an error page, an empty list): nothing to strip, served as it came.
  if (stripped === null) return stampGateCacheHeaders(new Response(body, buffered), { noStore: true });

  const headers = new Headers(buffered.headers);
  // A new body: the origin's length and validators describe a different one.
  for (const h of ["content-length", "content-encoding", "etag", "last-modified"]) headers.delete(h);
  headers.set(CONTENT_EXIT_HEADER, exit.id);
  return stampGateCacheHeaders(new Response(stripped, { status: buffered.status, statusText: buffered.statusText, headers }), {
    noStore: true,
  });
}
