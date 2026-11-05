/**
 * The page a site owner lands on after pressing "Connect" in their site's settings: the owner's half
 * of connect. The gate's half (turning the approved code into a credential) is the gate's token
 * endpoint, and the two meet in the state store.
 *
 *   GET  /connect/authorize   show the request, after checking it
 *   POST /connect/authorize   Approve or Deny, re-checked from scratch
 *
 * What the owner is shown is chosen for what it proves:
 *   - the site, and that the site answered this connect's challenge just now. That is a fact this
 *     console established, so it is shown as one.
 *   - the app's name, labelled as the app's own description, beside the origin that served it. A
 *     name proves nothing; an origin is where the request came from.
 *   - what the connection can do, and what it cannot.
 *   - where Approve sends them next.
 *
 * A request that cannot be trusted to redirect (no such client, a redirect it does not declare) gets
 * an error page here and is never sent back, because sending it back would make this console an
 * open redirector (RFC 6749 §4.1.2.1). Everything after that is answered at the redirect.
 */
import type { Context, Hono } from "hono";
import {
  authorizationParams,
  checkChallenge,
  parseAuthorizationRequest,
  redirectAllowed,
  saveCode,
  type AuthorizationRequest,
  type ClientResolver,
  type ConnectClient,
  type GateStateStore,
} from "@naulon/shared";
import { escapeHtml, getPrincipal, page, requireRole } from "./console-auth.ts";
import type { ConsoleAuditor } from "./console-audit.ts";
import { checkOrigin } from "./same-origin.ts";

export const AUTHORIZE_PATH = "/connect/authorize";

export interface ConnectApproveDeps {
  state: GateStateStore;
  clients: ClientResolver;
  auditor?: ConsoleAuditor;
  /** Lets the challenge reach a site on a private address. True only when the console itself is local. */
  allowPrivate: boolean;
  /** The gate as its owner knows it, for the sentence that says what is being connected to. */
  gateLabel: string;
}

/** Where a request stands. `untrusted` must never redirect; `unanswered` may, because the client
 *  and its return address were checked before the site was asked. */
type Checked =
  | { kind: "ready"; request: AuthorizationRequest; client: ConnectClient }
  | { kind: "untrusted"; title: string; message: string }
  | { kind: "unanswered"; request: AuthorizationRequest; client: ConnectClient; reason: string };

/** The checks that decide whether this console may send anything back at all. */
async function trusted(deps: ConnectApproveDeps, params: URLSearchParams): Promise<Checked> {
  const parsed = parseAuthorizationRequest(params);
  if (!parsed.ok) return { kind: "untrusted", title: "This connect request is malformed", message: `${parsed.error}. Start again from your site's settings.` };
  const resolved = await deps.clients.resolve(parsed.request.clientId);
  if (!resolved.ok) return { kind: "untrusted", title: "The app asking could not be identified", message: `${resolved.error}.` };
  if (!redirectAllowed(resolved.client, parsed.request.redirectUri)) {
    return { kind: "untrusted", title: "This connect request is not from the app it names", message: "Its return address is not one the app declares, so nothing will be sent back. Start again from your site's settings." };
  }
  return { kind: "ready", request: parsed.request, client: resolved.client };
}

/** Everything `trusted` checks, then whether the site answers this connect right now. */
async function check(deps: ConnectApproveDeps, params: URLSearchParams): Promise<Checked> {
  const t = await trusted(deps, params);
  if (t.kind !== "ready") return t;
  const answer = await checkChallenge(t.request.site, t.request.state, t.request.codeChallenge, { allowPrivate: deps.allowPrivate });
  return answer.ok ? t : { kind: "unanswered", request: t.request, client: t.client, reason: answer.reason };
}

const hostOf = (url: string): string => new URL(url).host;

const hidden = (request: AuthorizationRequest): string =>
  authorizationParams(request)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("");

