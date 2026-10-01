/**
 * The caller's address inside a publisher's own runtime, for the crawler identity check.
 *
 * Edge runtimes expose no socket, so the address is whatever the platform's edge writes into a
 * header. Each preset names that platform's header; auto-detection picks a preset from the
 * platform's own env. With nothing detected and nothing configured the answer is null, which
 * leaves every claim `unverified` (free reads unchanged), never a guess from X-Forwarded-For.
 *
 * Headers, as the platforms document them:
 *   - Vercel: https://vercel.com/docs/headers/request-headers (`x-vercel-forwarded-for`, `x-real-ip`)
 *   - Cloudflare: https://developers.cloudflare.com/fundamentals/reference/http-headers/
 *     (`cf-connecting-ipv6` carries the real address when pseudo-IPv4 rewrites `cf-connecting-ip`)
 *   - Netlify: `x-nf-client-connection-ip` on functions. Netlify Edge Functions carry the address on
 *     `context.ip` instead, so there the preset finds nothing and claims read `unverified`.
 */

export type ClientIpOption = "vercel" | "netlify" | "cloudflare" | "none" | { header: string };

const PRESETS: Record<"vercel" | "netlify" | "cloudflare", readonly string[]> = {
  vercel: ["x-vercel-forwarded-for", "x-real-ip"],
  netlify: ["x-nf-client-connection-ip"],
  cloudflare: ["cf-connecting-ipv6", "cf-connecting-ip"],
};

function detect(req: Request, env: Record<string, string | undefined>): "vercel" | "netlify" | "cloudflare" | null {
  if (env.VERCEL === "1") return "vercel";
  if (env.NETLIFY === "true") return "netlify";
  if ("cf" in req && (req as { cf?: unknown }).cf) return "cloudflare";
  return null;
}

const processEnv = (): Record<string, string | undefined> =>
  typeof process !== "undefined" && process.env ? process.env : {};

export function sdkClientIp(
  req: Request,
  opt: ClientIpOption | undefined,
  env: Record<string, string | undefined> = processEnv(),
): string | null {
  if (opt === "none") return null;
  const first = (h: string): string | null => req.headers.get(h)?.split(",")[0]?.trim() || null;
  if (typeof opt === "object") return first(opt.header.toLowerCase());
  const preset = opt ?? detect(req, env);
  if (!preset) return null;
  for (const h of PRESETS[preset]) {
    const v = first(h);
    if (v) return v;
  }
  return null;
}
