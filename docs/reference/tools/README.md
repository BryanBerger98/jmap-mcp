# Tools

Twenty-nine tools, in six domains.
Each row names the operation classes a tool can reach; the page says which argument picks the class on a given call.

## Reading the classes

A class is a property of one call, not of a tool.
`mail_compose` is a `draft` when it saves and a `send` when it sends; `mail_delete` is a `draft` when it moves to the trash and a `destroy` when it removes for good.
The [write policy](../../explanation/write-policy.md) says what each class may do without asking.

## Every tool

| Tool | Classes | Page |
| --- | --- | --- |
| `mail_search` | `read` | [mail](./mail.md) |
| `mail_read` | `read` | [mail](./mail.md) |
| `mail_folders` | `read` | [mail](./mail.md) |
| `mail_identities` | `read` | [mail](./mail.md) |
| `mail_compose` | `draft`, `send` | [mail](./mail.md) |
| `mail_send` | `send` | [mail](./mail.md) |
| `mail_organize` | `draft` | [mail](./mail.md) |
| `mail_delete` | `draft`, `destroy` | [mail](./mail.md) |
| `mail_folder_manage` | `draft`, `destroy` | [mail](./mail.md) |
| `contacts_search` | `read` | [contacts](./contacts.md) |
| `contacts_read` | `read` | [contacts](./contacts.md) |
| `contacts_write` | `draft` | [contacts](./contacts.md) |
| `contacts_delete` | `destroy` | [contacts](./contacts.md) |
| `contacts_book_manage` | `draft`, `destroy` | [contacts](./contacts.md) |
| `calendar_search` | `read` | [calendar](./calendar.md) |
| `calendar_read` | `read` | [calendar](./calendar.md) |
| `calendar_availability` | `read` | [calendar](./calendar.md) |
| `calendar_write` | `draft`, `send` | [calendar](./calendar.md) |
| `calendar_respond` | `draft`, `send` | [calendar](./calendar.md) |
| `calendar_delete` | `destroy` | [calendar](./calendar.md) |
| `files_browse` | `read` | [files](./files.md) |
| `files_fetch` | `read` | [files](./files.md) |
| `files_write` | `draft` | [files](./files.md) |
| `files_delete` | `destroy` | [files](./files.md) |
| `sieve_scripts` | `read` | [sieve](./sieve.md) |
| `sieve_write` | `draft`, `destroy` | [sieve](./sieve.md) |
| `vacation_manage` | `draft`, `send` | [sieve](./sieve.md) |
| `sharing_access` | `read` | [sharing](./sharing.md) |
| `sharing_manage` | `send`, `destroy` | [sharing](./sharing.md) |

## Why a domain may be missing

Tools are grouped in fifteen manifests, and a manifest registers its tools only when the JMAP session advertises every capability it requires.
A server without the submission capability keeps the mail reading tools and loses the three sending ones; the startup line counts such a manifest under `domains skipped`.

| Manifest | Capabilities | Tools |
| --- | --- | --- |
| `mail` | `mail` | `mail_search`, `mail_read`, `mail_folders` |
| `mail-organizing` | `mail` | `mail_organize`, `mail_delete`, `mail_folder_manage` |
| `mail-sending` | `mail`, `submission` | `mail_identities`, `mail_compose`, `mail_send` |
| `contacts` | `contacts` | `contacts_search`, `contacts_read` |
| `contacts-writing` | `contacts` | `contacts_write`, `contacts_delete`, `contacts_book_manage` |
| `calendar` | `calendars` | `calendar_search`, `calendar_read` |
| `calendar-availability` | `calendars`, `principals:availability` | `calendar_availability` |
| `calendar-writing` | `calendars` | `calendar_write`, `calendar_respond`, `calendar_delete` |
| `files` | `filenode` | `files_browse`, `files_fetch` |
| `files-writing` | `filenode` | `files_write`, `files_delete` |
| `sieve` | `sieve` | `sieve_scripts` |
| `sieve-writing` | `sieve` | `sieve_write` |
| `sieve-vacation` | `vacationresponse` | `vacation_manage` |
| `sharing` | `principals` | `sharing_access` |
| `sharing-writing` | `principals` | `sharing_manage` |

Each capability is the `urn:ietf:params:jmap:` URI of that name.
Reading and writing are split on the same capability on purpose: the reading manifest of each domain is provably free of any write, and a test holds that.