function approvePage(deps: ConnectApproveDeps, request: AuthorizationRequest, client: ConnectClient): string {
  const site = escapeHtml(hostOf(request.site));
  return page({
    title: `Connect ${hostOf(request.site)}`,
    body:
      `<p>${site} is asking to toll its pages through ${escapeHtml(deps.gateLabel)}.</p>` +
      `<dl>` +
      `<dt>Site</dt><dd>${escapeHtml(request.site)} <span class="ok">answered this request just now</span></dd>` +
      `<dt>Asking</dt><dd>${escapeHtml(client.name)} <span>(its own description)</span>` +
      (client.origin === request.site ? "" : `, from ${escapeHtml(client.origin)}`) +
      `</dd></dl>` +
      `<h2>This connection can</h2>` +
      `<ul class="can"><li>ask this gate whether a reader of ${site} pays, and what</li>` +
      `<li>take payments for ${site}, which go to the wallet set in this console</li>` +
      `<li>report which agents read what</li></ul>` +
      `<h2>It cannot</h2>` +
      `<ul class="can"><li>see your earnings, change your wallet or price, or act for any other site</li></ul>` +
      `<form method="post" action="${AUTHORIZE_PATH}">${hidden(request)}` +
      `<button type="submit" name="decision" value="approve">Approve</button>` +
      `<button type="submit" name="decision" value="deny" class="secondary">Deny</button></form>` +
      `<p class="foot">Either way you go back to ${escapeHtml(hostOf(request.redirectUri))}. You can revoke this connection later under Sites.</p>`,
  });
}

function unansweredPage(deps: ConnectApproveDeps, request: AuthorizationRequest, reason: string): string {
  const site = escapeHtml(hostOf(request.site));
  return page({
    title: `${hostOf(request.site)} did not answer`,
    error: reason,
    body:
      `<p>Before anything is approved, this console asks the site to prove it is running the app that started this request. ` +
      `It did not answer. Check that naulon is installed and switched on there, and that ${site} is reachable from ${escapeHtml(deps.gateLabel)}.</p>` +
      `<form method="get" action="${AUTHORIZE_PATH}">${hidden(request)}<button type="submit">Try again</button></form>` +
      `<form method="post" action="${AUTHORIZE_PATH}">${hidden(request)}<button type="submit" name="decision" value="deny" class="secondary">Cancel and go back</button></form>`,
  });
}

/** One rendering of every state that is not a redirect. */
function render(c: Context, deps: ConnectApproveDeps, r: Checked): Response | Promise<Response> {
  if (r.kind === "ready") return c.html(approvePage(deps, r.request, r.client));
  if (r.kind === "unanswered") return c.html(unansweredPage(deps, r.request, r.reason), 409);
  return c.html(page({ title: r.title, error: r.message, body: "" }), 400);
}

function back(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function actorOf(c: Context): { kind: "session" | "machine" | "anonymous"; name: string; userId?: string } {
  const p = getPrincipal(c);
  if (!p) return { kind: "anonymous", name: "local" };
  return { kind: p.kind, name: p.kind === "session" ? p.username : "DASHBOARD_AUTH", ...(p.userId ? { userId: p.userId } : {}) };
}

export function mountConnectApprove(app: Hono, deps: ConnectApproveDeps): void {
  app.get(AUTHORIZE_PATH, requireRole("admin"), async (c) => render(c, deps, await check(deps, new URL(c.req.url).searchParams)));

  app.post(AUTHORIZE_PATH, requireRole("admin"), async (c) => {
    const verdict = checkOrigin(c, "strict");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(await c.req.parseBody())) if (typeof v === "string") params.set(k, v);
    const actor = actorOf(c);
    const audit = (action: string, outcome: "ok" | "refused", detail: Record<string, string>) => deps.auditor?.record({ action, outcome, actor, detail });

    // Deny needs only a return address this console trusts. It must work after the site stopped
    // answering, because that is exactly when an owner wants out.
    if (params.get("decision") !== "approve") {
      const t = await trusted(deps, params);
      if (t.kind !== "ready") return render(c, deps, t);
      await audit("console.connect_deny", "ok", { site: t.request.site, client: t.client.clientId });
      return c.redirect(back(t.request.redirectUri, { error: "access_denied", state: t.request.state }), 303);
    }

    const r = await check(deps, params);
    if (r.kind !== "ready") {
      if (r.kind === "unanswered") await audit("console.connect_approve", "refused", { site: r.request.site, client: r.client.clientId, reason: r.reason });
      return render(c, deps, r);
    }
    const code = await saveCode(deps.state, {
      clientId: r.client.clientId,
      clientName: r.client.name,
      redirectUri: r.request.redirectUri,
      site: r.request.site,
      codeChallenge: r.request.codeChallenge,
      approvedBy: actor.name,
    });
    await audit("console.connect_approve", "ok", { site: r.request.site, client: r.client.clientId });
    return c.redirect(back(r.request.redirectUri, { code, state: r.request.state }), 303);
  });
}
