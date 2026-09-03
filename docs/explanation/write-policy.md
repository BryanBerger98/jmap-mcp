# The write policy

Every call is classified before it runs, and the configured policy decides what that class may do: run, ask, or refuse.
This page explains what a call goes through, what the question looks like, and why a class never says how much a call does.

## Four classes, three levels

A class is a property of one call, not of a tool.
The same tool reads on one set of arguments and destroys on another, so each tool classifies from its arguments at call time (`classify` in `src/registry/define-tool.ts`).

| Class | What the call does | Default level |
| --- | --- | --- |
| `read` | Reads, and changes nothing | `allow` |
| `draft` | Creates or changes something the mailbox can undo | `allow` |
| `send` | Makes something leave the account: a message, an invitation, a share | `confirm` |
| `destroy` | Removes something with no trash to recover it from | `confirm` |

The defaults live in `src/config/policy.ts`: reversible work runs, irreversible work asks.
Each class takes one of `allow`, `confirm` or `deny`, set under `policy` in the [configuration file](../reference/configuration.md).

A tool whose every class is denied is not registered at all, so the client never sees it.
A tool with one class left is registered, and only its denied branch is refused when called.

## What a call goes through

```txt
classify → policy level
  deny    → refused: "Refused: <tool> is a <class> operation and the policy denies that class."
  allow   → precheck → confirmWhen → run
  confirm → precheck → elicitation → run
```

The four steps happen in one place, `src/registry/compose.ts`, before the tool's own code runs.

| Step | Who decides | What it refuses |
| --- | --- | --- |
| `precheck` | The tool | A call that would fail whatever the answer: out of perimeter, too many ids, an id the server does not know |
| `confirmWhen` | The tool | Nothing; it turns an `allow` into a question when this call deserves one |
| elicitation | The client | A client that cannot ask, or a user who answers no |
| `run` | The tool | Whatever the server refuses on the wire |

`precheck` comes first so that a doomed call is never put to you as a question: asking someone to confirm a send the perimeter will refuse anyway teaches them that confirmations are noise.
`confirmWhen` is only consulted at `allow`: at `confirm` the question is asked anyway, at `deny` there is nothing to ask.

## The question

A confirmation is one message with two parts: the tool's own summary of the effect, then the reason it is asked.

```txt
<summarize>

This is a <class> operation. Proceed?
```

The summary names what the arguments merely point at: a message id says nothing, so `mail_send` reads the draft and names its subject and recipients.
When a `confirmWhen` hook raised the question, its sentence replaces `This is a <class> operation.`, because "this is a draft operation" explains nothing about volume.
The reference of each tool says what its summary contains, in [Tools](../reference/tools/README.md).

The question travels through the MCP elicitation capability, which the client declares at connection.
Without it, the server refuses instead of running silently:

```txt
Refused: <tool> is a <class> operation, which this server only runs after you confirm it. Your MCP client did not declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused.
```

Claude Code and Cursor declare it; Claude Desktop does not, and [Use with Claude Desktop](../getting-started/claude-desktop.md) shows what to deny there.
A declined question emits nothing to the server.

## A draft that asks anyway

The class says what the call does, never how many objects it does it to.
Moving two hundred messages is still a `draft`, and calling it a `destroy` to force the question would misinform you at the very moment you arbitrate.

So a tool may raise a question its class does not require, through `confirmWhen`, and the reason is shown in place of the class.
Two cases exist today:

| Call | Why it asks |
| --- | --- |
| A move, a trash, a card or event edit, an answer, a file organize, on more objects than `bulkConfirmAbove` | Past twenty objects, "archive those" stops naming a set you have in mind |
| `sieve_write` storing a new text into the script currently active | The next incoming message is filtered by the new text as soon as the call lands |

`bulkConfirmAbove` defaults to 20 and is a configuration key.
It weighs volume and nothing else: an irreversible call is confirmed by its class whatever its size, and a hard ceiling of 50 ids per call refuses before any question, see [Limits](../reference/limits.md).

## The recipient perimeter

With `recipients.scope` set to `contacts`, the server may only write to addresses held in the account's address books, or listed under `recipients.allow`.
The perimeter is resolved once, at startup, by reading every contact card, and it never changes during the session: a card created with `contacts_write` counts on the next start.

It fails closed.
No contacts capability, a failed read, or more than 5000 cards make it unreadable, and an unreadable perimeter refuses every send, including an address the allow list names.

The check runs in `precheck`, before any question, and again in `run` on the addresses actually written.
Under a restricted scope, `contacts_search` and `contacts_read` mark each address they show as inside or outside, so the assistant can see the rule before it hits it.

## What the client is told at initialization

The server sends a short text with the initialization response (`src/registry/instructions.ts`), so the assistant knows whose mailbox this is before spending a tool call:

- the account, `You are connected to one JMAP mailbox: the personal account "…", opened as …`;
- the domains the server advertises, `Mail, Sending, Contacts, …`;
- what the exposed tools can do, derived from the classes the policy left reachable, from `Every exposed tool reads. None writes, sends, moves or deletes` to `Exposed tools can read, create and change drafts, send messages and move or delete data`;
- the perimeter, only when one restricts something;
- that every id one tool returns is meant to be passed to another.

## Two classes read off the action, not the name

The registry classifies a call once, and a tool whose side effect belongs to another class has to read the policy itself.

`calendar_delete` is always a `destroy`, and with `notify` it also has the server mail a cancellation to the participants.
Under `policy.send: deny` it refuses that call before any question, with `Refused: this call would have the server mail a cancellation to the participants, and policy.send is set to deny in the configuration.`, and offers to delete without notifying.

`vacation_manage` is a `draft` or a `send`, and switching the automatic reply on makes the vacation script the active one, which stops whatever Sieve script was filtering incoming mail.
Under `policy.destroy: deny` it refuses `isEnabled: true`, and offers to change the wording or the window without touching what filters.
