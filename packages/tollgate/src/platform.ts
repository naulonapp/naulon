/** Platform tenancy over HTTP: describe many sites to one gate as plain records. */
export { publisherRecordSchema, publisherFromRecord, parsePublisherRecord, type PublisherRecord } from "./publisherRecord.ts";
export { httpPublisherResolver, type HttpPublisherResolverOptions } from "./httpPublisherResolver.ts";
