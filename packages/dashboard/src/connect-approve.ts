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
  /** Lets the challenge reach a site on this machine. True only when the console itself is local. */
  allowLoopback: boolean;
  /** The gate's host as owners know it, for the sentence that says which gate is being connected. */
  gateLabel: string;
}

type Checked =
  | { ok: true; request: AuthorizationRequest; client: ConnectClient }
  | { ok: false; status: 400; title: string; message: string }
  | { ok: false; status: 409; request: AuthorizationRequest; client: ConnectClient; reason: string };

async function check(deps: ConnectApproveDeps, params: URLSearchParams): Promise<Checked> {
  const parsed = parseAuthorizationRequest(params);
  if (!parsed.ok) return { ok: false, status: 400, title: "This connect request is malformed", message: `${parsed.error}. Start again from your site's settings.` };
  const { request } = parsed;
  const resolved = await deps.clients.resolve(request.clientId);
  if (!resolved.ok) return { ok: false, status: 400, title: "The app asking could not be identified", message: `${resolved.error}.` };
  if (!redirectAllowed(resolved.client, request.redirectUri)) {
    return { ok: false, status: 400, title: "This connect request is not from the app it names", message: "Its return address is not one the app declares, so nothing will be sent back. Start again from your site's settings." };
  }
  const challenge = await checkChallenge(request.site, request.state, request.codeChallenge, { allowLoopback: deps.allowLoopback });
  if (!challenge.ok) return { ok: false, status: 409, request, client: resolved.client, reason: challenge.reason };
  return { ok: true, request, client: resolved.client };
}

const hostOf = (url: string): string => new URL(url).host;

function hidden(request: AuthorizationRequest): string {
  const fields: [string, string][] = [
    ["response_type", "code"],
    ["client_id", request.clientId],
    ["redirect_uri", request.redirectUri],
    ["scope", "site.enforce"],
    ["site", request.site],
    ["state", request.state],
    ["code_challenge", request.codeChallenge],
    ["code_challenge_method", "S256"],
  ];
  return fields.map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join("");
}

function approvePage(deps: ConnectApproveDeps, request: AuthorizationRequest, client: ConnectClient): string {
  const site = hostOf(request.site);
  const sameOrigin = client.origin === request.site;
  return page({
    title: `Connect ${site}`,
    body:
      `<p>${escapeHtml(site)} is asking to toll its pages through ${escapeHtml(deps.gateLabel)}.</p>` +
      `<dl>` +
      `<dt>Site</dt><dd>${escapeHtml(request.site)} <span class="ok">answered this request just now</span></dd>` +
      `<dt>Asking</dt><dd>${escapeHtml(client.name)} <span>(its own description)</span>` +
      (sameOrigin ? "" : `, from ${escapeHtml(client.origin)}`) +
      `</dd>` +
      `</dl>` +
      `<h2>This connection can</h2>` +
      `<ul class="can"><li>ask this gate whether a reader of ${escapeHtml(site)} pays, and what</li>` +
      `<li>take payments for ${escapeHtml(site)}, which go to the wallet set in this console</li>` +
      `<li>report which agents read what</li></ul>` +
      `<h2>It cannot</h2>` +
      `<ul class="can"><li>see your earnings, change your wallet or price, or act for any other site</li></ul>` +
      `<form method="post" action="${AUTHORIZE_PATH}">${hidden(request)}` +
      `<button type="submit" name="decision" value="approve">Approve</button>` +
      `<button type="submit" name="decision" value="deny" class="secondary">Deny</button></form>` +
      `<p class="foot">Either way you go back to ${escapeHtml(hostOf(request.redirectUri))}. You can revoke this connection later under Sites.</p>`,
  });
}

function challengePage(deps: ConnectApproveDeps, request: AuthorizationRequest, reason: string): string {
  return page({
    title: `${hostOf(request.site)} did not answer`,
    error: reason,
    body:
      `<p>Before anything is approved, this console asks the site to prove it is running the app that started this request. ` +
      `It did not answer. Check that naulon is installed and switched on there, and that ${escapeHtml(hostOf(request.site))} is reachable from ${escapeHtml(deps.gateLabel)}.</p>` +
      `<form method="get" action="${AUTHORIZE_PATH}">${hidden(request)}<button type="submit">Try again</button></form>` +
      `<form method="post" action="${AUTHORIZE_PATH}">${hidden(request)}<button type="submit" name="decision" value="deny" class="secondary">Cancel and go back</button></form>`,
  });
}

function back(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function actorName(c: Context): string {
  const p = getPrincipal(c);
  return p?.kind === "session" ? p.username : p?.kind === "machine" ? "DASHBOARD_AUTH" : "local";
}

export function mountConnectApprove(app: Hono, deps: ConnectApproveDeps): void {
  app.get(AUTHORIZE_PATH, requireRole("admin"), async (c) => {
    const r = await check(deps, new URL(c.req.url).searchParams);
    if (r.ok) return c.html(approvePage(deps, r.request, r.client));
    if (r.status === 409) return c.html(challengePage(deps, r.request, r.reason), 409);
    return c.html(page({ title: r.title, error: r.message, body: "" }), 400);
  });

  app.post(AUTHORIZE_PATH, requireRole("admin"), async (c) => {
    const verdict = checkOrigin(c, "strict");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);
    const body = await c.req.parseBody();
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") params.set(k, v);
    const decision = params.get("decision");

    // Deny needs only a trustworthy redirect; it must work even when the site stopped answering.
    const parsed = parseAuthorizationRequest(params);
    if (!parsed.ok) return c.html(page({ title: "This connect request is malformed", error: parsed.error, body: "" }), 400);
    const resolved = await deps.clients.resolve(parsed.request.clientId);
    if (!resolved.ok || !redirectAllowed(resolved.client, parsed.request.redirectUri)) {
      return c.html(page({ title: "The app asking could not be identified", error: resolved.ok ? "Its return address is not one it declares." : resolved.error, body: "" }), 400);
    }
    const audit = (outcome: "ok" | "refused", action: string, detail: Record<string, string>) =>
      deps.auditor?.record({ action, outcome, actor: { kind: getPrincipal(c)?.kind ?? "anonymous", name: actorName(c), ...(getPrincipal(c)?.userId ? { userId: getPrincipal(c)!.userId! } : {}) }, detail });

    if (decision !== "approve") {
      await audit("ok", "console.connect_deny", { site: parsed.request.site, client: parsed.request.clientId });
      return c.redirect(back(parsed.request.redirectUri, { error: "access_denied", state: parsed.request.state }), 303);
    }

    const r = await check(deps, params);
    if (!r.ok) {
      await audit("refused", "console.connect_approve", { site: parsed.request.site, client: parsed.request.clientId, reason: r.status === 409 ? r.reason : r.message });
      if (r.status === 409) return c.html(challengePage(deps, r.request, r.reason), 409);
      return c.html(page({ title: r.title, error: r.message, body: "" }), 400);
    }
    const code = await saveCode(deps.state, {
      clientId: r.client.clientId,
      clientName: r.client.name,
      redirectUri: r.request.redirectUri,
      site: r.request.site,
      codeChallenge: r.request.codeChallenge,
      approvedBy: actorName(c),
    });
    await audit("ok", "console.connect_approve", { site: r.request.site, client: r.client.clientId });
    return c.redirect(back(r.request.redirectUri, { code, state: r.request.state }), 303);
  });
}
