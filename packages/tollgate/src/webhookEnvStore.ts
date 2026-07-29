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

/** Rows are handed out by value: a caller mutating what it read must not reach into the store. */
function clone(e: WebhookEndpoint): WebhookEndpoint {
  return { ...e, eventTypes: [...e.eventTypes] };
}

export class EnvConfigStore implements WebhookEndpointStore {
  private readonly endpoints: WebhookEndpoint[];

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
    return Promise.resolve(this.endpoints.map(clone));
  }

  listDeliverable(_ownerUserId: string, type: WebhookEventType): Promise<WebhookEndpoint[]> {
    return Promise.resolve(this.endpoints.filter((e) => e.enabled && e.eventTypes.includes(type)).map(clone));
  }

  get(id: string): Promise<WebhookEndpoint | null> {
    const ep = this.endpoints.find((e) => e.id === id);
    return Promise.resolve(ep ? clone(ep) : null);
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

  // The failure counters live ON the endpoint row, not in a side map. They used to live in a
  // parallel `failures` Map that nothing ever read back into the row, so `consecutiveFailures`
  // reported 0 forever: the accounting was write-only, and every consumer — the auto-disable
  // threshold's own audit trail included — was told a healthy endpoint was healthy while it failed.
  bumpFailures(id: string): Promise<number> {
    const ep = this.endpoints.find((e) => e.id === id);
    if (!ep) return Promise.resolve(0);
    ep.consecutiveFailures += 1;
    return Promise.resolve(ep.consecutiveFailures);
  }

  resetFailures(id: string): Promise<void> {
    const ep = this.endpoints.find((e) => e.id === id);
    if (ep) ep.consecutiveFailures = 0;
    return Promise.resolve();
  }

  autoDisable(id: string, reason: string, at: number): Promise<void> {
    // Can't persist to an immutable env — flip the in-memory copy so this process stops hammering a
    // dead endpoint, and log it. A restart re-reads env and re-enables (self-host reloads config anyway).
    //
    // `disabledAt`/`disabledReason` are stamped too: they are what distinguishes an endpoint the
    // gate gave up on from one an operator turned off. Leaving them null made those two states
    // indistinguishable to every reader, so nothing could tell the operator WHY it stopped.
    const ep = this.endpoints.find((e) => e.id === id);
    if (ep) {
      ep.enabled = false;
      ep.disabledAt = at;
      ep.disabledReason = reason;
    }
    console.error(`[tollgate] webhook endpoint ${id} auto-disabled this process: ${reason}`);
    return Promise.resolve();
  }
}
