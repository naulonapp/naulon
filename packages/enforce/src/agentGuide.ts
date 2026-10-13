/**
 * What a 402 tells an agent that has never heard of naulon: what the page is, what it costs, how
 * to pay, and what to tell its human if it cannot pay. One builder, so the JSON body, the x402
 * `error` field, the markdown and HTML bodies and the manifest can never disagree.
 *
 * Pure except `guideLinks`, which is the one config read, kept apart so the builder can run on any
 * hot path. Everything else derives from the legs the 402 already carries.
 *
 * Most agents that meet a 402 cannot pay. So the floor is `forYourUser.text`: a sentence written to
 * be passed on verbatim, which names the free URL first (humans read free) and the price second.
 * An agent that can pay reads `howToPay`, which states in words what is otherwise only in base64.
 */
import { getConfig, networkByCaip2, type NetworkName, type TollKind } from "@naulon/shared";
import type { SettlementLegReq } from "./build402.ts";
import { formatCrawlerPrice, toMicro, totalChargedMicro } from "./crawlerPrice.ts";

/** Cap on `forYourUser.text`: short enough that an assistant relays it whole. */
export const FOR_YOUR_USER_MAX = 400;
/** Cap on the x402 `error` field, which rides base64-encoded inside a response header. */
export const HEADER_ERROR_MAX = 300;
const TITLE_MAX = 120;
/** Circle's buyer-side guide to the deposit a `GatewayWalletBatched` payment draws on. */
export const CIRCLE_GATEWAY_DOCS = "https://developers.circle.com/gateway/nanopayments";

const NETWORK_LABEL: Record<NetworkName, string> = {
  arc: "Arc", arcTestnet: "Arc testnet", base: "Base", baseSepolia: "Base Sepolia",
  ethereum: "Ethereum", arbitrum: "Arbitrum", optimism: "Optimism", polygon: "Polygon",
  avalanche: "Avalanche", unichain: "Unichain", sei: "Sei", sonic: "Sonic",
  hyperEvm: "HyperEVM", worldChain: "World Chain",
};

export interface AgentGuideLinks {
  /** Where an agent learns to pay. Always present. */
  guide: string;
  /** The toll manifest for this site. */
  manifest: string;
  /** Where a person sets up an agent wallet, when the deployment has one. */
  fund?: string;
  /** An MCP server an agent can install to buy here, when the deployment has one. */
  mcp?: string;
}

export interface GuideStep {
  id: "fund" | "sign" | "retry";
  do: string;
  contract?: string;
  docs?: string;
}

export interface AgentGuideInput {
  /** The URL being tolled, which is also where a person reads it free, and its title. */
  resource: { url: string; title: string };
  tollKind: TollKind;
  /** The legs `build402` assembled, author first. */
  legs: readonly SettlementLegReq[];
  links: AgentGuideLinks;
}

export interface AgentGuide {
  forYourUser: { text: string; readFreeUrl: string; title: string };
  howToPay: {
    protocol: "x402 v2";
    /** The whole ask across every leg, in the `crawler-price` vocabulary. */
    price: string;
    network: { caip: string; name: string; testnet: boolean };
    asset: { symbol: "USDC"; address: string; decimals: 6 };
    /** Which leg a stock x402 client signs (`inAccepts`) and which ride the naulonLegs extension. */
    legs: { role: string; atomic: string; inAccepts: boolean; extension?: "naulonLegs" }[];
    steps: GuideStep[];
  };
  links: AgentGuideLinks;
}

