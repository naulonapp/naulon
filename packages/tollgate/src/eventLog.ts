/**
 * The tollgate's binding to the shared event ledger. The sink lives in
 * @naulon/shared and is chosen by EVENTS_BACKEND — a JSONL file (the
 * dashboard + attribution read the very same file) or a Supabase table (so all
 * three agree across serverless instances). Callers here don't care which.
 */
import { getSink, type AttributedEvent } from "@naulon/shared";

const sink = getSink();
export const record = (event: AttributedEvent): Promise<void> => sink.record(event);
export const readAll = (publisherId?: string): Promise<AttributedEvent[]> => sink.readAll(publisherId);
export const get = (id: string): Promise<AttributedEvent | undefined> => sink.get(id);
