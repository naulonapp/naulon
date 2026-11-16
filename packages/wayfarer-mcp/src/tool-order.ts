/**
 * The order `tools/list` returns, stated by the host.
 *
 * A model reads the listing top to bottom, and a host that mounts tools of its own beside this
 * package's may want one of them read first. The SDK lists tools in registration order and offers
 * no way to change it, so the host would otherwise have to rebuild the SDK's own tool table.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installedHandler } from "./sdk-handlers.ts";

type ListResult = { tools: { name: string }[] } & Record<string, unknown>;

const LIST_METHOD = "tools/list";

/** The order each server was last given. Its presence also marks a server whose handler is wrapped. */
const ORDERS = new WeakMap<McpServer, readonly string[]>();

/** `tools` with the names in `order` first, in that order, and every other tool after them as it stood. */
function inOrder<T extends { name: string }>(tools: readonly T[], order: readonly string[]): T[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const first = order.flatMap((name) => byName.get(name) ?? []);
  const placed = new Set(first);
  return [...first, ...tools.filter((tool) => !placed.has(tool))];
}

/**
 * State the order `tools/list` returns for `server`.
 *
 * The tools named in `names` come first, in the order given. Every tool not named follows, in the
 * order it was registered. The order is applied each time a client lists, so it covers this
 * package's tools and any tool the host registers on the server, before or after this call.
 *
 * A name with no registered tool is ignored at list time, and so is a repeat of a name already
 * given. `toolContractProblems` reports the first when passed the same list as `order`. Calling
 * this again replaces the order. It changes the listing only: `tools/call` is untouched.
 *
 * Throws when the server has no tool registered yet, and when the installed MCP SDK no longer
 * holds its `tools/list` handler where this package reads it.
 */
export function orderTools(server: McpServer, names: readonly string[]): void {
  const order = [...new Set(names)];
  if (ORDERS.has(server)) {
    ORDERS.set(server, order);
    return;
  }
  const list = installedHandler<ListResult>(server, LIST_METHOD, "orderTools");
  ORDERS.set(server, order);
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await list(request, extra);
    return { ...result, tools: inOrder(result.tools, ORDERS.get(server) ?? []) } as never;
  });
}
