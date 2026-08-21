/**
 * The console's identity layer: who is asking, and may they.
 *
 * Two credentials, and they are NOT equals — that distinction is the whole design:
 *
 *   - A SESSION (cookie) is the browser's credential. It has an account behind it, it can
 *     be ended, and every action it takes is attributable.
 *   - The MACHINE credential (`DASHBOARD_AUTH`, HTTP Basic) is for scripts and CI. It is
 *     refused for browser navigation once real accounts exist, so it cannot quietly remain
 *     the way people sign in. n8n removed Basic outright in 1.0 and their forum filled
 *     with automation that had died; Prometheus keeps hashed Basic forever and is
 *     respectable. Keeping it, narrowed and named, is the honest middle.
 *
 * Until the first account exists there is a third state — LEGACY. `DASHBOARD_AUTH` alone
 * behaves exactly as it did before this feature existed, browser included, and the boot
 * line points at first-run setup. An upgrade must never make a working console dark. That
 * is n8n's own migration shape (PR #2973, "disable basic auth after owner has been set
 * up"), reached without their breaking change.
 *
 * `resolvePrincipal` is one step, run once per request, and every route reads its result
 * — the same shape naulon-cloud uses for its BFFs (`src/principal.ts`), for the same
 * reason: an authorization decision spread across handlers is one handler away from being
 * wrong.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { markSvg } from "./brand.ts";
import type { ConsoleAuditor } from "./console-audit.ts";
import { anonymousActor } from "./console-audit.ts";
import type { ConsoleRole, ConsoleStore, ConsoleUser } from "./console-store.ts";
import {
  authenticate,
  createUser,
  listUsers,
  setDisabled,
  setPassword,
  validatePassword,
} from "./console-users.ts";
import {
  clearSessionCookies,
  createSession,
  destroySession,
  destroyUserSessions,
  isSecureRequest,
  resolveSession,
  sessionCookie,
  tokenFromCookieHeader,
  type SessionLifetimes,
} from "./console-session.ts";
import { checkOrigin } from "./same-origin.ts";

export interface ConsolePrincipal {
  kind: "session" | "machine";
  /** Absent for the machine credential — it has no account, which is exactly why it cannot act as one. */
  userId?: string;
  username: string;
  role: ConsoleRole;
  /** The raw session token, for logout and for rotation on a password change. */
  token?: string;
  mustChangePassword: boolean;
}

export interface MachineCredential {
  username: string;
  verify: (username: string, password: string) => Promise<boolean> | boolean;
  /** Viewer by default: a CI job that reads the ledger should not also be able to fire a toll. */
  role: ConsoleRole;
}

export interface ConsoleAuthDeps {
  store: ConsoleStore;
  auditor: ConsoleAuditor;
  lifetimes: SessionLifetimes;
  machine: MachineCredential | null;
  /**
   * True when nothing outside this box can reach the console. First-run setup — the one
   * request that CREATES an administrator — is allowed only here, or to a caller already
   * holding the machine credential. A stranger must never be able to claim a console
   * simply by arriving before its owner.
   */
  loopbackOnly: boolean;
  /**
   * The console is in `private` mode: loopback bind, no credential, no accounts — the
   * default `make dev` shape, which has always served the box owner with no login and
   * must keep doing so. Creating the first account is what turns the sign-in on, and it
   * takes effect on the next request rather than at the next restart.
   */
  privateMode: boolean;
  now?: () => Date;
}

const PRINCIPAL_KEY = "naulonPrincipal";
/**
 * Set when the middleware deliberately let an unauthenticated request through (private
 * mode, no accounts yet). Route guards read it so "there is no principal" does not get
 * confused with "this principal may not do that" — the first is the documented default
 * console, the second is a refusal.
 */
const ANON_OK_KEY = "naulonAnonymousAllowed";

export const getPrincipal = (c: Context): ConsolePrincipal | null =>
  (c.get(PRINCIPAL_KEY) as ConsolePrincipal | undefined) ?? null;

/** Paths served before anyone is known. Everything else requires a principal. */
const PUBLIC_PATHS = new Set(["/login", "/setup", "/auth.css", "/favicon.svg"]);
const isPublicPath = (path: string): boolean => PUBLIC_PATHS.has(path) || path.startsWith("/fonts/");