/** A CAIP-2 id in words. An unknown network falls back to its id rather than guessing a name. */
export function networkLabel(caip: string): { name: string; testnet: boolean } {
  const net = networkByCaip2(caip);
  if (!net) return { name: caip, testnet: false };
  return { name: NETWORK_LABEL[net.chainName], testnet: net.testnet };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** The rail facts every surface needs, read once off leg 0 (the author leg, `accepts[0]`). */
function describeRail(legs: readonly SettlementLegReq[]) {
  const first = legs[0];
  if (!first) throw new Error("agentGuide needs at least one leg");
  const req = first.requirements;
  const extra = req.extra ?? {};
  const contract = typeof extra.verifyingContract === "string" ? extra.verifyingContract : undefined;
  const gateway = extra.name === "GatewayWalletBatched" && contract !== undefined;
  return { req, gateway, contract, net: networkLabel(req.network), price: formatCrawlerPrice(totalChargedMicro(legs)) };
}

/**
 * The fund, sign and retry steps. `multiLeg` is `"when-present"` where the leg count is not known
 * yet (the article-agnostic manifest), so the sign step covers both wire shapes.
 */
export function guideSteps(o: {
  gateway: boolean;
  networkName: string;
  contract?: string;
  scheme: string;
  multiLeg: boolean | "when-present";
}): GuideStep[] {
  const steps: GuideStep[] = [];
  if (o.gateway) {
    steps.push({
      id: "fund",
      do: `Deposit USDC into Circle Gateway on ${o.networkName} once. Payments draw on that Gateway balance, not on your wallet balance.`,
      ...(o.contract ? { contract: o.contract } : {}),
      docs: CIRCLE_GATEWAY_DOCS,
    });
  }
  const scheme = `scheme ${o.scheme}${o.gateway ? ", GatewayWalletBatched" : ""}`;
  const legsNote =
    o.multiLeg === true
      ? " One signed object pays the author leg and is served. To pay the whole ask, send a JSON array with one signed payload per naulonLegs entry, in order."
      : o.multiLeg === "when-present"
        ? " When the 402 carries a naulonLegs extension, an array with one signed payload per leg, in order, pays the whole ask; one signed object pays the author leg and is served."
        : "";
  steps.push({ id: "sign", do: `Sign accepts[0] from the PAYMENT-REQUIRED header (${scheme}).${legsNote}` });
  steps.push({ id: "retry", do: "Repeat this request with the base64 signed payload in the PAYMENT-SIGNATURE header." });
  return steps;
}

/** The relay sentence. Clauses drop, title first, before the cap breaks; the URL is never cut
 *  unless nothing else is left, because a clipped URL is a wrong URL. */
function forYourUserText(title: string, url: string, price: string, what: string, guide: string): string {
  const named = title ? `"${title}" is free to read in a browser at ${url}.` : `This page is free to read in a browser at ${url}.`;
  const anon = `This page is free to read in a browser at ${url}.`;
  const cost = `An AI agent pays ${price} per ${what}.`;
  const setup = `To let an assistant pay for pages like this, see ${guide}.`;
  for (const candidate of [`${named} ${cost} ${setup}`, `${anon} ${cost} ${setup}`, `${named} ${cost}`, `${anon} ${cost}`]) {
    if (candidate.length <= FOR_YOUR_USER_MAX) return candidate;
  }
  return clip(`${anon} ${cost}`, FOR_YOUR_USER_MAX);
}

export function agentGuide(input: AgentGuideInput): AgentGuide {
  const r = describeRail(input.legs);
  const title = clip(oneLine(input.resource.title), TITLE_MAX);
  const what = input.tollKind === "citation" ? "citation" : "read";
  return {
    forYourUser: {
      text: forYourUserText(title, input.resource.url, r.price, what, input.links.guide),
      readFreeUrl: input.resource.url,
      title,
    },
    howToPay: {
      protocol: "x402 v2",
      price: r.price,
      network: { caip: r.req.network, ...r.net },
      asset: { symbol: "USDC", address: r.req.asset, decimals: 6 },
      // Through the one wire parser, so a malformed amount is refused here instead of being
      // advertised to a buyer as something to sign.
      legs: input.legs.map((l, i) => ({
        role: l.role,
        atomic: toMicro(l.requirements.amount).toString(),
        inAccepts: i === 0,
        ...(i > 0 ? { extension: "naulonLegs" as const } : {}),
      })),
      steps: guideSteps({
        gateway: r.gateway,
        networkName: r.net.name,
        ...(r.contract ? { contract: r.contract } : {}),
        scheme: r.req.scheme,
        multiLeg: input.legs.length > 1,
      }),
    },
    links: input.links,
  };
}

/**
 * The x402 v2 `PaymentRequired.error`: "human-readable error message explaining why payment is
 * required" (spec §5.1.2). The one sentence a header-only x402 client is guaranteed to read, so it
 * carries the network, the deposit and the guide. It does not repeat the page URL: `resource.url`
 * sits beside it in the same object, and spending the cap on it would push the guide out.
 */
export function headerError(legs: readonly SettlementLegReq[], guideUrl: string): string {
  const r = describeRail(legs);
  const via = r.gateway ? ` via Circle Gateway; deposit to the Gateway Wallet ${r.contract} first` : "";
  const head = `Payment required: ${r.price} in USDC on ${r.net.name} (${r.req.network})${via}.`;
  for (const candidate of [`${head} Humans read free in a browser. Guide: ${guideUrl}`, `${head} Humans read free in a browser.`]) {
    if (candidate.length <= HEADER_ERROR_MAX) return candidate;
  }
  return clip(head, HEADER_ERROR_MAX);
}

/** The one config read: the deployment's buyer links, with fund and MCP only when set. */
export function guideLinks(
  manifest: string,
  cfg: { BUYER_GUIDE_URL: string; BUYER_FUND_URL?: string | undefined; BUYER_MCP_URL?: string | undefined } = getConfig(),
): AgentGuideLinks {
  return {
    guide: cfg.BUYER_GUIDE_URL,
    manifest,
    ...(cfg.BUYER_FUND_URL ? { fund: cfg.BUYER_FUND_URL } : {}),
    ...(cfg.BUYER_MCP_URL ? { mcp: cfg.BUYER_MCP_URL } : {}),
  };
}
