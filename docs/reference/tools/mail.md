# Mail tools

Nine tools, in three manifests.
The reading and organizing manifests require `urn:ietf:params:jmap:mail`; the sending manifest requires `urn:ietf:params:jmap:submission` on top of it.
A server that does not advertise one of these capabilities drops every tool of the manifest that requires it, so a server without `submission` keeps six mail tools and loses `mail_identities`, `mail_compose` and `mail_send`.
Every class named below is applied by the [write policy](../../explanation/write-policy.md), and every ceiling is listed in [Limits](../limits.md).

## Reading

Manifest `mail`, requiring `urn:ietf:params:jmap:mail`.
None of its three tools writes anything.

### mail_search

Searches messages and returns their envelope: date, sender, subject, and the id that `mail_read` takes.
Criteria are ANDed and at least one is required; results come newest first.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `from` | string | no | Substring matched against the From header |
| `to` | string | no | Substring matched against the To header |
| `deliveredTo` | string | no | Alias matched on the Delivered-To header |
| `subject` | string | no | Substring matched against the subject |
| `text` | string | no | Substring matched against headers and body |
| `mailboxId` | string | no | One folder, as listed by `mail_folders` |
| `after` | string | no | Received at or after this UTC date |
| `before` | string | no | Received strictly before this UTC date |
| `limit` | integer | no | Messages to fetch, 1 to 100, 25 by default |
| `cursor` | string | no | Cursor from a previous page |

Dates are UTC timestamps such as `2026-08-01T00:00:00Z`.
The server has no notion of a newsletter, a bill or a mailing list: such a question has to be expressed as criteria.
`deliveredTo` becomes a Delivered-To header condition, and Stalwart drops a malformed header condition without an error, so a result set can come back wider than asked.

**Refuses or asks.**
With neither a criterion nor a cursor: `Refused: give at least one criterion, or a cursor from a previous page.`
A cursor that cannot be decoded is refused as unreadable, a cursor issued for other criteria is refused before any request, and a cursor whose mailbox changed since is refused after the query with `Run the search again from the start.`
Nothing here asks a confirmation.

Pagination: a page holds up to `limit` messages and is cut once its rendering passes 4000 characters; a cut page ends with `[more results — cursor: …]`, and the cursor is passed back with the same criteria.

Example prompts:

> Find the messages from my accountant received since the first of August.

> Show me what landed on my newsletter alias last week, then the next page.

### mail_read

Reads up to five messages by id: headers, then the body as text.
Each body is cut at 8000 bytes and the cut is announced in the output; a message with no plain-text part is degraded from its HTML.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | Message ids from `mail_search`, 5 at most |
| `maxBodyBytes` | integer | no | Bytes of body kept per message, 200 to 8000 |

`maxBodyBytes` only lowers the ceiling of 8000 bytes; it never raises it.

**Refuses or asks.**
This tool takes ids, never a filter: the schema refuses an empty list and more than five ids.
An id the account does not hold is listed under `Not found:` rather than refused.
Nothing here asks a confirmation.

Example prompts:

> Read the two messages you just found from the bank.

> Open the first result and give me the full body, up to the limit.

### mail_folders

Lists the folders of the mailbox with their full path, role, and unread count.
The `id` column is what `mail_search` takes as `mailboxId` and what the organizing tools take as a folder.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `includeEmpty` | boolean | no | Keep folders holding no message, true by default |

A folder whose parent is not in the account is listed under its own name, with no path.

**Refuses or asks.**
Nothing refuses and nothing asks: the call reads the whole tree in one request.

Example prompts:

> List my mail folders with their unread counts.

> Which folders are empty right now?

## Organizing

Manifest `mail-organizing`, requiring `urn:ietf:params:jmap:mail`.
Its three tools act on ids only: none of them takes a search criterion, so a search rerun cannot touch messages you never saw.

### mail_organize

Files the named messages into one folder, or sets and clears their keywords: read, flagged, answered, forwarded, junk, not junk, phishing.
A move takes each message out of every folder it was in; a marking moves nothing.

