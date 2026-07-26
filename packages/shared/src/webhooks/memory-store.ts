// packages/webhooks/src/memory-store.ts — the in-memory reference WebhookEndpointStore +
// WebhookDeliveryStore. Test/dev fixture in cloud; the OSS gate's default delivery store. Pure
// (node:crypto + the core interfaces), so it lives in the shared core. Supabase (prod) stays cloud.
//
// The load-bearing detail: enqueue is idempotent on (endpoint_id, event_id) — Memory simulates
// ON CONFLICT DO NOTHING by returning the existing row, so enqueue ALWAYS returns the live row.


import { randomUUID } from "node:crypto";
import type {
  NewWebhookEndpoint,
  WebhookDelivery,
  WebhookDeliveryStore,
  WebhookEndpoint,
  WebhookEndpointStore,
  WebhookEventType,
} from "./types.ts";

/* ── in-memory (tests + dev) ─────────────────────────────────────────────────── */

function cloneEndpoint(e: WebhookEndpoint): WebhookEndpoint {
  return { ...e, eventTypes: [...e.eventTypes] };
}
function cloneDelivery(d: WebhookDelivery): WebhookDelivery {
  return { ...d };
}

export class MemoryWebhookEndpointStore implements WebhookEndpointStore {
  private rows: WebhookEndpoint[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  async listForOwner(ownerUserId: string): Promise<WebhookEndpoint[]> {
    return this.rows
      .filter((r) => r.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneEndpoint);
  }

  async listDeliverable(ownerUserId: string, type: WebhookEventType): Promise<WebhookEndpoint[]> {
    return this.rows
      .filter((r) => r.ownerUserId === ownerUserId && r.enabled && r.eventTypes.includes(type))
      .map(cloneEndpoint);
  }

  async get(id: string): Promise<WebhookEndpoint | null> {
    const r = this.rows.find((x) => x.id === id);
    return r ? cloneEndpoint(r) : null;
  }

  async create(input: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    const row: WebhookEndpoint = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      channelType: input.channelType,
      hostFilter: input.hostFilter,
      url: input.url,
      secret: input.secret,
      eventTypes: [...input.eventTypes],
      enabled: true,
      description: input.description,
      payloadProfile: input.payloadProfile ?? "summary",
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
      createdAt: this.now(),
      createdBy: input.createdBy,
    };
    this.rows.push(row);
    return cloneEndpoint(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<WebhookEndpoint, "url" | "eventTypes" | "description" | "enabled" | "secret" | "payloadProfile">>,
  ): Promise<WebhookEndpoint | null> {
    const row = this.rows.find((x) => x.id === id);
    if (!row) return null;
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.eventTypes !== undefined) row.eventTypes = [...patch.eventTypes];
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.payloadProfile !== undefined) row.payloadProfile = patch.payloadProfile;
    if (patch.secret !== undefined) row.secret = patch.secret;
    if (patch.enabled !== undefined) {
      row.enabled = patch.enabled;
      if (patch.enabled) {
        row.consecutiveFailures = 0;
        row.disabledAt = null;
        row.disabledReason = null;
      }
    }
    return cloneEndpoint(row);
  }

  async delete(id: string): Promise<void> {
    this.rows = this.rows.filter((x) => x.id !== id);
  }

  async bumpFailures(id: string): Promise<number> {
    const row = this.rows.find((x) => x.id === id);
    if (!row) return 0;
    row.consecutiveFailures += 1;
    return row.consecutiveFailures;
  }

  async resetFailures(id: string): Promise<void> {
    const row = this.rows.find((x) => x.id === id);
    if (row) row.consecutiveFailures = 0;
  }

  async autoDisable(id: string, reason: string, at: number): Promise<void> {
    const row = this.rows.find((x) => x.id === id);
    if (!row) return;
    row.enabled = false;
    row.disabledAt = at;
    row.disabledReason = reason;
  }
}

export class MemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private rows: WebhookDelivery[] = [];
  // id → claim timestamp (the lease). Mirrors the Supabase `claimed_at` column; cleared by
  // recordAttempt so it only ever governs crashed-worker recovery, not retry scheduling.
  private readonly claimedAt = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async enqueue(
    d: Omit<
      WebhookDelivery,
      | "id"
      | "createdAt"
      | "status"
      | "attemptCount"
      | "lastAttemptAt"
      | "lastStatusCode"
      | "lastResponseBody"
      | "lastError"
    > & { id?: string },
  ): Promise<WebhookDelivery> {
    // ON CONFLICT (endpointId,eventId) DO NOTHING — return the existing row if present.
    const existing = this.rows.find((r) => r.endpointId === d.endpointId && r.eventId === d.eventId);
    if (existing) return cloneDelivery(existing);
    const row: WebhookDelivery = {
      id: d.id ?? randomUUID(),
      endpointId: d.endpointId,
      eventType: d.eventType,
      eventId: d.eventId,
      host: d.host,
      payload: d.payload,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: d.nextAttemptAt,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastResponseBody: null,
      lastError: null,
      createdAt: this.now(),
    };
    this.rows.push(row);
    return cloneDelivery(row);
  }

  async listDue(now: number, limit: number): Promise<WebhookDelivery[]> {
    return this.rows
      .filter((r) => r.status === "pending" && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))
      .slice(0, limit)
      .map(cloneDelivery);
  }

  async claimDue(now: number, limit: number, leaseMs: number): Promise<WebhookDelivery[]> {
    const claimable = this.rows
      .filter((r) => r.status === "pending" && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .filter((r) => {
        const c = this.claimedAt.get(r.id);
        return c === undefined || c <= now - leaseMs; // unclaimed, or the lease has lapsed
      })
      .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))
      .slice(0, limit);
    for (const r of claimable) this.claimedAt.set(r.id, now);
    return claimable.map(cloneDelivery);
  }

  async listForEndpoint(endpointId: string, cursor: number | null, limit: number): Promise<WebhookDelivery[]> {
    return this.rows
      .filter((r) => r.endpointId === endpointId && (cursor === null || r.createdAt < cursor))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(cloneDelivery);
  }

  async get(id: string): Promise<WebhookDelivery | null> {
    const r = this.rows.find((x) => x.id === id);
    return r ? cloneDelivery(r) : null;
  }

  async recordAttempt(
    id: string,
    patch: Partial<
      Pick<
        WebhookDelivery,
        | "status"
        | "attemptCount"
        | "nextAttemptAt"
        | "lastAttemptAt"
        | "lastStatusCode"
        | "lastResponseBody"
        | "lastError"
      >
    >,
  ): Promise<void> {
    const row = this.rows.find((x) => x.id === id);
    if (!row) return;
    this.claimedAt.delete(id); // release the lease — retry timing is nextAttemptAt's job, not the lease's
    Object.assign(row, patch);
  }

  async deadLettered({ hosts, limit }: { hosts?: string[] | undefined; limit: number }): Promise<WebhookDelivery[]> {
    const hostSet = hosts === undefined ? null : new Set(hosts);
    return this.rows
      .filter((r) => r.status === "exhausted")
      .filter((r) => hostSet === null || (r.host !== null && hostSet.has(r.host)))
      .sort((a, b) => (b.lastAttemptAt ?? b.createdAt) - (a.lastAttemptAt ?? a.createdAt))
      .slice(0, limit)
      .map(cloneDelivery);
  }

  async revive(id: string, now: number): Promise<boolean> {
    const row = this.rows.find((x) => x.id === id);
    if (!row || row.status !== "exhausted") return false;
    row.status = "pending";
    row.nextAttemptAt = now;
    this.claimedAt.delete(id);
    return true;
  }
}
