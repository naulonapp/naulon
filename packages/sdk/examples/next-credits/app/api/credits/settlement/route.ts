import { createSettlementReceiver } from "@naulon/sdk/next";
import { memoryIdempotencyStore } from "@naulon/sdk";

// DEV ONLY. memoryIdempotencyStore is NOT durable — it forgets on restart and is
// useless across instances. In production back claim(eventId) with a DB unique
// constraint on the event id (the 5-minute replay window makes this mandatory on a
// money path), e.g. an INSERT that throws on a duplicate eventId.
const idempotency = memoryIdempotencyStore();

export const POST = createSettlementReceiver({
  secrets: [process.env.CREDITS_SETTLEMENT_SECRET!], // [new, old] during a rotation
  idempotency,
  onEvent: async (event) => {
    // Persist the payout to your earnings ledger here. Runs at most once per
    // eventId — a replay short-circuits to 200 before this is called.
    console.log("settled", event.eventId, event.grossAmount, event.splits.length, "splits");
  },
});
