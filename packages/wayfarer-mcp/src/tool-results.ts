/**
 * What every `tools/call` returns, extended by the host.
 *
 * A host may owe its caller something on whichever call comes next: a notice that a paper the
 * caller read has been retracted, say. It cannot wait for one particular tool, so it needs one place
 * that sees every result, the tools of this package and its own alike.
 *
 * The decorator runs after the tool, on the finished result. It may return a new result, or null to
 * leave it as it is. It can never cost the caller the tool's own answer: a decorator that throws or
 * rejects is reported through `onError` and the result goes out unchanged.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { installedHandler } from "./sdk-handlers.ts";

/** The call a result answers. */
export interface ToolCall {
  name: string;
}

/** Returns the result to send, or null to send `result` unchanged. */
export type ToolResultDecorator = (call: ToolCall, result: CallToolResult) => CallToolResult | null | Promise<CallToolResult | null>;

export interface DecorateToolResultsOptions {
  /** Told when the decorator throws or rejects. Default: one line on `console.error`. */
  onError?: (err: unknown, call: ToolCall) => void;
}

const CALL_METHOD = "tools/call";

interface Installed {
  decorate: ToolResultDecorator;
  onError: (err: unknown, call: ToolCall) => void;
}

/** The decorator each server was last given. Its presence also marks a server whose handler is wrapped. */
const DECORATORS = new WeakMap<McpServer, Installed>();

const defaultOnError = (err: unknown, call: ToolCall): void => {
  console.error(`[wayfarer-mcp] decorateToolResults: the decorator failed on ${call.name}, sent the result unchanged: ${err instanceof Error ? err.message : String(err)}`);
};

/** A plain tool result. A task handle (`{ task }`) has no `content` and is never decorated. */
function isToolResult(v: unknown): v is CallToolResult {
  return typeof v === "object" && v !== null && Array.isArray((v as { content?: unknown }).content);
}

/**
 * Pass every `tools/call` result on `server` through `decorate` before it is sent.
 *
 * Covers this package's tools and every tool the host registers, before or after this call. A
 * result that is a task handle passes through untouched, and so does a protocol error, which is
 * never a result. Calling this again replaces the decorator. `tools/list` is untouched.
 *
 * Throws when the server has no tool registered yet, and when the installed MCP SDK no longer holds
 * its `tools/call` handler where this package reads it.
 */
export function decorateToolResults(server: McpServer, decorate: ToolResultDecorator, opts: DecorateToolResultsOptions = {}): void {
  const installed: Installed = { decorate, onError: opts.onError ?? defaultOnError };
  if (DECORATORS.has(server)) {
    DECORATORS.set(server, installed);
    return;
  }
  const call = installedHandler<unknown>(server, CALL_METHOD, "decorateToolResults");
  DECORATORS.set(server, installed);
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await call(request, extra);
    const current = DECORATORS.get(server);
    if (!current || !isToolResult(result)) return result as never;
    const which: ToolCall = { name: request.params.name };
    try {
      const next = await current.decorate(which, result);
      return (next ?? result) as never;
    } catch (err) {
      try {
        current.onError(err, which);
      } catch {
        // A reporter that throws must not cost the caller the answer either.
      }
      return result as never;
    }
  });
}
