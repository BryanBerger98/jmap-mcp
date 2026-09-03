# Use with Cursor

Cursor reads the same JSON shape as Claude Desktop, from one of two files.
It supports elicitation, so confirmations work: a `send` or a `destroy` asks you before it runs.

## Choose the file

| File | Scope |
| --- | --- |
| `.cursor/mcp.json` | This project only |
| `~/.cursor/mcp.json` | Every project on this machine |

Do not commit a project file that carries the token.
Either keep the token in `~/.config/jmap-mcp/config.json` and leave `env` out, or put the project file in `.gitignore`.

## Register the server

```json
{
  "mcpServers": {
    "jmap": {
      "command": "npx",
      "args": ["-y", "@bryanberger/jmap-mcp"],
      "env": {
        "JMAP_SESSION_URL": "https://mail.example.com/.well-known/jmap",
        "JMAP_BEARER_TOKEN": "API_xxx"
      }
    }
  }
}
```

Get the token from [Get a bearer token from Stalwart](./stalwart-token.md).
Cursor picks the file up without a restart; the server shows under **Settings › MCP** with its tool count.

## Confirmations

When the assistant calls a tool classified `send` or `destroy`, Cursor shows a dialog with one line describing the effect and the question `Proceed?`.
Decline and nothing is emitted to the server.
What the line contains, which operations ask, and how to change that per class is in [The write policy](../explanation/write-policy.md).
