# @naulon/wayfarer-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets any
LLM **discover, quote, pay, and cite** naulon-tolled sources — bring your own
wallet, local stdio, the [wayfarer](../wayfarer) brain running in-process.

Point any MCP-capable client at this server and the model gains tools to find
tolled articles, get a quote, pay the `402` toll from a wallet you control, and
cite what it bought — the same budgeted buying loop the CLI agent runs, exposed
as callable tools and slash commands.

Works with **any MCP client**: Claude Code, Claude Desktop, Cursor, Windsurf,
Cline, VS Code, or your own host. Setup for each is below.

---

## Quick start

```bash
npx -y @naulon/wayfarer-mcp        # runs the stdio MCP server
```

The package is scoped (`@naulon/wayfarer-mcp`); the binary it installs is
`wayfarer-mcp`. It runs **offline against mock settlement by default** — safe to
try with zero config, no wallet, no spend. To pay real tolls, see
[Configuration](#configuration).

The canonical registration, which every client below is a variant of:

```jsonc
{
  "mcpServers": {
    "naulon": { "command": "npx", "args": ["-y", "@naulon/wayfarer-mcp"] }
  }
}
```

---

## Slash commands (prompts)

Every prompts-capable client surfaces these as native, argument-taking slash
commands — no per-user config. In Claude Code / Desktop they appear as
`/mcp__naulon__<name>` (the `naulon` segment is whatever you named the server):

| Prompt | Argument | Does |
|--------|----------|------|
| `research` | `topic` | Discover sources, see prices, return a grounded cited answer within budget. |
| `discover` | `topic` | List candidate sources — **free**, no payment. |
| `verify` | `claim` | Fact-check a claim against tolled sources, citing what it paid for. |
| `ask`\* | `question` | Hosted reading agent: pays per citation, returns a grounded answer. |

\* `ask` is only present on the **hosted** endpoint (it drives the cloud
`naulon_ask` tool). The stdio server exposes `research` / `discover` / `verify`.

---

## Per-client setup

### Claude Code

CLI (recommended — `--scope project` writes a shared `.mcp.json`, `user` makes it
global across your projects):

```bash
claude mcp add naulon --scope user -- npx -y @naulon/wayfarer-mcp
```

Then `/mcp` inside Claude Code to confirm it connected, and type `/` to see the
`research` / `discover` / `verify` prompts. Or add it by hand to `.mcp.json`
(project) using the canonical block above.

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```jsonc
{
  "mcpServers": {
    "naulon": { "command": "npx", "args": ["-y", "@naulon/wayfarer-mcp"] }
  }
}
```

Restart Claude Desktop. Prompts appear in the `+` / slash-command menu.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project), key
`mcpServers` — same canonical block above.

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, key `mcpServers` — same canonical block.

### VS Code (native MCP / Copilot agent)

`.vscode/mcp.json` (workspace). VS Code uses the `servers` key and an explicit
`type`:

```jsonc
{
  "servers": {
    "naulon": { "type": "stdio", "command": "npx", "args": ["-y", "@naulon/wayfarer-mcp"] }
  }
}
```

### Cline

Cline → MCP Servers → Configure (`cline_mcp_settings.json`), key `mcpServers` —
same canonical block.

### Any other MCP host

Spawn the stdio binary and speak MCP over its stdio transport:

```
command: npx   args: ["-y", "@naulon/wayfarer-mcp"]
```

---

## Hosted endpoint (no local wallet)

naulon-cloud exposes the same brain over **Streamable HTTP** at `/_naulon/mcp`,
authenticated with an agent token — tolls are signed by naulon's custody-free
session key, so **no private key ever touches your machine**. This endpoint also
adds the cloud-only `naulon_ask` tool + its `ask` prompt.

Clients that support remote/HTTP MCP with headers:

```bash
# Claude Code
claude mcp add --transport http naulon \
  https://<your-naulon-host>/_naulon/mcp \
  --header "Authorization: Bearer <AGENT_TOKEN>"
```

```jsonc
// Generic HTTP MCP config
{
  "mcpServers": {
    "naulon": {
      "type": "http",
      "url": "https://<your-naulon-host>/_naulon/mcp",
      "headers": { "Authorization": "Bearer <AGENT_TOKEN>" }
    }
  }
}
```

Mint the agent token from your naulon buyer wallet / dashboard. Spend is bounded
by the server budget **and** the token's sub-cap — the model can lower a run's
budget, never raise it past either.

---

## Configuration

Env read by the stdio server (all optional — omit for the offline mock):

| Var | Purpose |
|-----|---------|
| `PAYMENT_MODE` | `gateway` to pay real tolls over Circle Gateway on Arc Network (default: mock). |
| `BUYER_PRIVATE_KEY` | The wallet the toll is paid from. BYO-key path; a hosted deploy signs through a cloud signer instead. |
| `TOLLGATE_URL` | The gate every payment resolves against. Payments only ever flow here — a prompt-injected model cannot redirect them. |
| `WAYFARER_BUDGET_USDC` | The session spend ceiling. The model can never raise it. |
| `WAYFARER_ALLOW_DOMAINS` / `WAYFARER_DENY_DOMAINS` | Publisher allow/deny lists for `naulon_research`. |
| `WAYFARER_PER_DOMAIN_CAP` | Max paid reads per publisher per session. |
| `WAYFARER_KILL_SWITCH` | Hard stop — refuse all spend. |

Budget and wallet are **server config, never tool arguments** — the model plans
spend within the envelope but can't widen it.

---

## Tools

| Tool | Cost | Does |
|------|------|------|
| `naulon_discover` | free | Candidate teasers for a topic (slug, title, summary). Start here. |
| `naulon_appraise` | free | Relevance + rationale for teasers already held. |
| `naulon_quote` | free | The x402 `402` probe — real price + terms, **no spend**. |
| `naulon_pay_and_read` | **$** | Pays the toll, returns content + settlement ref + citation license. |
| `naulon_read_held` | free | Re-read a held live license (PoP-signed if cnf-bound). |
| `naulon_research` | **$** | One composite that runs the whole discover→quote→pay→ground loop. |
| `naulon_ask`\* | **$** | Hosted-only reading agent — grounded, numbered-citation answer. |

\* hosted endpoint only. All tools carry MCP annotations (`readOnlyHint` on the
free ones) so clients render safe-vs-spends correctly.

---

MIT.
