/**
 * @naulon/wayfarer-mcp — public library surface.
 *
 * The side-effect-free barrel the package.json `exports` map points at. `index.ts`
 * (the stdio bin) is a thin consumer of `buildServer`, never the other way round —
 * so the cloud can `buildServer()` and wrap it over its own authenticated transport
 * without dragging in the stdio bootstrap.
 */
export { buildServer, SERVER_NAME, SERVER_VERSION, type BuildServerOptions, type DecisionAuditEvent } from "./server.ts";
export {
  cloudMemoSigner,
  cloudPopSigner,
  cloudSignerFromEnv,
  GrantExceededError,
  SignerError,
  type CloudSignerOpts,
} from "./cloud-signer.ts";
