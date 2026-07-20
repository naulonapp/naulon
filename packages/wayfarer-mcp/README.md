# @naulon/wayfarer-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets any
LLM discover, quote, pay, and cite naulon-tolled sources — bring your own wallet,
local stdio, the [wayfarer](../wayfarer) brain running in-process.

Point an MCP-capable client (Claude Desktop, an agent framework, your own host) at
this server and the model gains tools to find tolled articles, get a quote, pay the
`402` toll from a wallet you control, and cite what it bought — the same budgeted
buying loop the CLI agent runs, exposed as callable tools.

## Run

```bash
npx -y @naulon/wayfarer-mcp            # stdio MCP server
```

The package name is scoped (`@naulon/wayfarer-mcp`); the binary it installs is
`wayfarer-mcp`.

Register it with your MCP client (example — Claude Desktop `mcpServers`):

```jsonc
{
  "mcpServers": {
    "wayfarer": { "command": "npx", "args": ["-y", "@naulon/wayfarer-mcp"] }
  }
}
```

It runs offline against mock settlement by default. Provide a funded wallet and
`PAYMENT_MODE=gateway` to pay tolls for real over Circle Gateway on Arc Network; a hosted
deployment can sign through a cloud signer (`cloud-signer.ts`) instead of holding a
raw key.

MIT.
