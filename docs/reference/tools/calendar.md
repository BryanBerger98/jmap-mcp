# Calendar tools

Six tools in three manifests, all requiring the `urn:ietf:params:jmap:calendars` capability.
The availability manifest also requires `urn:ietf:params:jmap:principals:availability`.
A server that does not advertise a capability drops that manifest's tools, and the startup line counts it under `domains skipped`.
Every hour is a wall-clock time read and shown in one IANA zone, which each answer names; `Temporal` is absent from Node 24, so conversions go through `Intl`.

## Reading

Manifest `calendar`, capability `urn:ietf:params:jmap:calendars`.

### calendar_search

Searches calendar events and returns one line each: when it runs, its title, where, which calendar it sits in, and the id `calendar_read` takes.
The header lists every calendar of the account with its id, so no separate call is needed to discover them.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `after` | string | no | Lower bound, local date or date-time |
| `before` | string | no | Upper bound, same format |
| `timeZone` | string | no | IANA zone for bounds and results |
| `text` | string | no | Substring over every searchable field |
| `title` | string | no | Substring matched against the title |
| `description` | string | no | Substring matched against the description |
| `location` | string | no | Substring matched against the locations |
| `attendee` | string | no | Address of an invited participant |
| `owner` | string | no | Address of the organiser |
| `uid` | string | no | Exact iCalendar uid |
| `calendarId` | string | no | Restrict to one calendar id |
| `limit` | integer | no | Events per page, 25 by default |
| `cursor` | string | no | Cursor from a previous page |

Criteria are ANDed and all are optional.
Recurring events are expanded into occurrences only when both `after` and `before` are given: without a window, a recurring event shows once as its rule-bearing base event, and the answer says so.
Results are always sorted by start, earliest first, the one order the server accepts with and without expansion.
The `timeZone` defaults to the zone of the default calendar, then falls back to `Etc/UTC`, and the answer names which applied.

**Refuses or asks.**
The call refuses before any request when `timeZone` is not an IANA name the server knows, when a bound is not a date it can read, or when `after` falls later than `before`.
A cursor that is unreadable, was issued for other criteria, or whose calendars changed since is refused with a request to search again from the start.
Nothing here asks for a confirmation.

Pages hold 25 events by default, within a rendered-text budget; a truncated page ends with `[more results — cursor: …]`, and the cursor is accepted only with the same criteria.

Example prompts:

> What do I have on my calendar next Tuesday?

> Find every event with Marie in the title in October, in Europe/Paris time.

### calendar_read

Reads up to 20 calendar events by id: hours and duration, place and online link, description, participants with the answer each gave, and the calendars the event sits in.
It takes ids, never a filter: run `calendar_search` first and read the ids it returned.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | Event ids, 20 at most |
| `timeZone` | string | no | IANA zone the hours show in |

An id returned by an expanded search names one occurrence and reads like any other.
The event that carries the rule says that it repeats, and shows only the date of its `until` bound, because that bound is a local time and not an instant.

**Refuses or asks.**
The schema refuses an empty list or more than 20 ids, and the call refuses a `timeZone` the server does not know.
Ids the server does not find are listed under `Not found`, never silently dropped.
Nothing here asks for a confirmation.

Example prompts:

> Show me the details of the team meeting you just found, including who accepted.

> Read these three events and tell me which ones have a video link.

## Availability

Manifest `calendar-availability`, capabilities `urn:ietf:params:jmap:calendars` and `urn:ietf:params:jmap:principals:availability`.

### calendar_availability

Returns the stretches of a time window during which this account is busy, and nothing else: no title, no participant, no description ever appears in the answer.
Use it to judge a proposed slot before agreeing to it.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `after` | string | yes | Window start, local date or date-time |
| `before` | string | yes | End of the window, same format |
| `timeZone` | string | no | IANA zone for bounds and answer |

The tool asks the server through `Principal/getAvailability`.
Only a `forbidden` answer opens the fallback, which reads this account's own calendars over the window; any other error is reported as it came.
The answer says which of the two paths answered, and the fallback states what it cannot see: a calendar shared with you by someone else is not counted, and a calendar set to count only the events you attend is counted in full.
The fallback reads at most 200 events and says so when the window held more.

**Refuses or asks.**
The call refuses before any request when `timeZone` is unknown, when a bound cannot be read, when `after` falls later than `before`, or when the window is wider than the server allows.
The ceiling is the `maxAvailabilityDuration` the server states in its capability, and one year when it states none: "Refused: this server answers availability over at most N day(s), and that window spans M."
Nothing here asks for a confirmation.

Example prompts:

> Am I free on Thursday afternoon between two and five?

> When am I busy during the first week of October?

## Writing

Manifest `calendar-writing`, capability `urn:ietf:params:jmap:calendars`.

A successful write never proves a scheduling mail left.
Every answer of these three tools says so: the server skips scheduling silently when iTIP is off, when the account lacks the scheduling permission, or when the event is entirely in the past.

### calendar_write

Creates a calendar event, or corrects the events whose ids are given.
Only the fields you name are written: the participants, the description and the recurrence of an event you correct are left exactly as they were.

