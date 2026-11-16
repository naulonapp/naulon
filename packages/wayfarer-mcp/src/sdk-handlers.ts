/**
 * The one place in the package that reads an MCP SDK internal.
 *
 * The SDK offers a way to set a request handler and none to read one back, so a host that wants to
 * change what a handler returns would otherwise have to rebuild the SDK's own tool table. When an
 * SDK release moves the table this throws by name, and the tests of every caller fail.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type InstalledHandler<R> = (request: unknown, extra: unknown) => Promise<R>;

/** The handler the SDK installed for `method`. `caller` names the public function in each message. */
export function installedHandler<R>(server: McpServer, method: string, caller: string): InstalledHandler<R> {
  const handlers: unknown = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) {
    throw new Error(`${caller}: this version of the MCP SDK does not keep its request handlers where this package reads them`);
  }
  const handler: unknown = handlers.get(method);
  if (typeof handler !== "function") {
    throw new Error(`${caller}: the server lists no tools yet. Register a tool, then call ${caller}`);
  }
  return handler as InstalledHandler<R>;
}
