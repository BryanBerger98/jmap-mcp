# Use with Claude Desktop

Claude Desktop reads MCP servers from one JSON file.
It does not support elicitation, so every operation that needs your confirmation is refused there: read on for the exact message and the configuration that hides those tools.

## Edit the configuration file

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add a `jmap` entry under `mcpServers`, with the token from [Get a bearer token from Stalwart](./stalwart-token.md):

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

Quit and relaunch Claude Desktop: the file is read at startup only.
If the server never appears, the usual cause is a `npx` that the application cannot find, because it does not inherit your shell's `PATH`; put the absolute path of `npx` in `command`.

## Read the log

The server's stderr goes to a file named after the entry:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Logs/Claude/mcp-server-jmap.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-jmap.log` |

A healthy start ends with `jmap-mcp: 29 tools registered, 0 domains skipped, 0 tools denied by policy.`
A refused token or an unreachable host prints one sentence naming the setting to check, listed on the [troubleshooting page](../troubleshooting.md).

## What a confirmation becomes here

Every `send` and every `destroy` operation runs only after you confirm it, and the server asks through the MCP elicitation capability.
Claude Desktop does not declare that capability, so the server refuses instead of running silently.
The message it returns is, verbatim from `src/registry/compose.ts`, with the tool name and its class filled in:

```txt
Refused: mail_send is a send operation, which this server only runs after you confirm it. Your MCP client did not declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused.
```

This holds for every tool classified `send` or `destroy` on the call: sending a message, deleting one, cancelling an event with a notification, revoking a share.
Reads and drafts are unaffected: searching, reading, filing, creating a draft or an event all work.
The one exception is a draft that asks anyway, such as moving more messages than `bulkConfirmAbove` allows: that question cannot be asked either, and the call is refused with the same sentence.

## Hide what cannot run

Rather than receive that refusal on each attempt, deny the two classes in `~/.config/jmap-mcp/config.json`:

```json
{
  "policy": {
    "send": "deny",
    "destroy": "deny"
  }
}
```

A tool whose every class is denied leaves the tool list instead of failing when called: `mail_send`, `contacts_delete`, `calendar_delete`, `files_delete` and `sharing_manage` disappear.
A tool that also has a `draft` class stays, `mail_delete` or `calendar_write` for instance, and only its sending or destroying branch is refused.
The environment variables in the Desktop file keep working alongside this file, and take precedence on the keys they set; see the [configuration reference](../reference/configuration.md).

## Confidence

This behaviour was observed on 2026-08-30 with Claude Desktop, and is held with medium confidence: the handshake did not declare `elicitation`, but a later version of the application may add it.
If a write asks you a question instead of returning the refusal above, the limitation is gone and the `deny` lines can go.