Class: `draft`, or `send` when `notify` is `true`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `eventIds` | string[] | no | Events to correct; omit to create |
| `calendarId` | string | no | Calendar of a new event |
| `title` | string | no | The title |
| `description` | string | no | Free-form description |
| `start` | string | no | Local start, date-time or bare date |
| `duration` | string | no | ISO 8601 duration: `PT1H`, `PT30M`, `P1D` |
| `timeZone` | string | no | IANA zone of the start |
| `allDay` | boolean | no | Whether the event covers whole days |
| `location` | string | no | Where the event takes place |
| `status` | enum: confirmed, tentative, cancelled | no | The status of the event |
| `freeBusyStatus` | enum: free, busy | no | Whether the event blocks availability |
| `participantsAdd` | string[] | no | Email addresses to invite |
| `participantsRemove` | string[] | no | Email addresses to remove |
| `notify` | boolean | no | Mail the participants; false by default |

A new event needs `title`, `start`, and either `duration` or `allDay`; an all-day event without a duration lasts one day.
A new event lands in `calendarId`, or in the calendar the account marks as default.

`participantsAdd` never overwrites a participant already on the event, and `participantsRemove` takes the address itself, never an internal key.
`timeZone` takes an IANA name such as `Europe/Paris`, never an offset such as `+02:00`.
`title`, `description`, `start`, `duration`, `allDay` and `location` describe one event and are refused when several `eventIds` are given; only `status`, `freeBusyStatus` and the participant lists act on a batch.
It never acts on a single occurrence of a recurring event, does not create or rename calendars, and writes only in this account.

**Refuses or asks.**
Before any request, the call refuses more than 50 `eventIds` ("this server acts on at most 50 per call"), an unknown `timeZone`, a `start` or `duration` the server cannot read, a new event missing a required field, `participantsRemove` on a creation, a `calendarId` not in the account, and a creation with no `calendarId` when the account marks no default calendar.
An address in `participantsAdd` outside the recipient perimeter is refused whether or not `notify` is set; with `notify`, the participants already on the events are checked too.
An occurrence id is refused, the message ending with "Pass the base event id to act on the whole series."

It asks a confirmation its class does not require when `eventIds` holds more than `bulkConfirmAbove` events, 20 by default.

Confirmation: the message names the event being created with its start and zone, or the first five events being corrected with their titles and starts, the new start if any, whether a recurring event is reached whole, and who is mailed, by count and address, or that nothing is mailed; see the [write policy](../../explanation/write-policy.md).

Example prompts:

> Create a one-hour meeting called "Budget review" next Monday at 10 in the Work calendar.

> Move the dentist appointment to Friday at 3 pm, without telling anyone.

### calendar_respond

Accepts, declines or tentatively answers invitations this account received.
It writes one thing only: the participation status of this account on the event, plus the comment you give it, and leaves every other participant and property untouched.

Class: `send`, or `draft` when `notify` is `false`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `eventIds` | string[] | yes | Ids of the invitations to answer |
| `status` | enum: accepted, declined, tentative | yes | The answer to record |
| `comment` | string | no | Free-form note sent with the answer |
| `notify` | boolean | no | Mail the organiser; true by default |

The account's own participant entry is matched against the calendar addresses the server holds for it.

**Refuses or asks.**
Before any request, the call refuses an empty list or more than 50 `eventIds`, an occurrence id of a recurring event, and an organiser outside the recipient perimeter, whether or not `notify` is set.
An event where none of the participants is an address of this account is refused ("answering on behalf of somebody else is not something this server does"), and so is one where several are, since which one is answering cannot be read off the event.
It asks a confirmation its class does not require when `eventIds` holds more than `bulkConfirmAbove` invitations, 20 by default.

Confirmation: the message names the first five invitations with their organiser, the status being recorded, and whether the organiser is mailed or the status stays in this account; see the [write policy](../../explanation/write-policy.md).

Example prompts:

> Accept the invitation to Thursday's design review.

> Decline the offsite invitation and tell them I am travelling that week.

### calendar_delete

Deletes the named events from this account.
This is permanent: an event removed here is not filed anywhere, and no later call brings it back.

Class: `destroy`, with or without `notify`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | Ids of the events to delete |
| `notify` | boolean | no | Mail a cancellation; false by default |

A recurring event is deleted whole, every occurrence of the series included; cancelling a single occurrence is not something this server does.

**Refuses or asks.**
The call always asks, since its class is `destroy`.
Before any question, it refuses a call with `notify` under a configuration that denies sends: "Refused: this call would have the server mail a cancellation to the participants, and policy.send is set to deny in the configuration. Call again without notify to delete the events without telling anyone, or lift policy.send first."
It also refuses an empty list or more than 50 `ids`, an occurrence id of a recurring event, and, with `notify`, a participant outside the recipient perimeter.

Confirmation: the message names the first five events with their titles and starts, says that a recurring event disappears whole, says whether a cancellation is mailed and to whom, and ends with "Nothing recovers them afterwards."; see the [write policy](../../explanation/write-policy.md).

Example prompts:

> Delete the two cancelled events you found this morning, without notifying anyone.

> Cancel Friday's lunch and let the guests know.
