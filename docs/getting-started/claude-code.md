# Use with Claude Code

Claude Code registers an MCP server in one command and supports elicitation, so every confirmation the server asks for reaches you.

## Register the server

Replace the two values with your session URL and the token from [Get a bearer token from Stalwart](./stalwart-token.md).

```sh
claude mcp add jmap --transport stdio --scope user \
  --env JMAP_SESSION_URL=https://mail.example.com/.well-known/jmap \
  --env JMAP_BEARER_TOKEN=API_xxx \
  -- npx -y @bryanberger/jmap-mcp
```

The name comes first: `--env` takes several values, so a name placed after it is read as a malformed variable and the command fails.
Everything after `--` is the command Claude Code spawns; `npx -y` fetches the package on first use without prompting.

## Choose a scope

| Scope | Where it is stored | Who sees it |
| --- | --- | --- |
| `local` (default) | Your user settings, for this project only | You, in this directory |
| `project` | `.mcp.json` at the project root, committed | Everyone on the project |
| `user` | Your user settings, for every project | You, everywhere |

Do not use `project` with a token in `--env`: the file is meant to be committed, and the token would go with it.
Use `user` for a mailbox you want in every session, or `local` for one project.

## Verify

```sh
claude mcp list
claude mcp get jmap
```

The first command lists `jmap` with its health, `Connected` or `Failed to connect`; the second prints the command, the scope and the environment.
A failed connection right after registration means the server exited at startup: the session URL or the token is wrong, and the [troubleshooting page](../troubleshooting.md) lists the two messages it prints.
Inside a session, `/mcp` shows the same server with its tools.

On startup the server writes one line on stderr, visible in the `/mcp` panel:

```txt
jmap-mcp: 29 tools registered, 0 domains skipped, 0 tools denied by policy.
```

Fewer tools means a capability your server does not advertise, or a class your policy denies.
The [troubleshooting page](../troubleshooting.md) explains both.

## First prompts

A read, which runs without a question:

> Show me the unread messages of the last two days.

A write, which asks before it acts:

> Reply to the last message from Alice and tell her I confirm Thursday.

The second prompt drafts the reply, then shows what is about to leave the account and waits for your answer.
What that question contains, and how to turn it off or on per operation class, is in [The write policy](../explanation/write-policy.md).

## Remove

```sh
claude mcp remove jmap
```
