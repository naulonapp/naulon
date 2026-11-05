/**
 * `naulonNode`: the toll for a Node server that is not built on fetch: Express, Connect, Fastify
 * through its middleware plugin, or a bare `http.createServer`.
 *
 *   import express from "express";
 *   import { naulonNode, naulonSites } from "@naulon/enforce";
 *   const app = express();
 *   app.use(naulonNode(naulonSites({ credentialFor: (host) => db.naulonCredential(host) })));
 *
 * It turns the request into a web `Request` (headers only: the body is never read, so the route
 * behind it still gets it), runs the same core every adapter runs, and either answers (402, 403, a
 * connect path) or hands on with the receipt headers set. The socket's address is passed to the
 * crawler identity check; a server behind a proxy that writes the caller's address into a header
 * names that header with `clientIp` instead.
 *
 * `next` continues to whatever serves the page. Express and Connect pass their own; a bare server
 * passes its handler: `http.createServer((req, res) => toll(req, res, () => handler(req, res)))`.
 *
 * Structural types only, so it needs no `@types/express` and works with any server shaped like
 * Node's own.
 */
import type { NaulonMiddlewareOptions } from "./middleware.ts";
import { coreOf, type NaulonCore } from "./fetch-handler.ts";
import { SOCKET_ADDRESS } from "./clientIp.ts";

export interface NodeRequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string; encrypted?: boolean };
}

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(body?: Uint8Array | string): unknown;
  headersSent?: boolean;
}

export type NodeNext = (err?: unknown) => void;

export interface NaulonNodeOptions {
  /** Read the scheme from `X-Forwarded-Proto`. Set only behind a proxy that overwrites it. */
  trustProxyScheme?: boolean;
}

function toRequest(req: NodeRequestLike, o: NaulonNodeOptions): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const forwarded = o.trustProxyScheme ? headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
  const scheme = forwarded === "https" || forwarded === "http" ? forwarded : req.socket?.encrypted ? "https" : "http";
  const host = headers.get("host") ?? "localhost";
  const request = new Request(`${scheme}://${host}${req.url ?? "/"}`, { method: req.method ?? "GET", headers });
  if (req.socket?.remoteAddress) Object.defineProperty(request, SOCKET_ADDRESS, { value: req.socket.remoteAddress });
  return request;
}

async function send(res: NodeResponseLike, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(new Uint8Array(await response.arrayBuffer()));
}

export function naulonNode(
  opts: NaulonMiddlewareOptions | NaulonCore,
  o: NaulonNodeOptions = {},
): (req: NodeRequestLike, res: NodeResponseLike, next: NodeNext) => void {
  const core = coreOf(opts);
  return (req, res, next) => {
    void (async () => {
      let request: Request;
      try {
        request = toRequest(req, o);
      } catch {
        return next(); // a request no URL can be built from is not ours to judge
      }
      const { response, setHeaders } = await core(request);
      if (response) return send(res, response);
      for (const [k, v] of Object.entries(setHeaders ?? {})) res.setHeader(k, v);
      next();
    })().catch((err: unknown) => {
      // The core fails open by contract, so this is a bug in an adapter or a hook. Serve the page.
      console.error(`[naulon] the toll failed and the page was served: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) next();
    });
  };
}
