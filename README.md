# jmap-mcp

Local MCP server that exposes a [Stalwart](https://stalw.art) mail server's JMAP surface to an AI assistant: mail, calendar, contacts, files, sharing, Sieve.

No data leaves your machine except the exchange with your own server.

> **Status: early.** Mail is the only domain implemented: searching, reading, locating, composing, sending, filing and deleting. The five other domains register nothing yet.

## Tools

Ten tools, all on mail. The class is what the write policy below gates.

| Tool | Class | Does |
| --- | --- | --- |
| `mail_search` | `read` | Searches messages, paginated |
| `mail_read` | `read` | Reads one message, body included |
| `mail_folders` | `read` | Lists the folder tree |
| `mail_identities` | `read` | Lists the addresses the account may send from |
| `mail_compose` | `draft` | Writes a draft, sends nothing |
| `mail_send` | `send` | Sends an existing draft |
| `mail_move` | `draft` | Files messages into one folder |
| `mail_flag` | `draft` | Sets or clears `$seen`, `$flagged` and the other standard keywords |
| `mail_delete` | `draft` or `destroy` | Moves to the trash; `permanent` erases instead |
| `mail_folder_manage` | `draft` or `destroy` | Creates, renames, moves a folder; `delete` removes one |

`mail_delete` moves messages to the folder carrying the `trash` role, where they stay readable and can be moved back out. Only `permanent: true` erases them, and that call classifies as `destroy`, so it is confirmed. Deleting a folder never takes its messages with it: a folder holding messages, or holding another folder, is refused outright, and every folder write states on the wire that no message is to be removed.

### Batch limits

The organizing tools act on ids a search returned, never on a filter they run themselves.

| Limit | Value | Configurable |
| --- | --- | --- |
| Ids per call | 50 | No |
| Asks above | 20 | `bulkConfirmAbove`, `JMAP_BULK_CONFIRM_ABOVE` |

Past the threshold, a reversible bulk write asks before it runs even though its class is `allow` — moving two hundred messages is still a move, but its size is worth a look. `mail_flag` never asks whatever the volume: marking a thousand messages read is undone by marking them unread.

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

Optional: `JMAP_ACCOUNT_ID` pins one account when the session exposes several, and `JMAP_BULK_CONFIRM_ABOVE` (config key `bulkConfirmAbove`, default `20`) sets how many objects a reversible write may touch before it asks.

**Recipient perimeter.** `recipients.scope` bounds who the server may write to. It is resolved once at startup, before any tool is registered.

| Value | Effect |
| --- | --- |
| `anyone` | Default. No restriction, nothing read. |
| `contacts` | This account's contact cards, plus `recipients.allow`. |

`recipients.allow` widens the perimeter by hand: a full address (`ops@example.net`) or a whole domain (`@example.net`). Both keys have an environment equivalent, comma-separated for the list.

```sh
export JMAP_RECIPIENT_SCOPE="contacts"
export JMAP_RECIPIENT_ALLOW="ops@example.net,@example.org"
```

The perimeter fails closed. When the address books cannot be read — no contacts capability, a failing request, an account holding more cards than the server will hold in memory — every recipient is refused, including one the allow list names. An out-of-perimeter address is refused **before** the confirmation is asked, not after.

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