/**
 * Is this a browser asking for a page, rather than a script asking for data? Decides
 * between a redirect to the login form and a 401 — a curl that gets a 302 to an HTML page
 * has been told nothing useful.
 *
 * `Sec-Fetch-Mode: navigate` is the precise signal and every current browser sends it;
 * the Accept sniff is the fallback for the ones that do not.
 */
export function isNavigation(c: Context): boolean {
  if (c.req.header("Sec-Fetch-Mode") === "navigate") return true;
  if (c.req.header("Sec-Fetch-Mode")) return false;
  return (c.req.header("Accept") ?? "").includes("text/html");
}

const clientIp = (c: Context): string | undefined =>
  c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || undefined;

const secureOf = (c: Context): boolean => isSecureRequest(c.req.url, c.req.header("X-Forwarded-Proto"));

function basicCredential(c: Context): { username: string; password: string } | null {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const [username, password] = decoded.split(/:(.*)/s);
  if (!username || password === undefined) return null;
  return { username, password };
}

/**
 * The single identity step. Session first: a browser that has signed in must not be
 * silently downgraded to the machine credential's viewer role because it also happens to
 * carry an Authorization header.
 */
export async function resolvePrincipal(c: Context, deps: ConsoleAuthDeps): Promise<ConsolePrincipal | null> {
  const now = deps.now ?? (() => new Date());
  const token = tokenFromCookieHeader(c.req.header("Cookie"));
  if (token) {
    const found = await resolveSession(deps.store, token, deps.lifetimes, now);
    if (found.ok) {
      return {
        kind: "session",
        userId: found.value.user.id,
        username: found.value.user.username,
        role: found.value.user.role,
        token,
        mustChangePassword: found.value.user.mustChangePassword === true,
      };
    }
  }

  if (deps.machine) {
    const supplied = basicCredential(c);
    if (supplied && (await deps.machine.verify(supplied.username, supplied.password))) {
      return {
        kind: "machine",
        username: deps.machine.username,
        role: deps.machine.role,
        mustChangePassword: false,
      };
    }
  }
  return null;
}

/**
 * The gate every request passes. Ordering inside it is the security-relevant part:
 * resolve, then decide what an ABSENT principal means, then enforce the forced password
 * change, and only then hand off.
 */
export function consoleAuth(deps: ConsoleAuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const needsSetup = (await deps.store.read()).users.length === 0;
    const resolved = await resolvePrincipal(c, deps);

    // LEGACY: no accounts, machine credential holds. It behaves as it always did — full
    // access, browsers included — so upgrading does not lock anyone out. That includes the
    // ROLE: `DASHBOARD_AUTH_ROLE` defaults to viewer, and applying that default here would
    // have quietly taken the six ops writes away from every console that has not made an
    // account yet. The narrowing starts when there is something to narrow AGAINST.
    const legacy = needsSetup && resolved?.kind === "machine";
    const principal = legacy && resolved ? { ...resolved, role: "admin" as const } : resolved;
    if (principal) c.set(PRINCIPAL_KEY, principal);

    if (!principal && !isPublicPath(path)) {
      // The documented default: loopback, no credential, no accounts. Serve it, exactly as
      // before this feature existed. Adding a forced sign-in here would have turned every
      // `make dev` console into a setup wizard.
      if (needsSetup && deps.privateMode) {
        c.set(ANON_OK_KEY, true);
        await next();
        return;
      }
      // Legacy: DASHBOARD_AUTH is set and no accounts exist yet, so Basic is still the
      // whole login — including for browsers. Prompt, exactly as it always did.
      if (needsSetup && deps.machine) return unauthorized(c, deps);
      if (isNavigation(c)) return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
      return unauthorized(c, deps);
    }

    if (principal?.kind === "machine" && !legacy && isNavigation(c)) {
      // The narrowing that makes two credentials defensible rather than duplicative.
      return c.text(
        "DASHBOARD_AUTH is a machine credential — it answers API requests, not browser\n" +
          "navigation. Sign in at /login with a console account.\n",
        401,
        { "Content-Type": "text/plain; charset=utf-8" },
      );
    }

    // `isPublicPath` is exempt, and that omission was a real defect: the forced-change
    // page links /auth.css, /favicon.svg and /fonts/*, and this gate answered all three
    // with a text/plain 403. It LOOKED fine in a walk only because the stylesheet was
    // already in the browser cache from the login page one redirect earlier; on a cold
    // cache the one page a seeded operator is forced onto renders unstyled. Measured
    // 2026-08-21: fetch('/auth.css') => 403 "This account must set a new password".
    if (
      principal?.mustChangePassword &&
      !isPublicPath(path) &&
      path !== "/account/password" &&
      path !== "/logout"
    ) {
      if (isNavigation(c)) return c.redirect("/account/password", 302);
      return c.text("This account must set a new password before it can be used.\n", 403);
    }

    await next();
  };
}

