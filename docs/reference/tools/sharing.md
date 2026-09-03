# Sharing tools

Both sharing manifests require the `urn:ietf:params:jmap:principals` capability, which carries the directory and the sharing notifications.
A server that does not advertise it registers neither of the two tools on this page, and the startup line counts both manifests under `domains skipped`.
Each kind of shareable object needs its own capability on top, checked at call time because the tool list is fixed before the session connects: `urn:ietf:params:jmap:mail` for a folder, `urn:ietf:params:jmap:calendars` for a calendar, `urn:ietf:params:jmap:contacts` for an address book, `urn:ietf:params:jmap:filenode` for a file node.
A call naming a kind the server does not serve is refused with the capability it lacks, before any request.

Rights belong to the kind of object, and no right is ever translated into another kind's wording.

| Type | Rights |
| --- | --- |
| `Mailbox` | `mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen`, `maySetKeywords`, `mayCreateChild`, `mayRename`, `maySubmit`, `mayDelete`, `mayShare` |
| `Calendar` | `mayReadFreeBusy`, `mayReadItems`, `mayWriteAll`, `mayWriteOwn`, `mayUpdatePrivate`, `mayRSVP`, `mayShare`, `mayDelete` |
| `AddressBook` | `mayRead`, `mayWrite`, `mayShare`, `mayDelete` |
| `FileNode` | `mayRead`, `mayAddChildren`, `mayRename`, `mayDelete`, `mayModifyContent`, `mayShare` |

Two pairs cannot be told apart on Stalwart: `maySetSeen` and `maySetKeywords` are the same permission on a folder, and `mayWriteAll` covers the permission behind `mayDelete` on a calendar, so revoking `mayDelete` makes `mayWriteAll` read back as not granted, and nothing in the response says so.
A right name the server does not know, written `false`, is dropped without an error, so the vocabulary is checked on this side before anything is sent.

Beneficiaries are principal ids on the wire, and both tools turn them into account addresses through `Principal/get`.
The directory is assumed closed: when the server refuses that lookup, beneficiaries stay raw ids and the answer says why, but the read itself still succeeds.

## Reading

Manifest `sharing`, on the `principals` capability alone.

### sharing_access

Reads who has access to what, in both directions.
With `object`, it lists the accounts this account has shared a folder, calendar, address book or file node with, and exactly which rights each of them holds; with `received`, it lists what other accounts have opened or closed towards this one, most recent first, saying who changed it and which rights moved.
It never changes a share, and an object nobody reaches is reported as such, in words.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum: object, received | yes | `object` reads what this account exposes, `received` what others opened to it |
| `objectType` | enum: Mailbox, Calendar, AddressBook, FileNode | no | On `object`, the kind of object the ids name |
| `ids` | string[] | no | On `object`, the ids to read, 1 to 50 per call |
| `limit` | integer | no | On `received`, notifications to fetch, 25 by default, 100 at most |
| `cursor` | string | no | On `received`, the cursor a previous page returned |

The schema itself refuses an `object` call without `objectType` or without `ids`; `received` takes only `limit` and `cursor`.

**Refuses or asks.**
The ceiling of 50 ids is enforced by the schema, and the tool carries no precheck and no `confirmWhen`: a read never asks a confirmation.
A kind of object the server does not serve is refused before any request: `Refused: This server does not advertise <capability>, so it shares no <noun>. Sharing a <Type> needs that capability.`
An unreadable cursor is refused: `Refused: that cursor is unreadable. List the notifications again from the start.`
A cursor issued by another listing is refused, and so is a cursor overtaken by new notifications: `Refused: new sharing changes arrived since that cursor was issued, so the next page would skip or repeat notifications. List them again from the start.`
An id the account does not hold is named under `Not found in this account:` while the objects that were found are rendered regardless.

Pagination: a page of `received` holds 25 notifications by default, most recent first because the server offers no other order; a truncated page ends with `[more results — cursor: …]`, and the next call resends `received` with that cursor.

On `object`, a folder, calendar, address book or file node on which `mayShare` is not granted to this account is flagged in the listing, since the server would refuse a change to its sharing.
When the server refuses `Principal/get`, the answer opens with the reason: `The server refused Principal/get, so beneficiaries appear as raw ids: this instance has directory queries disabled and does not grant the account permission to read principals.`

Example prompts:

> Who can see my Team calendar, and what exactly are they allowed to do in it?

> Show me the latest changes other people made to what they share with me.

