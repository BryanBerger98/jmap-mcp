# Contacts tools

Both contacts manifests require the `urn:ietf:params:jmap:contacts` capability.
A server that does not advertise it registers none of the five tools on this page, and the startup line counts both manifests under `domains skipped`.
The reading manifest holds two tools and the writing manifest three, split on the same capability so that the reading surface is provably free of any write.

## Reading

Manifest `contacts`, on the `contacts` capability alone.

### contacts_search

Searches contact cards and returns one line per card: name, main address, organization, the address books it sits in, and the id `contacts_read` takes.
Criteria are ANDed and all optional; with none, the whole address book is walked page by page, which is the ordinary way to consult it.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | no | Substring matched against the name of the card |
| `email` | string | no | Substring matched against the addresses of the card |
| `phone` | string | no | Substring matched against the phone numbers |
| `organization` | string | no | Substring matched against the organization |
| `note` | string | no | Substring matched against the notes of the card |
| `text` | string | no | Substring matched across every searchable field |
| `kind` | enum: individual, group, org, location, device, application | no | Restrict to one kind of card |
| `addressBookId` | string | no | Restrict to one address book, as listed in the legend the search returns |
| `limit` | integer | no | Cards to fetch, 25 by default, 100 at most |
| `cursor` | string | no | Cursor from a previous page, resent with the same criteria |

`name` hits a single index shared by the full name, the given name and the surname, so filtering on a first name alone is not something the server can do; the answer carries a note saying so whenever `name` was given.

**Refuses or asks.**
An unreadable cursor is refused: `Refused: that cursor is unreadable. Run the search again from the start.`
A cursor sent with other criteria than the page that issued it is refused before any request, and so is a cursor whose address books changed since it was issued: `Refused: the address books changed since that cursor was issued, so the next page would skip or repeat cards.`
Nothing else refuses, and a read never asks a confirmation.

Pagination: a page holds 25 cards by default, sorted by creation date, oldest first, because Stalwart answers `UnsupportedSort` to a sort by name; a truncated page ends with `[more results — cursor: …]`, and the next call must resend the same criteria with that cursor.

Under a `recipients.scope` other than `anyone`, every row gains an `email perimeter` column marking the shown address as `in perimeter` or `outside perimeter`, with a note when another address of the same card sits on the other side.
The perimeter is fixed at startup, and the answer says so: `[perimeter frozen at startup: a card created since is only inside it after a restart]`.
See [configuration](../configuration.md) for the perimeter and [limits](../limits.md) for the sort constraint.

Example prompts:

> Find the contact cards for everyone at Acme and tell me which address books they are in.

> Walk through my address book and list the mailing groups it holds.

### contacts_read

Reads up to 20 contact cards by id: name, addresses, phones, organization, titles, postal addresses, notes, and the address books the card sits in.
A card of kind `group` is rendered as it stands, its members listed by uid rather than read.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | Card ids returned by `contacts_search`, 1 to 20 per call |

**Refuses or asks.**
The schema refuses an empty list and a list of more than 20 ids before the handler runs; the tool takes ids only, never a filter.
An id the server does not know is reported under `Not found:` rather than refused.
A read never asks a confirmation.

Under a `recipients.scope` other than `anyone`, each address is followed by its mark, `[in perimeter]` or `[outside perimeter]`, and the answer ends with the same frozen-perimeter note as `contacts_search`.

Example prompts:

> Show me the full card of the two people the last search returned.

> Read the group card for the sales team and tell me how many members it lists.

## Writing

Manifest `contacts-writing`, on the `contacts` capability alone.

### contacts_write

Creates a contact card, or corrects the cards whose ids are given.
Only the fields you name are written, everything else on the card is left exactly as it was, and adding an email address or a phone number never overwrites one already there.

Class: `draft`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `cardIds` | string[] | no | Cards to correct; omit to create one |
| `name` | string | no | The full name of the person or group |
| `organization` | string | no | The organization the person belongs to |
| `title` | string | no | The person's job title |
| `nickname` | string | no | A nickname for the person |
| `note` | string | no | A free-form note kept on the card |
| `kind` | enum: individual, group, org, location, device, application | no | What the card describes; only a group holds members |
| `emails` | object | no | Email addresses to add or remove |
| `phones` | object | no | Phone numbers to add or remove |
| `addressBooks` | object | no | Which address books the cards sit in, by id |
| `members` | object | no | Members of a group card, given as card ids |

The four objects take these nested keys, every one of them optional.

