#!/usr/bin/env -S npx tsx
/**
 * stdio entry point — an MCP client (Claude Desktop, Cursor, …) spawns this as a
 * child process and speaks JSON-RPC over stdin/stdout.
 *
 * Hard rule for stdio servers: stdout is the protocol channel. Nothing but
 * JSON-RPC may be written there — all diagnostics go to stderr, or they corrupt
 * the stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.ts";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("naulon-wayfarer-mcp: listening on stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`naulon-wayfarer-mcp: failed to start — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
