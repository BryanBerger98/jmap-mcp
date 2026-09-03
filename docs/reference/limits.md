# Limits

Every ceiling the server applies, with the file that sets it and what happens past it.
None of them is a configuration key, except the two marked so.

## Ceilings in this server

| Limit | Value | Set in | Past it |
| --- | --- | --- | --- |
| Ids per write call | 50 | `src/shared/batch.ts` | Refused before any request, with the batch size to use |
| Bulk confirmation threshold | 20, configurable as `bulkConfirmAbove` | `src/config/schema.ts` | A question, on reversible bulk calls |
| Results per search page | 1 to 100, default 25 | `src/shared/pagination.ts` and each search tool | The schema refuses a larger `limit` |
| Rendered size of one search page | 3000 to 4000 characters | Each search tool | The page is cut and a cursor returned |
| Messages per `mail_read` | 5 | `src/domains/mail/read.ts` | The schema refuses more ids |
| Body bytes per message | 8000, `maxBodyBytes` from 200 to 8000 per call | `src/domains/mail/read.ts` | The body is cut and says so |
| Cards per `contacts_read` | 20 | `src/domains/contacts/read.ts` | The schema refuses more ids |
| Events per `calendar_read` | 20 | `src/domains/calendar/read.ts` | The schema refuses more ids |
| Download size | 100 MB, configurable as `files.maxDownloadSize` | `src/config/schema.ts` | Refused before any byte moves |
| Cards read for the recipient perimeter | 5000 | `src/server.ts` | The perimeter is unreadable and refuses every send |
| Availability window | 365 days, unless the server states less | `src/domains/calendar/availability.ts` | Refused before any request |
| Vacation subject | 512 characters | `src/domains/sieve/vacation.ts` | The schema refuses the call |
| Vacation body, text or HTML | 2048 characters | `src/domains/sieve/vacation.ts` | The schema refuses the call |
| Sieve script text shown | 12000 characters | `src/domains/sieve/script.ts` | The text is cut and says how many bytes are not shown |
| File name | 255 bytes | `src/domains/files/name.ts` | Refused before any request |

Two of them deserve a word.

The ceiling of 50 ids protects the server, which accepts 500 objects per `/set` and would answer a batch that size with one wall of text; it is also how wrong one mistaken call can go.
The refusal reads `Refused: 51 message ids were given, and this server acts on at most 50 per call.` and asks for batches of 50 or fewer, one call each.

The threshold of 20 protects you: past it, "archive those" stops naming a set you have in mind.
It only applies to reversible calls, and only turns them into a question; [The write policy](../explanation/write-policy.md) lists which calls.

Search pages are bounded twice, by count and by rendered size, because the client's context is the scarce resource.
A cut page ends with `[more results — cursor: …]`, and the cursor is passed back to the same tool with the same criteria; a cursor given to different criteria is refused as stale.

The availability window reads `maxAvailabilityDuration` from the server's capability when it states one, and falls back to one year.
The refusal names both the ceiling and the span asked for, in days.

## Limits the server sets

Stalwart applies its own limits, which no argument shows and which a call only meets as an error.

| Limit | Value | Where | What you see |
| --- | --- | --- | --- |
| Beneficiaries per shared object | 10 by default, `max_shares_per_item` | `crates/jmap/src/api/acl.rs` | A grant on an already shared object fails without warning in the call |
| Sort order of contact cards | `created` or `updated` only | Stalwart returns `UnsupportedSort` on `name` | `contacts_search` paginates by creation date |
| Objects per `/set` | 500 | Core capability `maxObjectsInSet` | Never reached: 50 per call here |
| Upload size | `maxSizeUpload` of the core capability | HTTP upload point | `files_write` refuses before uploading a larger file |

The upload ceiling is the only one the session publishes.
Nothing states a download ceiling, which is why the server owns one.