## Writing

Manifest `sharing-writing`, on the `principals` capability alone.

### sharing_manage

Opens or closes another account's access to a folder, calendar, address book or file node, and discards the notifications that report someone else's changes.
It never writes the sharing map whole, so accounts this call does not name keep the access they have, and it acts on ids only, as `sharing_access` returned them.
Opening an access is the one write of this server whose undoing does not restore the prior state: revoking does not recall what has already been read.

Class: `send` when `action` is `grant`, `destroy` when `action` is `revoke` or `dismiss`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum: grant, revoke, dismiss | yes | Open rights, take them back, or discard notifications |
| `objectType` | enum: Mailbox, Calendar, AddressBook, FileNode | no | On `grant` and `revoke`, the kind of object the ids name |
| `ids` | string[] | no | On `grant` and `revoke`, the object ids to change |
| `beneficiary` | string | no | An account address or a principal id; an address is matched whole |
| `rights` | string[] | no | Rights in the vocabulary of `objectType` |
| `notificationIds` | string[] | no | On `dismiss`, the notification ids to discard |

| Action | Required | Optional | Refused |
| --- | --- | --- | --- |
| `grant` | `objectType`, `ids`, `beneficiary`, `rights` | none | `notificationIds` |
| `revoke` | `objectType`, `ids`, `beneficiary` | `rights` | `notificationIds` |
| `dismiss` | `notificationIds` | none | every other key |

A `revoke` without `rights` is not an empty revocation: the beneficiary is removed from the object entirely, every right they hold there going at once.
A grant or a revocation goes out as a patch on `shareWith/<principal>/<right>`, or on `shareWith/<principal>` alone, never as the whole `shareWith` map, so a third party the call does not name keeps their access.

**Refuses or asks.**
The precheck refuses before it asks, in this order: the batch ceiling, the type capability, the rights vocabulary, the beneficiary, then `mayShare` on the objects themselves.
An empty list is refused: `Refused: no shared object id was given, so there is nothing to act on. Run sharing_access first and pass the ids it returns.`
More than 50 ids are refused, on `ids` as on `notificationIds`: `Refused: 51 shared object ids were given, and this server acts on at most 50 per call.`
A kind of object the server does not serve is refused with the capability it lacks, as in `sharing_access`.
A right the type does not know is refused with the rights it does: `Refused: <Type> has no right named <name>. A <Type> knows these: <list>. The server ignores an unknown right written false without an error, so this call stops here.`

An address the server will not look up, an address matching no account, or an address matching several accounts is refused, each time with the way out: pass the principal id as `sharing_access` renders it.
A patch naming a path and its own prefix is refused under RFC 8620 §5.3, which the two forms above cannot produce by construction.
Objects whose sharing could not be read are refused, and so are ids the account does not hold and objects on which `mayShare` is not granted: `Refused: mayShare is not granted to this account on <name> (<id>), so the server would refuse a change to the sharing of it. The account can read who reaches them, and not decide it.`
A `dismiss` goes through the batch ceiling only, since the server opposes no condition to discarding a notification.
The tool carries no `confirmWhen`: every call goes through the confirmation its class requires.

Confirmation: a `grant` reads `Give <account> access to N folder(s): "<name>" (<id>): …`, each right followed by what it allows; a `revoke` reads `Take back from <account> on …: …` with named rights, or `Remove <account> from … entirely: every right they hold there goes at once.` without, and adds `Closing an access does not recall what was read through it: anything they opened while it was granted, they still have.`; a `dismiss` reads `Discard N sharing notification(s). What disappears is the record that another account changed what this one may reach, not the access itself: nothing is opened or closed by this, and the notification cannot be listed again afterwards.`
Touching `maySetSeen` or `maySetKeywords` on a folder, or `mayDelete` on a calendar, adds a note on the linked right, as described at the top of this page; the [write policy](../../explanation/write-policy.md) decides whether each class is allowed, confirmed or denied.

After the write, the answer lists one outcome per id, refusals in the server's own words: `forbidden` is an account that may read a share and not change it, `invalidProperties` a beneficiary the directory does not hold.
Stalwart caps the beneficiaries of one object at 10 by default (`max_shares_per_item`), so a grant on an already shared object may be refused there without anything in the call announcing it; see [limits](../limits.md).

Example prompts:

> Let <camille@example.org> read my Suppliers address book and change its cards.

> Take my colleague off the Projects folder entirely, she does not need it anymore.
