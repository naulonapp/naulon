/**
 * The URL a buyer paid for, as the citation record names it: the Host that was tolled plus the
 * path exactly as requested, with no query string (a query does not change what was priced; the slug is
 * derived from the path alone). `https` everywhere except a loopback host, which is only ever a
 * local rig and would otherwise name a URL nobody can open.
 */
export function canonicalResource(host: string, pathname: string): string {
  const scheme = /^(localhost|127\.|\[::1\])/i.test(host) ? "http" : "https";
  return `${scheme}://${host.toLowerCase()}${pathname}`;
}
