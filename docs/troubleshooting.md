# Troubleshooting

Symptom first, then the cause, then what to change.
Every message quoted here is the exact text the server writes.

## The server does not start

| Symptom | Cause | Remedy |
| --- | --- | --- |
| ``jmap-mcp: The JMAP server refused the credentials. Check `bearerToken`: it may be expired, mistyped, or without access to this account.`` | The session URL answered 401 or 403 | Run the `curl` of [Get a bearer token from Stalwart](getting-started/stalwart-token.md); an OAuth token has expired after one hour |
| ``jmap-mcp: The JMAP server could not be reached. Check `sessionUrl` and that the host answers from this machine.`` | DNS, TLS or a refused connection | Check the URL ends in `/.well-known/jmap` and that the host resolves from this machine |
| `jmap-mcp: Invalid jmap-mcp configuration: …` | A setting the schema refuses | The rest of the line names the key; see the [configuration constraints](reference/configuration.md) |
| `jmap-mcp: Account <id> is not in this JMAP session` | `accountId` names an account the token cannot see | Unset it, or use an id the session lists |
| `Failed to connect` in `claude mcp list` right after adding | The server exited at startup | Read the stderr line above in `claude mcp get jmap` |
| The server never appears in Claude Desktop | `npx` not found: the application does not inherit the shell's `PATH` | Put the absolute path of `npx` in `command` |

A healthy start writes one line, `jmap-mcp: 29 tools registered, 0 domains skipped, 0 tools denied by policy.`, and the three numbers say where a missing tool went.

## Tools are missing

| Symptom | Cause | Remedy |
| --- | --- | --- |
| `N domains skipped` above zero | The server does not advertise a capability the domain requires | Nothing to change here: enable the feature on Stalwart, or accept the smaller surface |
| `N tools denied by policy` above zero | Every class of the tool is `deny` in `policy` | Expected if you denied the class; otherwise edit `policy` in the [configuration](reference/configuration.md) |
| Fewer than 29 tools and both numbers at zero | The count is from another version of the package | Compare with the [tool reference](reference/tools/README.md) |

Each domain requires one or two capabilities: the sending tools need `urn:ietf:params:jmap:submission` on top of mail, availability needs `urn:ietf:params:jmap:principals:availability`, sharing needs `urn:ietf:params:jmap:principals`.
The full table is in the [tool reference](reference/tools/README.md).

## A call is refused

| Symptom | Cause | Remedy |
| --- | --- | --- |
| `Refused: <tool> is a <class> operation and the policy denies that class.` | The class of this call is `deny` | Set it to `confirm` or `allow` in `policy`, or ask for the reversible variant of the call |
| `Refused: <tool> is a <class> operation, which this server only runs after you confirm it. Your MCP client did not declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused.` | The client cannot ask you a question | Use a client that supports elicitation, or deny the class so the tool disappears; see [Use with Claude Desktop](getting-started/claude-desktop.md) |
| `Refused: <reason> This server only runs that after you confirm it, and your MCP client did not declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused.` | A bulk call raised a question the client cannot carry | Split the call under `bulkConfirmAbove`, or raise that key |
| `Refused: <address> is outside the recipient perimeter this server is configured with. Only addresses held in your address books, or listed in the allow setting, can be written to. Add the address to a contact card, or to that list.` | `recipients.scope` is `contacts` and the address is on no card | Add a card, or the address to `recipients.allow`, then restart |
| `Refused: this server is restricted to the addresses in your address books, and they could not be read (…). Nothing is sent while the perimeter is unknown.` | The perimeter failed to resolve at startup | The parenthesis names why: no contacts capability, a failed read, or more than 5000 cards |
| `Refused: this server is restricted to the addresses in your address books, and the perimeter is empty — no contact card and no allowed address. There is nobody it may write to.` | The scope is restricted and nothing is inside it | Create a contact card, or fill `recipients.allow` |
| `Refused: this server moves file bytes only inside a directory you have named, and files.localRoot is not set. …` | `files_fetch` or `files_write` without a local directory | Set `files.localRoot` to an absolute path in the file; there is no variable for it |
| `Refused: <path> resolves to <real path>, which is outside <root>. …` | The path, or a symlink on it, leaves `files.localRoot` | Use a path under the root |
| `Refused: <name> is <size> and this server fetches at most <ceiling> per file (…). …` | The node is larger than `files.maxDownloadSize` | Raise the key |
| `Refused: <n> <noun> ids were given, and this server acts on at most 50 per call. …` | More than 50 ids in one call | Batches of 50, one call each; see [Limits](reference/limits.md) |
| `Refused: this call would have the server mail a cancellation to the participants, and policy.send is set to deny in the configuration. …` | `calendar_delete` with `notify` under `send: deny` | Call again without `notify`, or lift `policy.send` |
| `Refused: switching the automatic reply on makes the vacation script the active one, … and policy.destroy is set to deny in the configuration. …` | `vacation_manage` with `isEnabled` under `destroy: deny` | Change the text without `isEnabled`, or lift `policy.destroy` |

The angle brackets stand for the value the message carries, and an ellipsis for the sentence that follows.
Which class each call falls in, and why a draft may still ask, is in [The write policy](explanation/write-policy.md).

## Where to read stderr

| Client | Where |
| --- | --- |
| Claude Code | `claude mcp get jmap` shows the health; the `/mcp` panel inside a session shows the server's output |
| Claude Desktop | `~/Library/Logs/Claude/mcp-server-jmap.log` on macOS, `%APPDATA%\Claude\logs\mcp-server-jmap.log` on Windows |
| Cursor | **Settings › MCP**, then the server's output panel; or the **Output** panel with the MCP channel selected |
| A shell | Run `JMAP_SESSION_URL=… JMAP_BEARER_TOKEN=… npx -y @bryanberger/jmap-mcp` and read the first line; the server then waits on stdin, stop it with `Ctrl-C` |