Class: `draft`, whatever the action.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum: move, flag | yes | File into one folder, or set and clear keywords |
| `ids` | string[] | yes | Message ids from `mail_search` or `mail_read` |
| `mailboxId` | string | no | Destination folder, from `mail_folders` |
| `add` | string[] | no | Keywords to set, without the leading `$` |
| `remove` | string[] | no | Keywords to clear, without the leading `$` |

`mailboxId` is required on `move`; on `flag`, at least one keyword must be named in `add` or `remove`.
Keywords are limited to `seen`, `flagged`, `answered`, `forwarded`, `junk`, `notjunk` and `phishing`; a keyword named in both lists ends up set.

**Refuses or asks.**
An empty `ids` list is refused with `Refused: no message id was given, so there is nothing to act on.`, and more than 50 ids with `Refused: 51 message ids were given, and this server acts on at most 50 per call.` for a list of 51.
A destination the account does not hold is refused before any write: `Refused: folder <id> is not in this account, so nothing can be filed there.`
A move of more messages than `bulkConfirmAbove` (20 by default) asks a confirmation its class does not require; a marking never does, whatever its size.

Confirmation: when the move is large, the question names the count and the destination folder, and says it passes the number this server files without asking; the [write policy](../../explanation/write-policy.md) sets that threshold.

Example prompts:

> Move all the invoices you found into the Accounting folder.

> Mark those three messages as read and clear the flag on them.

### mail_delete

Moves the named messages to the trash folder, where they stay readable and can be moved back out with `mail_organize`.
With `permanent`, it destroys them instead, with no trash to recover them from and no way to undo it.

Class: `draft` by default, `destroy` when `permanent` is `true`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | Message ids from `mail_search` or `mail_read` |
| `permanent` | boolean | no | Destroy outright instead of moving to the trash |

**Refuses or asks.**
The same batch rules as `mail_organize` apply: an empty list and more than 50 ids are refused before any request.
Without `permanent`, an account with no folder carrying the `trash` role is refused, and the refusal offers three ways out: create a trash folder in your mail client, move the messages with `mail_organize`, or call again with `permanent`.
A move to the trash of more messages than `bulkConfirmAbove` (20 by default) asks a confirmation; a permanent deletion is confirmed by its class and never by its volume.

Confirmation: the question counts the messages and names up to five subjects, then says either that they move to the trash where they stay readable, or that they are erased from the mail server with nothing to recover them; the [write policy](../../explanation/write-policy.md) decides when it is asked.

Example prompts:

> Put the messages from that sender in the trash.

> Delete those spam messages for good, not just to the trash.

### mail_folder_manage

Manages the folder tree: creates a folder, renames one, moves one under another parent, or deletes one.
Deleting never takes the messages with it, and folders the mail client relies on can be neither renamed nor deleted.

Class: `draft` for `create`, `rename` and `move`; `destroy` when `action` is `delete`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum: create, rename, move, delete | yes | What to do with the folder |
| `mailboxId` | string | no | The folder to act on, from `mail_folders` |
| `name` | string | no | The folder name |
| `parentId` | string or null | no | Parent folder id, or null for the root |

`mailboxId` is required on every action but `create`; `name` is required on `create` and `rename`; `parentId` is read by `create` and `move` only.

**Refuses or asks.**
A folder the account does not hold is refused before any request, with the consequence spelled out for the action.
A folder carrying a role (inbox, drafts, sent, trash and the like) is refused on `rename` and `delete`: `Rename or delete it from your mail client if you really mean to.`
A `delete` on a folder still holding messages or a sub-folder is refused, and the refusal names the count or the sub-folder.
A `create` or `rename` that would put two folders of the same name under one parent is refused, and a `move` of a folder under itself or under its own descendant is refused as well.
Nothing here asks on volume: one call touches one folder.

Confirmation: a `delete` is confirmed by its class, and the question names the folder, states that it holds no message and no sub-folder, and says the folder itself does not come back; the [write policy](../../explanation/write-policy.md) sets the level.

Example prompts:

> Create a folder called Receipts under Accounting.

> Delete the empty folder named Old projects.

## Sending

