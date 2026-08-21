/**
 * The console's Content-Security-Policy, in one place and therefore testable.
 *
 * It lived inline in server.ts until a directive in it silently broke the sign-in page:
 * `form-action 'none'` was correct while the console had no forms, and became a bug the
 * moment it had one. Nothing could catch that — a CSP is enforced by the BROWSER, so
 * every test that calls the app directly sees a perfectly good 200. Keeping the policy
 * here at least lets a test state what each directive is for, so the next person changing
 * the console's shape has to look at it.
 */
export const CSP_DIRECTIVES: readonly string[] = [

      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      // Inherited from default-src, but stated so the "we ship our own faces, we
      // never reach a CDN" decision is legible to anyone auditing the header.
      "font-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      // 'self', not 'none'. It was 'none' while the console had no forms at all, and that
      // was right then — but the sign-in, first-run and account pages are forms, and
      // form-action does NOT fall back to default-src, so 'none' made every one of them a
      // button that silently does nothing. The browser blocks the submission before it is
      // sent, with only a console message; the server never sees a request, so no test that
      // calls the app directly can see it either. Found 2026-08-21 by driving the real page.
      // 'self' keeps the property that mattered: a form on this origin cannot be made to
      // POST an operator's credentials to somewhere else.
      "form-action 'self'",
      "frame-ancestors 'none'",
];

export const CSP = CSP_DIRECTIVES.join("; ");
