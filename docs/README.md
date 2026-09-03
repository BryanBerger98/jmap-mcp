# Documentation

This folder is the user documentation of `@bryanberger/jmap-mcp`.
It lives on GitHub and is not shipped in the npm package: the package carries only `dist/` and its `README.md`, which links here.

## Getting started

| Page | Answers |
| --- | --- |
| [Getting a token from Stalwart](./getting-started/stalwart-token.md) | Which bearer the server accepts over JMAP, how to create it, how to check it |
| [Claude Code](./getting-started/claude-code.md) | One command to register the server, and how to verify it |
| [Claude Desktop](./getting-started/claude-desktop.md) | The configuration file, and why sends and deletions are refused there |
| [Cursor](./getting-started/cursor.md) | The same JSON file, in two possible places |

## Reference

| Page | Answers |
| --- | --- |
| [Configuration](./reference/configuration.md) | Every key of the configuration file, its variable, its default |
| [Tools](./reference/tools/README.md) | The twenty-nine tools, their classes, and why a domain may be missing |
| [Mail tools](./reference/tools/mail.md) | Searching, reading, composing, sending, filing, deleting, folders |
| [Contacts tools](./reference/tools/contacts.md) | Cards and address books |
| [Calendar tools](./reference/tools/calendar.md) | Events, availability, invitations |
| [Files tools](./reference/tools/files.md) | Browsing, fetching, uploading, deleting |
| [Sieve and vacation tools](./reference/tools/sieve.md) | Scripts, activation, the automatic reply |
| [Sharing tools](./reference/tools/sharing.md) | Rights per object type, grants, revocations, notifications |
| [Limits](./reference/limits.md) | Every ceiling the server enforces, and what Stalwart adds |

## Explanation

| Page | Answers |
| --- | --- |
| [Write policy](./explanation/write-policy.md) | What a class is, when a call asks, and what the question contains |

## Troubleshooting

| Page | Answers |
| --- | --- |
| [Troubleshooting](./troubleshooting.md) | What a startup error, a missing tool or a refusal means |