Manifest `mail-sending`, requiring `urn:ietf:params:jmap:mail` and `urn:ietf:params:jmap:submission`.
`mail_identities` is a read, but it lives here because an identity is a submission object and a server that does not send has none.

### mail_identities

Lists the addresses this account may send from, with the display name attached to each.
The `id` column is what `mail_compose` and `mail_send` take as `identityId`, and the `primary` column marks the identity matching the login this session was opened with.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| none | | | This tool takes no argument |

**Refuses or asks.**
Nothing refuses and nothing asks.
An account with no identity is reported as one nothing can be sent from, with the advice to add one on the mail server first.

Example prompts:

> Which addresses can I send from?

> Tell me the id of my work identity so you can use it for the next message.

### mail_compose

Writes a message into the drafts folder and returns its id, or sends it right away when `send` is `true`.
The sender is taken from the chosen identity, never from an address given here, and attachments are out of reach.

Class: `draft` by default, `send` when `send` is `true`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `to` | string[] | no | Recipient addresses |
| `cc` | string[] | no | Carbon-copy addresses |
| `bcc` | string[] | no | Blind-copy addresses |
| `subject` | string | no | Derived from the answered message when left off |
| `body` | string | no | The message as plain text |
| `htmlBody` | string | no | The message as HTML, sent exactly as given |
| `identityId` | string | no | Sender identity, from `mail_identities` |
| `replyToEmailId` | string | no | Message this answers, from `mail_search` |
| `send` | boolean | no | Send instead of leaving in drafts |

Either `to` or `replyToEmailId` is required, and so is at least one of `body` and `htmlBody`; `identityId` is required when the account has several identities.
Every address must be a valid email address, and Markdown in `body` is not rendered by mail clients.
The HTML body is sent exactly as given: nothing is stripped, escaped or rewritten, and no plain-text version is derived from it.

**Refuses or asks.**
An address outside the recipient perimeter is refused before any question, and a reply that names nobody has the answered message read to check its sender against the perimeter.
The refusal reads `Refused: <address> is outside the recipient perimeter this server is configured with.` and points at [`recipients`](../configuration.md).
Several identities and none designated: `Refused: this account has <n> sending identities and none was designated.`
An account with no folder carrying the `drafts` role is refused, a send with no folder carrying the `sent` role is refused, and a `replyToEmailId` the account does not hold is refused with `there is nothing to answer`.
A send whose message ends up with no recipient is refused: `Refused: this message has no recipient, so there is nobody to send it to.`

Confirmation: a send names the recipients and the subject, says the message leaves the account as soon as it is confirmed, then states whether the body is plain text or HTML with or without a text part, and for HTML shows an excerpt of the degraded text and the targets of its links; the [write policy](../../explanation/write-policy.md) governs the `send` class.

Example prompts:

> Draft a reply to the message from Marie saying I will be there at ten.

> Send Paul a message titled "Minutes" with the summary you just wrote, from my work address.

### mail_send

Sends a draft that already exists and moves it to the sent folder.
It composes nothing: write the message with `mail_compose` first, then send it by id.

Class: `send`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `emailId` | string | yes | The draft to send, from `mail_compose` |
| `identityId` | string | no | Sender identity, from `mail_identities` |

Without `identityId`, the identity whose address matches the draft's own From header is used; only when none matches is a choice required.

**Refuses or asks.**
A message that is not in the drafts folder is refused rather than sent a second time, and the refusal names the folder it sits in.
A message the account does not hold is refused: `Refused: message <id> is not in this account, so there is nothing to send.`
Accounts with no `drafts` or no `sent` folder are refused, as is an identity that is not one of the account's.
A recipient outside the perimeter is refused before the question, and a draft carrying no recipient is refused with `there is nobody to send it to`.

Confirmation: the question reads `Send "<subject>" from <identity> to <recipients>.`, with the recipients read back from the draft; when the draft cannot be read, it says so instead of naming them.
The [write policy](../../explanation/write-policy.md) governs the `send` class.

Example prompts:

> Send the draft you saved a minute ago.

> Send the draft titled "Minutes", but from my personal address this time.
