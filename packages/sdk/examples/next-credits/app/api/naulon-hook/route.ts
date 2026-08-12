import { createWebhookReceiver } from "@naulon/sdk/next";
import { memoryIdempotencyStore } from "@naulon/sdk";

// DEV ONLY. memoryIdempotencyStore is NOT durable — it forgets on restart and is
// useless across instances. In production back claim(eventId) with a DB unique
// constraint on the event id (delivery is at-least-once, so this is mandatory on a
// money path), e.g. an INSERT that throws on a duplicate eventId.
const idempotency = memoryIdempotencyStore();

export const POST = createWebhookReceiver({
  secrets: [process.env.NAULON_WEBHOOK_SECRET!], // [new, old] during a rotation
  idempotency,
  onEvent: async (event) => {
    // Runs at most once per eventId — a redelivery short-circuits to 200 before this
    // is called. Throw if the write fails: the adapter gives the claim back and the
    // non-2xx makes naulon retry, which is what you want.
    if (event.type !== "settlement.completed") return;
    console.log("settled", event.eventId, event.data);
  },
});
