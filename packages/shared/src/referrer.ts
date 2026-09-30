/**
 * The referring host of a person's read, when it is another site.
 *
 * One rule for every runtime that records traffic (the gate and the in-app middleware), so a
 * publisher's referral figures mean the same thing whichever way their site is wired. A same-site
 * referrer is internal navigation, not an arrival. An unparseable header is dropped rather than
 * stored as typed. Only the host is returned: the rest of a referring URL can identify the
 * reader's own conversation on the site that sent them.
 */
export function referrerHost(referer: string | null | undefined, ownHost: string): string | undefined {
  if (!referer) return undefined;
  try {
    const h = new URL(referer).hostname.toLowerCase();
    const own = ownHost.toLowerCase().replace(/:\d+$/, "");
    return h === "" || h === own ? undefined : h;
  } catch {
    return undefined;
  }
}
