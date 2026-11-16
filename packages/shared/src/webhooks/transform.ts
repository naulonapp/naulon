// src/webhooks/transform.ts — the four channel transformers. The sender stays a single path; only
// the wire shape branches on channel_type. `raw` returns the canonical JSON verbatim (it is what
// the HMAC signs); the three chat channels render a one-line human summary into each provider's
// "incoming webhook" envelope. Slice-1 formatting is intentionally minimal (a summary line, one
// small Discord embed) — rich Block Kit / multi-field cards are a follow-up.
//
// Wire shapes are grounded in live source docs (design §4/§12):
//   slack   — {text}                              (Slack incoming webhooks; no signing)
//   discord — {content, embeds[]}                 (Discord execute-webhook)
//   teams   — {type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",
//             content:{AdaptiveCard…}}]}          (Power Automate Workflows incoming webhook)

import type { WebhookChannelType, WebhookEventType } from "./types.ts";

/** The canonical event body — the same object the raw wire wraps. */
export interface CanonicalEvent {
  id: string;
  type: WebhookEventType | "ping";
  eventId: string;
  createdAt: number;
  data: unknown;
}

/** How a chat line states each `paper.notice` kind. A correction never reads as a retraction. */
const NOTICE_PHRASE: Record<string, string> = {
  retraction: "was retracted",
  withdrawal: "was withdrawn",
  concern: "has an expression of concern",
  correction: "was corrected",
};

/** One human-readable line per event, channel-agnostic. Exported for the transform test. */
export function summarize(eventType: WebhookEventType | "ping", data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (eventType) {
    case "settlement.completed": {
      const tenant = typeof d["tenant"] === "string" ? d["tenant"] : "your site";
      const acked = typeof d["acked"] === "number" ? d["acked"] : "?";
      const gross = typeof d["grossMicroUsdc"] === "number" ? d["grossMicroUsdc"] : null;
      const money = gross !== null ? ` (${gross} µUSDC gross)` : "";
      return `Settlement completed for ${tenant}: ${acked} citation(s) settled${money}.`;
    }
    case "anomaly.detected": {
      const detail = typeof d["detail"] === "string" ? d["detail"] : "an anomaly was detected";
      const metric = typeof d["metric"] === "string" ? `[${d["metric"]}] ` : "";
      return `Anomaly detected: ${metric}${detail}.`;
    }
    case "paper.notice": {
      const notices = Array.isArray(d["notices"]) ? (d["notices"] as unknown[]) : [];
      const more = typeof d["more"] === "number" ? d["more"] : 0;
      const total = notices.length + more;
      const first = (notices[0] ?? {}) as Record<string, unknown>;
      const paper = (first["paper"] ?? {}) as Record<string, unknown>;
      const title = typeof paper["title"] === "string" && paper["title"] ? `"${paper["title"]}"` : null;
      const what = NOTICE_PHRASE[typeof first["type"] === "string" ? first["type"] : ""] ?? "has a new notice";
      const rest = total > 1 ? ` (${total - 1} more paper notice${total - 1 === 1 ? "" : "s"} waiting)` : "";
      return title ? `A paper you read changed: ${title} ${what}${rest}.` : `A paper you read ${what}${rest}.`;
    }
    case "ping":
      return "Naulon webhook test ping. Your endpoint is configured correctly.";
  }
}

export interface WireResult {
  body: string;
}

/** Render the canonical event into the wire body for `channelType`. */
export function renderWire(
  channelType: WebhookChannelType,
  eventType: WebhookEventType | "ping",
  canonical: CanonicalEvent,
): WireResult {
  switch (channelType) {
    case "raw":
      return { body: JSON.stringify(canonical) };
    case "slack":
      return { body: JSON.stringify({ text: summarize(eventType, canonical.data) }) };
    case "discord": {
      const line = summarize(eventType, canonical.data);
      return {
        body: JSON.stringify({
          content: line,
          embeds: [{ title: eventType, description: line }],
        }),
      };
    }
    case "teams":
      return {
        body: JSON.stringify({
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              contentUrl: null,
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.2",
                body: [{ type: "TextBlock", text: summarize(eventType, canonical.data), wrap: true }],
              },
            },
          ],
        }),
      };
    default: {
      const _never: never = channelType;
      throw new Error(`unhandled channel_type: ${String(_never)}`);
    }
  }
}