function unauthorized(c: Context, deps: ConsoleAuthDeps): Response {
  // Only offer Basic when Basic is actually configured, so a browser is not prompted for
  // a credential the console does not have.
  if (deps.machine) c.header("WWW-Authenticate", 'Basic realm="naulon console"');
  return c.text("Not signed in.\n", 401);
}

/**
 * Record an ops write against whoever ran it.
 *
 * Without this the audit log holds sign-ins and account changes only — and "who ran that
 * test toll" was the entire argument for having accounts instead of one shared password.
 * A log that answers every question except the one the feature was built for is worse than
 * none, because it looks complete.
 *
 * The outcome is read from the response status AFTER the handler, so a refusal is recorded
 * as a refusal rather than as an action that happened.
 */
export function audited(action: string, auditor: ConsoleAuditor): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const principal = getPrincipal(c);
    const status = c.res.status;
    await auditor.record({
      action,
      outcome: status < 400 ? "ok" : status === 403 || status === 401 ? "refused" : "failed",
      actor: principal
        ? {
            kind: principal.kind,
            ...(principal.userId ? { userId: principal.userId } : {}),
            name: principal.username,
            role: principal.role,
          }
        : anonymousActor(),
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      detail: { status },
    });
  };
}

/** Route guard for the six write routes. Reads the principal the middleware already resolved. */
export function requireRole(role: ConsoleRole): MiddlewareHandler {
  return async (c, next) => {
    const principal = getPrincipal(c);
    if (!principal) {
      if (c.get(ANON_OK_KEY) === true) return next(); // private console, no accounts — see consoleAuth
      return c.text("Not signed in.\n", 401);
    }
    if (role === "admin" && principal.role !== "admin") {
      return c.text(
        principal.kind === "machine"
          ? "This credential is read-only. Set DASHBOARD_AUTH_ROLE=admin to let it write.\n"
          : "Your account is a viewer; this action needs an administrator.\n",
        403,
      );
    }
    await next();
  };
}

// ── Pages ────────────────────────────────────────────────────────────────────────
// No inline <style> and no inline <script>: the console ships `style-src 'self'` and
// `script-src 'self'`, and weakening a CSP so a login page can be one file is a bad
// trade. Hence /auth.css, and forms that work with JavaScript switched off entirely.

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface PageOptions {
  title: string;
  body: string;
  /** Rendered in the red note above the form. Always escaped. */
  error?: string;
  notice?: string;
}

function page({ title, body, error, notice }: PageOptions): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${escapeHtml(title)} · naulon</title>` +
    `<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/auth.css">` +
    `</head><body><main class="auth">` +
    `<div class="mark">${markSvg()}</div>` +
    `<h1>${escapeHtml(title)}</h1>` +
    (error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "") +
    (notice ? `<p class="notice">${escapeHtml(notice)}</p>` : "") +
    body +
    `</main></body></html>`
  );
}

/**
 * The auth pages carry their own palette because they carry their own stylesheet — they are
 * deliberately JS-free (a login that needs JavaScript to render is a login that can lock you
 * out), so they cannot use the console's `theme.js`, which resolves an explicit preference.
 *
 * They therefore follow the OS and nothing else. An operator who forced light in the console
 * still meets a system-themed login; that seam is the price of a sign-in page that works with
 * scripting switched off, and it is one screen, once per session.
 *
 * Values are the same published palette as app.css. `--field` exists because the input
 * background was the one hardcoded colour left in here (#0b0e14) — invisible in dark, and on
 * paper it would have been a black box in the middle of a white card.
 */
