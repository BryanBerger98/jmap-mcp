# Configuration reference

The server reads its settings from two places, and one of them wins.

## Two sources, one precedence

| Source | Where | Wins |
| --- | --- | --- |
| Environment variables | The `env` of the MCP client entry, or the shell | Yes, key by key |
| Configuration file | `~/.config/jmap-mcp/config.json` | On every key the environment leaves unset |

The file is optional, and so is every variable except the two credentials.
When both set the same key, the environment value is kept (`src/config/load.ts`).
Under `recipients`, the merge is per key: a file that sets `scope` and a variable that sets the allow list combine.

A setting the schema refuses stops the server at startup with `Invalid jmap-mcp configuration:` followed by the failing path and reason on stderr.

## Every key

| Key | Type | Default | Variable |
| --- | --- | --- | --- |
| `sessionUrl` | URL | required | `JMAP_SESSION_URL` |
| `bearerToken` | non-empty string | required | `JMAP_BEARER_TOKEN` |
| `accountId` | string | the session's primary account | `JMAP_ACCOUNT_ID` |
| `policy.read` | `allow`, `confirm`, `deny` | `allow` | none |
| `policy.draft` | `allow`, `confirm`, `deny` | `allow` | none |
| `policy.send` | `allow`, `confirm`, `deny` | `confirm` | none |
| `policy.destroy` | `allow`, `confirm`, `deny` | `confirm` | none |
| `recipients.scope` | `anyone`, `contacts` | `anyone` | `JMAP_RECIPIENT_SCOPE` |
| `recipients.allow` | array of strings | `[]` | `JMAP_RECIPIENT_ALLOW`, comma-separated |
| `files.localRoot` | absolute path | unset | none |
| `files.maxDownloadSize` | integer, bytes | `104857600` (100 MB) | none |
| `bulkConfirmAbove` | integer | `20` | `JMAP_BULK_CONFIRM_ABOVE` |

`sessionUrl` is the JMAP session resource, usually `https://mail.example.com/.well-known/jmap`.
`bearerToken` is the token from [Get a bearer token from Stalwart](../getting-started/stalwart-token.md).
`accountId` matters only when the session exposes several accounts: unset, the server takes the primary account of the core capability, then the first account listed (`src/jmap/session.ts`).
An id the session does not know stops the server with `Account <id> is not in this JMAP session`.

## Keys without a variable

Three keys exist only in the file: `policy`, `files.localRoot` and `files.maxDownloadSize`.
A policy has four keys and three levels each, and a path can carry a comma: neither flattens into one variable without inventing a syntax the file already has.
So changing what asks and what is refused, or letting files touch the disk, means writing the file, even when the credentials come from the client's `env`.

## The write policy

`policy` maps each of the four operation classes to one of three levels.
The classes describe what a call does, never which tool made it; [The write policy](../explanation/write-policy.md) explains how a call is classified.

| Level | Effect |
| --- | --- |
| `allow` | Runs without a question |
| `confirm` | Asks through the client, runs on yes |
| `deny` | Refused, and a tool with no other class leaves the tool list |

Any class left out keeps its default (`src/config/policy.ts`): reads and drafts run, sends and destroys ask.

## The recipient perimeter

With `recipients.scope` at `contacts`, the server reads the account's address books once at startup, and refuses to write to any address that is neither on a contact card nor in `recipients.allow`.
The perimeter never grows during a session: a card created after startup counts on the next start.
Read failures close it rather than open it, and a book above 5000 cards is treated as unreadable.

Each `allow` entry is a full address, `user@example.com`, or a whole domain written with a leading `@`, `@example.com`.
A bare `example.com` is refused by the schema, with `Each recipients.allow entry must be an address (user@example.com) or a domain (@example.com)`.

## Files on the local disk

`files.localRoot` is the one directory `files_fetch` may write into and `files_write` may read from.
Without it, both refuse and name the key; browsing, creating a folder, organizing and deleting need no directory and work as they are.
Paths are resolved through every symlink before the check, so a link inside the root that points outside is refused too.

`files.maxDownloadSize` bounds one fetch: a node the server declares larger is refused before any byte moves, and the refusal names the key to raise.

## Constraints the schema holds

| Key | Constraint | Message |
| --- | --- | --- |
| `files.localRoot` | absolute | `files.localRoot must be an absolute path` |
| `files.localRoot` | not the filesystem root | `files.localRoot cannot be the filesystem root: it would open the whole disk to the assistant. Name a dedicated directory instead.` |
| `files.maxDownloadSize` | integer ≥ 1 | Zod's own message |
| `bulkConfirmAbove` | integer ≥ 1 | Zod's own message |
| `recipients.allow[]` | `user@example.com` or `@example.com` | `Each recipients.allow entry must be an address (user@example.com) or a domain (@example.com)` |

`JMAP_BULK_CONFIRM_ABOVE` is converted with `Number()`: a value that is not an integer fails the same constraint as in the file.

## Full example

```json
{
  "sessionUrl": "https://mail.example.com/.well-known/jmap",
  "bearerToken": "API_xxx",
  "accountId": "a",
  "policy": {
    "read": "allow",
    "draft": "allow",
    "send": "confirm",
    "destroy": "confirm"
  },
  "recipients": {
    "scope": "contacts",
    "allow": ["billing@vendor.example", "@example.org"]
  },
  "files": {
    "localRoot": "/Users/me/jmap-files",
    "maxDownloadSize": 52428800
  },
  "bulkConfirmAbove": 20
}
```

## Variants

Read-only, whichever client: every write class denied, so only the reading tools are listed.

```json
{
  "policy": { "draft": "deny", "send": "deny", "destroy": "deny" }
}
```

Claude Desktop, which cannot answer a confirmation: the two classes that would ask are denied, drafts still run.
The credentials stay in the Desktop file's `env`; see [Use with Claude Desktop](../getting-started/claude-desktop.md).

```json
{
  "policy": { "send": "deny", "destroy": "deny" }
}
```

A perimeter: the assistant may write only to people in the address books, plus one supplier and one whole domain.

```json
{
  "recipients": {
    "scope": "contacts",
    "allow": ["billing@vendor.example", "@example.org"]
  }
}
```

The same perimeter through variables, for a client entry with no file:

```sh
JMAP_RECIPIENT_SCOPE=contacts
JMAP_RECIPIENT_ALLOW=billing@vendor.example,@example.org
```
