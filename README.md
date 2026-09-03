# @bryanberger/jmap-mcp

Local MCP server that exposes a [Stalwart](https://stalw.art) mail server's JMAP surface to an AI assistant, with no data leaving your machine except the exchange with your own server.

## What it covers

- **Mail**: search, read, compose, send, file and delete messages, manage folders.
- **Contacts**: search and read cards, write them, manage address books.
- **Calendar**: search and read events, check availability, create, correct, answer and delete.
- **Files**: browse, fetch to disk, upload from disk, organize and delete.
- **Sieve**: list scripts, store one, choose which one filters, manage the vacation response.
- **Sharing**: read who an object is open to, grant and revoke rights, dismiss notifications.

Twenty-nine tools in all, described one by one in [the tools reference](docs/reference/tools/README.md).

## Quick start with Claude Code

You need the URL of your server's JMAP session and a bearer token it accepts, obtained as [the token page](docs/getting-started/stalwart-token.md) describes.

```sh
claude mcp add jmap --transport stdio --scope user \
  --env JMAP_SESSION_URL=https://mail.example.com/.well-known/jmap \
  --env JMAP_BEARER_TOKEN=API_xxx \
  -- npx -y @bryanberger/jmap-mcp
```

Claude Desktop and Cursor take the same server through a JSON file; see [the documentation](docs/README.md).

## Write policy

Every call is classified from its arguments into one of four classes: `read`, `draft`, `send`, `destroy`.
Each class has a level, `allow`, `confirm` or `deny`, and by default `send` and `destroy` are confirmed before they run.
A confirmation is a question asked through your MCP client, which must support elicitation; when it does not, the call is refused rather than run silently.
The question names what the call is about to do: the recipients, the messages, the rights, the script.
[The write policy page](docs/explanation/write-policy.md) explains the whole mechanism and how to tune it.

## Documentation

| Page | Answers |
| --- | --- |
| [Getting a token from Stalwart](docs/getting-started/stalwart-token.md) | Which bearer the server accepts, and how to check it |
| [Claude Code](docs/getting-started/claude-code.md), [Claude Desktop](docs/getting-started/claude-desktop.md), [Cursor](docs/getting-started/cursor.md) | How to register the server in each client |
| [Configuration](docs/reference/configuration.md) | Every key and variable, with its default |
| [Tools](docs/reference/tools/README.md) | What each of the twenty-nine tools does, and when it asks |
| [Limits](docs/reference/limits.md) | Every ceiling, and what happens past it |
| [Write policy](docs/explanation/write-policy.md) | Classes, levels, confirmation, recipient perimeter |
| [Troubleshooting](docs/troubleshooting.md) | What a refusal or a startup error means |

The documentation lives on GitHub and is not shipped in the npm package.

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