export const AUTH_CSS = `:root{color-scheme:dark;--bg:#07080b;--card:#11141c;--fg:#e9edf3;--muted-fg:#8d96a3;
--line:#242b39;--input:#313a4b;--primary:#2bf5a0;--primary-ink:#04130c;--down:#ff476f;--field:#0b0e14}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#f7f4ec;--card:#fffdf8;--fg:#1a1c1a;
--muted-fg:#5f635a;--line:#e3ddcf;--input:#cdc6b4;--primary:#0a7350;--primary-ink:#ffffff;--down:#d11f4f;
--field:#ffffff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font-family:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.auth{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.mark{width:34px;height:34px;color:var(--primary);margin-bottom:14px}
.mark svg{width:100%;height:100%}
h1{font-family:"Fraunces",Georgia,serif;font-size:1.4rem;font-weight:600;margin:0 0 4px}
h2{font-size:.95rem;margin:26px 0 8px;font-weight:600}
p{color:var(--muted-fg);font-size:.9rem;line-height:1.5;margin:0 0 16px}
p.error{color:var(--down)}
p.notice{color:var(--primary)}
label{display:block;font-size:.82rem;color:var(--muted-fg);margin:14px 0 6px}
input,select{width:100%;padding:10px 12px;background:var(--field);border:1px solid var(--input);border-radius:8px;
color:var(--fg);font:inherit;font-size:.95rem}
input:focus,select:focus{outline:2px solid var(--primary);outline-offset:1px}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--primary);
color:var(--primary-ink);font:inherit;font-weight:650;cursor:pointer}
button.secondary{background:transparent;color:var(--muted-fg);border:1px solid var(--line);margin-top:10px}
table{width:100%;border-collapse:collapse;font-size:.86rem;margin-top:6px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)}
th{color:var(--muted-fg);font-weight:500}
td form{display:inline}
td button{width:auto;margin:0;padding:4px 9px;font-size:.78rem;background:transparent;color:var(--muted-fg);
border:1px solid var(--line)}
.foot{margin-top:22px;font-size:.8rem;color:var(--muted-fg)}
.foot a{color:var(--primary)}
code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.85em}
`;

const loginForm = (next: string | undefined): string =>
  `<form method="post" action="/login">` +
  (next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "") +
  `<label for="u">Username</label>` +
  `<input id="u" name="username" autocomplete="username" autocapitalize="none" autofocus required>` +
  `<label for="p">Password</label>` +
  `<input id="p" name="password" type="password" autocomplete="current-password" required>` +
  `<button type="submit">Sign in</button></form>`;

/** `next` is attacker-controlled. Only a same-site absolute path is ever followed. */
const safeNext = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
};

const formValue = (body: Record<string, unknown>, key: string): string => {
  const v = body[key];
  return typeof v === "string" ? v : "";
};

