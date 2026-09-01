# jmap-mcp

Local MCP server that exposes a [Stalwart](https://stalw.art) mail server's JMAP surface to an AI assistant: mail, calendar, contacts, files, sharing, Sieve.

No data leaves your machine except the exchange with your own server.

> **Status: early.** Mail is implemented end to end: searching, reading, locating, composing, sending, filing and deleting. Contacts are readable and writable: cards and the address books that hold them. Calendars are readable and writable: searching, reading, checking availability, creating, correcting, answering an invitation and deleting. File storage is readable and writable: browsing, fetching, depositing, organizing and deleting. Sharing and Sieve register nothing yet.

## Tools

Twenty-five tools across four domains, mail, calendar, contacts and files. The class is what the write policy below gates.

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
| `contacts_search` | `read` | Searches contact cards, paginated, address books named |
| `contacts_read` | `read` | Reads up to 20 cards by id, every field included |
| `contacts_write` | `draft` | Creates a card, or corrects the named fields of existing ones |
| `contacts_delete` | `destroy` | Erases cards for good; contacts have no trash |
| `contacts_book_manage` | `draft` or `destroy` | Creates, renames a book; `delete` removes an empty one |
| `calendar_search` | `read` | Searches calendar events, paginated, every calendar named in the header |
| `calendar_read` | `read` | Reads up to 20 events by id, participants included |
| `calendar_availability` | `read` | Returns busy periods in a time window, no event detail |
| `calendar_write` | `draft` or `send` | Creates an event, or corrects the named fields of one; `notify` mails the invitation |
| `calendar_respond` | `send` or `draft` | Answers a received invitation; `notify: false` keeps the answer local |
| `calendar_delete` | `destroy` | Erases events for good; `notify` mails a cancellation |
| `files_browse` | `read` | Lists a folder or searches the tree, paginated |
| `files_fetch` | `read` | Writes a stored file to your disk and returns its path |
| `files_write` | `draft` | Deposits a local file, creates a folder, renames or moves nodes |
| `files_delete` | `destroy` | Erases files and folders for good; file storage has no trash |

A contact write only ever touches the fields the call names: it patches the paths given and leaves every other field of the card untouched. `contacts_delete` has no reversible form, which is why it carries a single class — no folder holds a destroyed card and no later call brings it back. Deleting an address book never destroys the cards inside it: a book still holding cards is refused, as are the default book and the last remaining one.

`mail_delete` moves messages to the folder carrying the `trash` role, where they stay readable and can be moved back out. Only `permanent: true` erases them, and that call classifies as `destroy`, so it is confirmed. Deleting a folder never takes its messages with it: a folder holding messages, or holding another folder, is refused outright, and every folder write states on the wire that no message is to be removed.

`calendar_availability` answers through `Principal/getAvailability` first, and only falls back to reading the account's own calendars when the server refuses that method with `forbidden`. The fallback cannot see calendars shared with the account by someone else, and it counts every event on an attendance-limited calendar rather than checking who is actually invited — both gaps make it under-report busy time, never over-report it.

The three calendar writes read their class off `notify`, because that argument decides whether mail leaves the account: `calendar_write` is a `draft` until it invites, and `calendar_respond` is a `send` unless `notify: false` keeps the answer to yourself. `calendar_delete` stays `destroy` whatever `notify` says — telling the participants widens who learns about the deletion, it does not soften it — and it refuses outright when the policy denies sends but the call asks to cancel. Every write states on the wire whether the server should send scheduling mail, and a successful write never proves a mail actually left: Stalwart skips scheduling silently when iTIP is off, when the account lacks the permission, or when the event is entirely in the past, so the answer says what was asked for, not what was delivered.

One gap is deliberate: a single occurrence of a recurring series cannot be corrected, answered or deleted on its own. Passing an occurrence id is refused by name rather than quietly applied to the whole series, and deleting a recurring event takes every occurrence with it.

File bytes never travel through the conversation. `files_fetch` writes the file to your disk and answers with its path; `files_write` reads a path and uploads what it finds there. Both work only inside the directory named by `files.localRoot`, which has no default: without it they refuse and say which key to set, rather than picking a directory you are not watching. Browsing, creating a folder, organizing and deleting need no such directory.

`files_browse` only sends the nine filter conditions Stalwart actually executes. The other thirteen its parser accepts — full-text, MIME type, role, dates — are silently dropped server-side, which would return more results than asked for, so they are not offered at all.

`files_delete` is the one tool here whose cascade may be turned on. A folder that still holds something is refused unless `withChildren` is set, and that flag is never assumed: the subtree is counted first, the confirmation says how many files and folders go with it, and a count the server will not produce is a refusal rather than a guess. Nothing recovers a destroyed node.

### Batch limits

The organizing, contact-writing, calendar-writing and file-writing tools act on ids a search returned, never on a filter they run themselves. The same two limits govern them.

| Limit | Value | Configurable |
| --- | --- | --- |
| Ids per call | 50 | No |
| Asks above | 20 | `bulkConfirmAbove`, `JMAP_BULK_CONFIRM_ABOVE` |

Past the threshold, a reversible bulk write asks before it runs even though its class is `allow` — moving two hundred messages is still a move, but its size is worth a look. `mail_flag` never asks whatever the volume: marking a thousand messages read is undone by marking them unread. `contacts_write` does ask past the threshold: correcting thirty cards at once stays a `draft`, but nothing on the server records what the fields held before. `calendar_write` and `calendar_respond` ask on the same ground, and for one reason more: past a certain count, a write nobody looked at is a write mailed to people nobody counted.

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

**Local file directory.** `files.localRoot` is the only directory `files_fetch` and `files_write` may read or write, and it has no environment equivalent — set it in the config file, as an absolute path.

```json
{ "files": { "localRoot": "/Users/you/jmap-files" } }
```

A relative path given to a tool is taken from that root; an absolute one is accepted only if it already lands inside it. Both are then resolved for real, symlinks included, because the string `root/link` is inside the root and the file it points at need not be.

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

Under any scope other than `anyone`, `contacts_search` and `contacts_read` mark each address they render as inside or outside the perimeter, so a refused send can be understood before it is attempted rather than after. The perimeter is frozen at startup: a card created during the session lands inside it only after a restart, and both tools say so alongside the mark.

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
