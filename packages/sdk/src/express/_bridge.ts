/**
 * Express ⇄ web-standard bridge. The Express adapters are deliberately thin: they
 * translate an Express `(req, res)` into the web-standard `Request`/`Response` the
 * Next adapters already speak, then run the SAME handler. One implementation of the
 * contract logic, two framework skins — no second copy to drift (the SDK's reason
 * for existing). These structural types avoid a hard `@types/express` dependency:
 * the adapters work against any Express-shaped req/res.
 */

export interface ExpressReqLike {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  /** Raw request body — a Buffer when the route is mounted with `express.raw()`. */
  body?: unknown;
}

export interface ExpressResLike {
  status(code: number): ExpressResLike;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

export type ExpressHandler = (req: ExpressReqLike, res: ExpressResLike) => Promise<void>;

/** A single header value (Express folds duplicates to an array; take the first). */
export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The settlement HMAC is computed over the EXACT request bytes, so the receiver
 * needs the raw body. `express.raw()` leaves it a Buffer; `express.json()` parses
 * and discards the bytes (re-serializing changes them and every signature fails).
 * Fail loud with the fix rather than silently 401 every valid call.
 */
export function rawBodyOf(body: unknown, who: string): string {
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  throw new Error(
    `${who}: req.body must be the raw request bytes. Mount this route with ` +
      `express.raw({ type: "*/*" }) — the HMAC signs the exact bytes, so express.json() ` +
      `(which parses then discards them) breaks verification.`,
  );
}

/** Write a web-standard Response back onto an Express response, headers and all. */
export async function pipeResponse(response: Response, res: ExpressResLike): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(await response.text());
}
