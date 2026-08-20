# @hazina/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Hazina](../../README.md) data marketplace — lets any MCP-compatible AI agent (Claude Desktop, Claude Code, or a custom SDK agent) search the catalogue, quote a price, and pay for a dataset in USDC on Stellar. It is a thin client over Hazina's existing REST API; it holds no marketplace state of its own beyond an in-process spend log.

## Tools

| Tool | Cost | Purpose |
|---|---|---|
| `search_datasets` | Free | Browse the live marketplace by text query, category, max price |
| `get_dataset` | Free | Full detail for one dataset: price, seller, freshness, sample preview |
| `quote_purchase` | Free | Exact price + payment instructions, without committing to a purchase |
| `purchase_dataset` | **Spends USDC** | Pays for and retrieves a dataset, subject to the spend limits below |
| `get_purchase_history` | Free | This session's purchase log: dataset id, amount, tx hash |

Every tool description states its own cost in USDC so a model can tell a paid tool from a free one before calling it — `purchase_dataset`'s description leads with "⚠️ SPENDS MONEY."

## Resources

- `hazina://datasets/{id}` — a dataset listing, read-only
- `hazina://receipts/{txHash}` — proof of a purchase this server made, from its own session log

## Spending controls

`purchase_dataset` is gated by two independently enforced caps, checked **before** any payment is signed:

- `HAZINA_MCP_MAX_SPEND_PER_CALL` — the most a single purchase may cost (default `1` USDC)
- `HAZINA_MCP_MAX_SPEND_PER_SESSION` — the most this server process may spend in total (default `5` USDC)

Exceeding either returns a tool-level error explaining which limit was hit and what to do about it (raise the limit, or choose a cheaper dataset) — never a silent failure or a signed transaction. Set `HAZINA_MCP_DEMO=1` to exercise the same flow in dry-run mode: `purchase_dataset` never constructs or signs a real Stellar transaction, and calls the backend's demo endpoint instead. The wallet secret (`HAZINA_WALLET_SECRET`) is read once from the environment and never accepted as a tool argument or echoed in a tool result.

**Escrow-mode backends**: if the target Hazina backend has `ESCROW_CONTRACT_ID` configured, `purchase_dataset` returns a clear error rather than attempting payment — this server currently only signs the classic memo-based (custodial-demo) payment flow. See [`docs/PASSKEY_WALLETS.md`](../../docs/PASSKEY_WALLETS.md) for the related smart-wallet work; automated escrow-mode payment from this server is a natural follow-up once that lands.

## Install

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `.claude/settings.json` for Claude Code):

```json
{
  "mcpServers": {
    "hazina": {
      "command": "npx",
      "args": ["-y", "@hazina/mcp-server"],
      "env": {
        "HAZINA_API_URL": "http://localhost:3001",
        "HAZINA_MCP_DEMO": "1"
      }
    }
  }
}
```

That's demo mode against a locally running backend — no wallet, no real spend, no code changes beyond this config block. For a real testnet purchase, drop `HAZINA_MCP_DEMO` and add a funded wallet:

```json
{
  "mcpServers": {
    "hazina": {
      "command": "npx",
      "args": ["-y", "@hazina/mcp-server"],
      "env": {
        "HAZINA_API_URL": "https://your-hazina-backend.example.com",
        "HAZINA_API_KEY": "your-api-key",
        "HAZINA_WALLET_SECRET": "S...",
        "HAZINA_MCP_MAX_SPEND_PER_CALL": "1",
        "HAZINA_MCP_MAX_SPEND_PER_SESSION": "5"
      }
    }
  }
}
```

### From source (this repo)

```bash
cd packages/hazina-mcp
npm install
npm run build
node dist/index.js   # stdio transport, reads env from the process
```

## Config reference

| Var | Default | Purpose |
|---|---|---|
| `HAZINA_API_URL` | `http://localhost:3001` | Hazina backend base URL |
| `HAZINA_API_KEY` | unset | Bearer token for the backend's payments endpoints |
| `HAZINA_WALLET_SECRET` | unset | Stellar secret key (`S…`) this server signs purchases with. Required for real (non-demo) purchases. |
| `HAZINA_MCP_DEMO` | `false` | `1`/`true` — dry-run mode, never signs a real transaction |
| `HAZINA_MCP_MAX_SPEND_PER_CALL` | `1` | USDC cap per `purchase_dataset` call |
| `HAZINA_MCP_MAX_SPEND_PER_SESSION` | `5` | USDC cap for this server process's lifetime |
| `HAZINA_MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `HAZINA_MCP_HTTP_PORT` | `8420` | Port for the streamable-HTTP transport (`HAZINA_MCP_TRANSPORT=http`, serves `POST/GET /mcp`) |

## Development

```bash
npm run dev     # tsx watch — no build step
npm test        # vitest: schema validation, spend-limit enforcement, demo mode, error mapping,
                 # a real Client<->Server run over InMemoryTransport, and a real stdio subprocess smoke test
npm run build
npm run lint
```
