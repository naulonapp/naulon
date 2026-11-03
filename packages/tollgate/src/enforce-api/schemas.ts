import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({ error: z.string() }).openapi("EnforceError");

/** Every route here is called with the publisher's key as a bearer token. */
export const SECURITY = [{ naulonKey: [] }];

/**
 * The version of the in-app protocol this module serves: the routes, their bodies and their
 * refusals. A runtime in any language is written against this, not against the gate's package
 * version. Bump the major for any change an existing runtime would break on.
 */
export const ENFORCE_API_VERSION = "1.1.0";

/** Where the OpenAPI document for this API is served. */
export const OPENAPI_PATH = "/_naulon/openapi.json";