export function mountConsoleAuth(app: Hono, deps: ConsoleAuthDeps): void {
  const now = deps.now ?? (() => new Date());

  /**
   * Whoami, for the console shell's rail. It is what lets the UI show who you are and
   * offer a way out — before this, an operator who signed in had no affordance anywhere
   * on any of the eight console pages to sign out again, and `/account` was reachable
   * only by typing it.
   *
   * Answers 200 with `authenticated: false` rather than 401, so the shell can render the
   * private no-accounts console (which has no session and never will) without treating a
   * normal state as an error.
   */
  app.get("/api/session", async (c) => {
    const principal = getPrincipal(c);
    const hasAccounts = (await deps.store.read()).users.length > 0;
    if (!principal || principal.kind !== "session") {
      return c.json({ authenticated: false, hasAccounts });
    }
    return c.json({
      authenticated: true,
      hasAccounts,
      username: principal.username,
      role: principal.role,
    });
  });

  app.get("/auth.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(AUTH_CSS);
  });

  // ── First-run ──────────────────────────────────────────────────────────────────
  const setupAllowed = async (c: Context): Promise<boolean> => {
    if ((await deps.store.read()).users.length > 0) return false;
    if (deps.loopbackOnly) return true;
    // Reachable from elsewhere: only someone already holding the machine credential may
    // claim the console. Otherwise the first stranger to find it becomes its administrator.
    return getPrincipal(c)?.kind === "machine";
  };

  const setupRefusal = (c: Context) =>
    c.text(
      "First-run setup is closed.\n\n" +
        "Either an administrator already exists (sign in at /login), or this console is\n" +
        "reachable from outside the box and no DASHBOARD_AUTH credential was presented —\n" +
        "in which case setup must be done over loopback, or with that credential.\n",
      403,
    );

  app.get("/setup", async (c) => {
    if (!(await setupAllowed(c))) return setupRefusal(c);
    return c.html(
      page({
        title: "Create the first administrator",
        body:
          `<p>This console has no accounts yet. The account you make here can sign in, ` +
          `run the ops writes, and add the rest of your team.</p>` +
          `<form method="post" action="/setup">` +
          `<label for="u">Username</label>` +
          `<input id="u" name="username" autocomplete="username" autocapitalize="none" autofocus required>` +
          `<label for="p">Password</label>` +
          `<input id="p" name="password" type="password" autocomplete="new-password" required>` +
          `<label for="p2">Repeat password</label>` +
          `<input id="p2" name="repeat" type="password" autocomplete="new-password" required>` +
          `<button type="submit">Create administrator</button></form>`,
        error: c.req.query("error"),
      }),
    );
  });

  app.post("/setup", async (c) => {
    if (!(await setupAllowed(c))) return setupRefusal(c);
    const verdict = checkOrigin(c, "strict");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const username = formValue(body, "username");
    const password = formValue(body, "password");
    if (password !== formValue(body, "repeat")) {
      return c.redirect(`/setup?error=${encodeURIComponent("Those passwords do not match.")}`, 303);
    }
    const created = await createUser(deps.store, { username, password, role: "admin", now });
    if (!created.ok) return c.redirect(`/setup?error=${encodeURIComponent(created.error)}`, 303);

    await deps.auditor.record({
      action: "console.bootstrap",
      outcome: "ok",
      actor: { kind: "session", userId: created.user.id, name: created.user.username, role: "admin" },
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
    });

    const issued = await createSession(deps.store, created.user.id, {
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      ...(c.req.header("User-Agent") ? { userAgent: c.req.header("User-Agent") as string } : {}),
        now,
      },
      deps.lifetimes,
    );
    c.header("Set-Cookie", sessionCookie(issued.token, { secure: secureOf(c) }), { append: true });
    return c.redirect("/", 303);
  });

  // ── Sign in / out ──────────────────────────────────────────────────────────────
  app.get("/login", async (c) => {
    if (getPrincipal(c)?.kind === "session") return c.redirect("/", 302);
    if ((await deps.store.read()).users.length === 0 && (await setupAllowed(c))) return c.redirect("/setup", 302);
    return c.html(
      page({
        title: "Sign in",
        body: loginForm(safeNext(c.req.query("next"))),
        error: c.req.query("error"),
        notice: c.req.query("notice"),
      }),
    );
  });

  app.post("/login", async (c) => {
    const verdict = checkOrigin(c, "strict");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const username = formValue(body, "username");
    const next = safeNext(body["next"]);
    const result = await authenticate(deps.store, username, formValue(body, "password"));

    if (!result.user) {
      await deps.auditor.record({
        action: "console.sign_in",
        outcome: "failed",
        actor: { ...anonymousActor(), name: username.slice(0, 64) || "-" },
        ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
        detail: { reason: result.disabled ? "disabled" : "bad_credentials" },
      });
      // 401, not a 200 with a message: authThrottle charges failed sign-ins by status, and
      // a login form that answers 200 to a wrong password disarms the lockout.
      c.status(401);
      return c.html(
        page({
          title: "Sign in",
          body: loginForm(next),
          error: result.disabled ? "That account is disabled." : "Wrong username or password.",
        }),
      );
    }

    const issued = await createSession(deps.store, result.user.id, {
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      ...(c.req.header("User-Agent") ? { userAgent: c.req.header("User-Agent") as string } : {}),
        now,
      },
      deps.lifetimes,
    );
    await deps.auditor.record({
      action: "console.sign_in",
      outcome: "ok",
      actor: { kind: "session", userId: result.user.id, name: result.user.username, role: result.user.role },
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
    });
    c.header("Set-Cookie", sessionCookie(issued.token, { secure: secureOf(c) }), { append: true });
    return c.redirect(result.user.mustChangePassword ? "/account/password" : (next ?? "/"), 303);
  });

  app.post("/logout", async (c) => {
    const principal = getPrincipal(c);
    const verdict = checkOrigin(c, principal?.kind === "session" ? "strict" : "lenient");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);

    if (principal?.token) {
      // Server-side destruction, not just a cleared cookie: OWASP is explicit that logout
      // must invalidate on both sides, and a token that still resolves is still a key.
      await destroySession(deps.store, principal.token);
      await deps.auditor.record({
        action: "console.sign_out",
        outcome: "ok",
        actor: {
          kind: "session",
          ...(principal.userId ? { userId: principal.userId } : {}),
          name: principal.username,
          role: principal.role,
        },
        ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      });
    }
    for (const cookie of clearSessionCookies(secureOf(c))) {
      c.header("Set-Cookie", cookie, { append: true });
    }
    return c.redirect("/login?notice=Signed+out.", 303);
  });

  // ── Account ────────────────────────────────────────────────────────────────────
  app.get("/account/password", (c) => {
    const principal = getPrincipal(c);
    if (principal?.kind !== "session") return c.text("Sign in to change a password.\n", 403);
    return c.html(
      page({
        title: "Set a new password",
        body:
          (principal.mustChangePassword
            ? `<p>This account was created from a seeded password, so it has to be changed before ` +
              `the console will do anything else.</p>`
            : "") +
          `<form method="post" action="/account/password">` +
          `<label for="cur">Current password</label>` +
          `<input id="cur" name="current" type="password" autocomplete="current-password" required>` +
          `<label for="new">New password</label>` +
          `<input id="new" name="password" type="password" autocomplete="new-password" required>` +
          `<label for="rep">Repeat new password</label>` +
          `<input id="rep" name="repeat" type="password" autocomplete="new-password" required>` +
          `<button type="submit">Change password</button></form>`,
        error: c.req.query("error"),
      }),
    );
  });

  app.post("/account/password", async (c) => {
    const principal = getPrincipal(c);
    if (principal?.kind !== "session" || !principal.userId) return c.text("Sign in to change a password.\n", 403);
    const verdict = checkOrigin(c, "strict");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const fail = (msg: string) => c.redirect(`/account/password?error=${encodeURIComponent(msg)}`, 303);

    // The current password is required even though the session already proves identity:
    // it is what stops a borrowed, unlocked browser from becoming a permanent takeover.
    const confirmed = await authenticate(deps.store, principal.username, formValue(body, "current"));
    if (!confirmed.user) return fail("Your current password is wrong.");

    const password = formValue(body, "password");
    if (password !== formValue(body, "repeat")) return fail("Those passwords do not match.");
    const policy = validatePassword(password);
    if (policy) return fail(policy);

    const changed = await setPassword(deps.store, principal.userId, password, now);
    if (!changed.ok) return fail(changed.error);

    // A password change is a privilege event: every OTHER session for this account dies,
    // and this one is re-minted. That is what makes "my password may have leaked" a fix
    // the operator can actually perform.
    await destroyUserSessions(deps.store, principal.userId, principal.token);
    if (principal.token) await destroySession(deps.store, principal.token);
    const issued = await createSession(deps.store, principal.userId, {
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      ...(c.req.header("User-Agent") ? { userAgent: c.req.header("User-Agent") as string } : {}),
        now,
      },
      deps.lifetimes,
    );
    c.header("Set-Cookie", sessionCookie(issued.token, { secure: secureOf(c) }), { append: true });

    await deps.auditor.record({
      action: "console.password_changed",
      outcome: "ok",
      actor: { kind: "session", userId: principal.userId, name: principal.username, role: principal.role },
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
    });
    return c.redirect("/account?notice=Password+changed.", 303);
  });

  const renderAccounts = async (c: Context, opts: { error?: string; notice?: string } = {}) => {
    const principal = getPrincipal(c);
    if (!principal) return c.text("Not signed in.\n", 401);
    const isAdmin = principal.role === "admin";
    const users = isAdmin ? await listUsers(deps.store) : [];

    const row = (u: ConsoleUser): string =>
      `<tr><td>${escapeHtml(u.username)}${u.disabledAt ? " <span class=\"foot\">(disabled)</span>" : ""}</td>` +
      `<td>${u.role}</td><td>` +
      (u.id === principal.userId
        ? "<span class=\"foot\">you</span>"
        : `<form method="post" action="/account/users/${escapeHtml(u.id)}/disabled">` +
          `<input type="hidden" name="disabled" value="${u.disabledAt ? "false" : "true"}">` +
          `<button type="submit">${u.disabledAt ? "Enable" : "Disable"}</button></form>`) +
      `</td></tr>`;

    return c.html(
      page({
        title: "Account",
        error: opts.error ?? c.req.query("error"),
        notice: opts.notice ?? c.req.query("notice"),
        body:
          `<p>Signed in as <code>${escapeHtml(principal.username)}</code> (${principal.role}).</p>` +
          `<form method="post" action="/logout"><button type="submit" class="secondary">Sign out</button></form>` +
          `<h2>Password</h2><p><a href="/account/password">Change your password</a></p>` +
          (isAdmin
            ? `<h2>Operators</h2><table><tr><th>User</th><th>Role</th><th></th></tr>` +
              users.map(row).join("") +
              `</table>` +
              `<h2>Add an operator</h2>` +
              `<form method="post" action="/account/users">` +
              `<label for="nu">Username</label><input id="nu" name="username" autocapitalize="none" required>` +
              `<label for="np">Password</label>` +
              `<input id="np" name="password" type="password" autocomplete="new-password" required>` +
              `<label for="nr">Role</label>` +
              `<select id="nr" name="role"><option value="viewer">viewer — read only</option>` +
              `<option value="admin">admin — may run the ops writes</option></select>` +
              `<button type="submit">Add operator</button></form>`
            : "") +
          `<p class="foot"><a href="/">Back to the console</a></p>`,
      }),
    );
  };

  app.get("/account", (c) => renderAccounts(c));

  app.post("/account/users", requireRole("admin"), async (c) => {
    const principal = getPrincipal(c);
    const verdict = checkOrigin(c, principal?.kind === "session" ? "strict" : "lenient");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const role: ConsoleRole = formValue(body, "role") === "admin" ? "admin" : "viewer";
    const created = await createUser(deps.store, {
      username: formValue(body, "username"),
      password: formValue(body, "password"),
      role,
      now,
    });
    await deps.auditor.record({
      action: "console.user_created",
      outcome: created.ok ? "ok" : "refused",
      actor: {
        kind: principal?.kind ?? "anonymous",
        ...(principal?.userId ? { userId: principal.userId } : {}),
        name: principal?.username ?? "-",
        ...(principal?.role ? { role: principal.role } : {}),
      },
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      detail: { username: formValue(body, "username").slice(0, 64), role },
    });
    if (!created.ok) return c.redirect(`/account?error=${encodeURIComponent(created.error)}`, 303);
    return c.redirect(`/account?notice=${encodeURIComponent(`Added ${created.user.username}.`)}`, 303);
  });

  app.post("/account/users/:id/disabled", requireRole("admin"), async (c) => {
    const principal = getPrincipal(c);
    const verdict = checkOrigin(c, principal?.kind === "session" ? "strict" : "lenient");
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const disabled = formValue(body, "disabled") === "true";
    const target = c.req.param("id");
    if (target === principal?.userId) {
      return c.redirect(`/account?error=${encodeURIComponent("You cannot disable your own account.")}`, 303);
    }
    const result = await setDisabled(deps.store, target, disabled, now);
    await deps.auditor.record({
      action: disabled ? "console.user_disabled" : "console.user_enabled",
      outcome: result.ok ? "ok" : "refused",
      actor: {
        kind: principal?.kind ?? "anonymous",
        ...(principal?.userId ? { userId: principal.userId } : {}),
        name: principal?.username ?? "-",
        ...(principal?.role ? { role: principal.role } : {}),
      },
      ...(clientIp(c) ? { ip: clientIp(c) as string } : {}),
      detail: { targetId: target },
    });
    if (!result.ok) return c.redirect(`/account?error=${encodeURIComponent(result.error)}`, 303);
    return c.redirect("/account?notice=Saved.", 303);
  });
}
