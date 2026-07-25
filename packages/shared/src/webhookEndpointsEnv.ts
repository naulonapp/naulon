// packages/shared/src/webhookEndpointsEnv.ts — parse NAULON_WEBHOOK_ENDPOINTS (the self-host webhook
// config) into validated endpoint specs. Dark ([]) when unset/blank. Fails LOUD on malformed input so
// a self-hoster learns at boot, not at the first missed settlement. The gate's EnvConfigStore consumes
// these; the shape mirrors what cloud stores per-endpoint (url/secret/events/hostFilter).
//
// The event-type catalog is inlined (not imported from @naulon/webhooks) on purpose: @naulon/webhooks
// depends on @naulon/shared (splitMicro/AuthorShare), so shared importing webhooks would be a package
// cycle. These two strings must stay in step with @naulon/webhooks WEBHOOK_EVENT_TYPES — the gate's
// EnvConfigStore test round-trips them through the real catalog, so any drift fails there.

const WEBHOOK_EVENT_TYPES = ["anomaly.detected", "settlement.completed"] as const;
type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
const isWebhookEventType = (s: string): s is WebhookEventType =>
  (WEBHOOK_EVENT_TYPES as readonly string[]).includes(s);

export interface WebhookEndpointSpec {
  url: string;
  secret: string;
  events: WebhookEventType[];
  hostFilter: string | null;
}

export function parseWebhookEndpointsEnv(raw: string | undefined): WebhookEndpointSpec[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `NAULON_WEBHOOK_ENDPOINTS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("NAULON_WEBHOOK_ENDPOINTS must be a JSON array of { url, secret, events?, hostFilter? }");
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`NAULON_WEBHOOK_ENDPOINTS[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["url"] !== "string" || e["url"] === "") {
      throw new Error(`NAULON_WEBHOOK_ENDPOINTS[${i}] is missing a "url"`);
    }
    if (typeof e["secret"] !== "string" || e["secret"] === "") {
      throw new Error(`NAULON_WEBHOOK_ENDPOINTS[${i}] is missing a "secret"`);
    }
    let events: WebhookEventType[];
    if (e["events"] === undefined) {
      events = [...WEBHOOK_EVENT_TYPES];
    } else {
      if (!Array.isArray(e["events"])) {
        throw new Error(`NAULON_WEBHOOK_ENDPOINTS[${i}].events must be an array of event types`);
      }
      events = e["events"].map((t) => {
        if (typeof t !== "string" || !isWebhookEventType(t)) {
          throw new Error(`NAULON_WEBHOOK_ENDPOINTS[${i}] has an unknown event type: ${JSON.stringify(t)}`);
        }
        return t;
      });
    }
    const hf = e["hostFilter"];
    const hostFilter = hf === undefined || hf === null ? null : typeof hf === "string" ? hf : null;
    return { url: e["url"], secret: e["secret"], events, hostFilter };
  });
}