| Object | Nested keys | Note |
| --- | --- | --- |
| `emails` | `add`, `remove` (string[]) | `remove` takes the address itself, never an internal key |
| `phones` | `add`, `remove` (string[]) | `remove` takes the number itself, never an internal key |
| `addressBooks` | `set`, `add`, `remove` (string[]) | `set` replaces the whole membership and cannot travel with `add` or `remove` |
| `members` | `add`, `remove` (string[]) | Card ids, resolved to uids by a read |

A correction goes out as a patch on the paths the call names, never as the whole card, so a property the read did not return is never erased.

**Refuses or asks.**
More than 50 ids in `cardIds` are refused, as in every write of this server; see [limits](../limits.md).
A single-card field (`name`, `organization`, `title`, `nickname`, `note`, `kind`, `emails`, `phones`, `members`) given with several `cardIds` is refused, since writing the same value onto every card in a batch is almost never the intent; only `addressBooks` files a batch.
`addressBooks.set` combined with `add` or `remove` is refused: `Refused: addressBooks.set replaces the whole membership while add and remove amend it, and RFC 8620 §5.3 forbids one patch being the prefix of another.`
A creation without a name and without an email address is refused: `Refused: a new card needs at least a name or an email address.`
A creation with `addressBooks.remove`, an unknown address book id, or a creation naming no book on an account with no default book are refused before the request.
A correction that would leave a card in no address book at all is refused, and so is `members` on a card whose kind is not `group`.
Past `bulkConfirmAbove` cards (20 by default), the call asks a confirmation its `draft` class does not require: `This writes to N contact cards at once, past the 20 this server writes without asking.`

Confirmation: when asked, the message reads `Create a contact card for <name>.` on a creation, or `Correct N contact cards (<names>).` on a correction; the mechanism is described in the [write policy](../../explanation/write-policy.md).

After the write, an address already held by another card is reported in a note rather than blocking the write, and under a restricted `recipients.scope` an address written outside the perimeter is reported too, since the perimeter only picks it up after a restart.

Example prompts:

> Create a card for Camille Roy at Acme with her work address and file it in the Suppliers book.

> Add the new phone number to the card of my accountant and drop the old one.

### contacts_delete

Destroys the named contact cards.
This is permanent: contacts have no trash, so nothing holds a destroyed card and no later call brings it back, and a group that counted the card among its members keeps a uid now pointing at no card.

Class: `destroy`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | The card ids to destroy, as returned by `contacts_search` or `contacts_read` |

**Refuses or asks.**
An empty list is refused: `Refused: no contact card id was given, so there is nothing to act on.`
More than 50 ids are refused: `Refused: 51 contact card ids were given, and this server acts on at most 50 per call.`
The tool takes ids only, never a filter, and every call goes through the confirmation its class requires.

Confirmation: the message reads `Permanently destroy N contact cards: <name> <address>, … and N more. Contacts have no trash: nothing recovers them afterwards.`, naming up to five cards and counting the rest; the [write policy](../../explanation/write-policy.md) decides whether the class is allowed, confirmed or denied.

Example prompts:

> Delete the duplicate card for Camille Roy that has no phone number.

> Remove the three test contacts I created yesterday.

### contacts_book_manage

Manages the address books of the account: creates one, renames one, or deletes one.
Deleting a book never deletes the cards it holds, and address books have no hierarchy, so there is nothing to move a book into.

Class: `draft` on `create` and `rename`, `destroy` when `action` is `delete`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum: create, rename, delete | yes | What to do with the address book |
| `bookId` | string | no | The address book to act on; required except on `create` |
| `name` | string | no | The book name; required on `create` and `rename` |

The schema itself refuses a `rename` or `delete` without `bookId`, and a `create` or `rename` without `name`.

**Refuses or asks.**
An unknown `bookId` is refused before the request, with the books the account holds.
A `create` or `rename` taking a name another book already carries is refused: `Refused: an address book named <name> already exists (id <id>). Pick another name.`
A `delete` of the default book is refused: `Refused: <name> is the default address book of this account, so a card created without a book named would have nowhere to land.`
A `delete` of the last remaining book is refused: `Refused: <name> is the only address book of this account, and a contact card belongs to at least one book for as long as it exists.`
A `delete` of a book still holding cards is refused, with the count: `Refused: the address book <name> holds N contact cards, and deleting a book never deletes what is in it.`
Every `AddressBook/set` emitted carries `onDestroyRemoveContents: false`, so the server would refuse a populated book even if the precheck did not.

Confirmation: a `delete` asks with `Delete the address book <name>, which holds no card. No contact card is destroyed by this; the book itself does not come back.`, under the [write policy](../../explanation/write-policy.md); `create` and `rename` ask only if the `draft` class is set to `confirm`, with `Create the address book <name>.` or `Rename the address book <old> to <new>.`

Example prompts:

> Create an address book called Suppliers.

> Delete the empty Test address book.
