# jmap-mcp

Local MCP server that exposes a [Stalwart](https://stalw.art) mail server's JMAP surface to an AI assistant: mail, calendar, contacts, files, sharing, Sieve.

No data leaves your machine except the exchange with your own server.

> **Status: early.** The scaffolding, the JMAP client and the policy guard are in place. No domain tool is implemented yet, so the server currently registers zero tools.

## Why

Prior art stops at mail and executes writes without asking. This server differs on two points:

- **Six JMAP domains**, not one.
- **A write policy** that gates every irreversible operation behind an explicit confirmation.

## Write policy

Every tool call is classified from its _arguments_, not from its method name — one argument is enough to turn a write into a deletion. Each class has a configurable level: `allow`, `confirm`, or `deny`.

| Class | Covers | Default |
| --- | --- | --- |
| `read` | Reading, searching, listing | `allow` |
| `draft` | Reversible writes, drafts | `allow` |
| `send` | Outbound sending, irreversible | `confirm` |
| `destroy` | Permanent deletion | `confirm` |

`confirm` relies on MRTR, the required-input pattern of MCP revision `2026-07-28`. **When the client does not expose it, the tool refuses — it never executes silently.** Claude Desktop does not support elicitation today, so `send` and `destroy` operations fail there by design.

## Configuration

Set both variables, or put the same keys in `~/.config/jmap-mcp/config.json`. The environment wins.

```sh
export JMAP_SESSION_URL="https://mail.example.com/.well-known/jmap"
export JMAP_BEARER_TOKEN="…"   # never passed as a CLI argument
```

Optional: `JMAP_ACCOUNT_ID` pins one account when the session exposes several.

## Register with a client

```sh
claude mcp add jmap -- npx -y jmap-mcp
```

## Development

Requires Node 24 (`nvm use`) and pnpm.

```sh
pnpm install
pnpm typecheck   # tsc, native Go compiler
pnpm test        # vitest
pnpm lint        # biome
pnpm build       # emits dist/
```

Architecture, decisions and the full file tree live in [`aidd_docs/INSTALL.md`](aidd_docs/INSTALL.md). Contribution workflow in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
