// packages/tollgate/src/webhookEnvStore.ts — a read-only WebhookEndpointStore backed by
// NAULON_WEBHOOK_ENDPOINTS. The self-host counterpart to cloud's Supabase store: same interface,
// immutable source. Endpoints are synthesized from the parsed env specs; failure counters live in
// memory (a restart re-reads env, so a transient auto-disable simply resets — fine for self-host,
// where the source of truth is a config file, not a mutable table).

import type { WebhookEndpointSpec } from "@naulon/shared";
import type {
  NewWebhookEndpoint,
  WebhookEndpoint,
  WebhookEndpointStore,
  WebhookEventType,
} from "@naulon/shared";

const IMMUTABLE = "EnvConfigStore is read-only — webhook endpoints come from NAULON_WEBHOOK_ENDPOINTS";

export class EnvConfigStore implements WebhookEndpointStore {
  private readonly endpoints: WebhookEndpoint[];
  private readonly failures = new Map<string, number>();

  constructor(specs: WebhookEndpointSpec[]) {
    this.endpoints = specs.map((s, i) => ({
      id: `env:${i}`,
      ownerUserId: "self-host",
      channelType: "raw",
      hostFilter: s.hostFilter,
      url: s.url,
      secret: s.secret,
      eventTypes: s.events,
      enabled: true,
      description: null,
      payloadProfile: "summary",
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
      createdAt: 0,
      createdBy: "env",
    }));
  }

  listForOwner(_ownerUserId: string): Promise<WebhookEndpoint[]> {
    return Promise.resolve([...this.endpoints]);
  }

  listDeliverable(_ownerUserId: string, type: WebhookEventType): Promise<WebhookEndpoint[]> {
    return Promise.resolve(this.endpoints.filter((e) => e.enabled && e.eventTypes.includes(type)));
  }

  get(id: string): Promise<WebhookEndpoint | null> {
    return Promise.resolve(this.endpoints.find((e) => e.id === id) ?? null);
  }

  create(_input: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    return Promise.reject(new Error(IMMUTABLE));
  }

  update(
    _id: string,
    _patch: Partial<
      Pick<WebhookEndpoint, "url" | "eventTypes" | "description" | "enabled" | "secret" | "payloadProfile">
    >,
  ): Promise<WebhookEndpoint | null> {
    return Promise.reject(new Error(IMMUTABLE));
  }

  delete(_id: string): Promise<void> {
    return Promise.reject(new Error(IMMUTABLE));
  }

  bumpFailures(id: string): Promise<number> {
    const n = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, n);
    return Promise.resolve(n);
  }

  resetFailures(id: string): Promise<void> {
    this.failures.delete(id);
    return Promise.resolve();
  }

  autoDisable(id: string, reason: string, _at: number): Promise<void> {
    // Can't persist to an immutable env — flip the in-memory copy so this process stops hammering a
    // dead endpoint, and log it. A restart re-reads env and re-enables (self-host reloads config anyway).
    const ep = this.endpoints.find((e) => e.id === id);
    if (ep) ep.enabled = false;
    console.error(`[tollgate] webhook endpoint ${id} auto-disabled this process: ${reason}`);
    return Promise.resolve();
  }
}
