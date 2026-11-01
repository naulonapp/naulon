import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({ error: z.string() }).openapi("EnforceError");

/** Every route here is called with the publisher's key as a bearer token. */
export const SECURITY = [{ naulonKey: [] }];
