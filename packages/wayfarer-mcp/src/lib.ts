/**
 * @naulon/wayfarer-mcp — public library surface.
 *
 * The side-effect-free barrel the package.json `exports` map points at. `index.ts`
 * (the stdio bin) is a thin consumer of `buildServer`, never the other way round —
 * so the cloud can `buildServer()` and wrap it over its own authenticated transport
 * without dragging in the stdio bootstrap.
 */
export { buildServer, MAX_EMPTY_NOTE_CHARS, MAX_HOST_INSTRUCTIONS_CHARS, SERVER_NAME, SERVER_VERSION, TOOL_NAMES, type BuildServerOptions, type DecisionAuditEvent, type PeriodLicence } from "./server.ts";
export {
  cloudMemoSigner,
  cloudPopSigner,
  cloudSignerFromEnv,
  GrantExceededError,
  SignerError,
  type CloudSignerOpts,
} from "./cloud-signer.ts";
export {
  toolContractProblems,
  toolNamer,
  MAX_TOOL_DESCRIPTION_CHARS,
  type ListedTool,
  type ToolNamer,
  type SchemaNode,
  type ToolContractOptions,
} from "./tool-contract.ts";
export { orderTools } from "./tool-order.ts";
export { decorateToolResults, type DecorateToolResultsOptions, type ToolCall, type ToolResultDecorator } from "./tool-results.ts";
