---
"@bryanberger/jmap-mcp": minor
---

`mail_compose` takes an optional `htmlBody`, sent exactly as given: nothing is stripped, escaped or rewritten, and no plain-text version is derived from it. Given alongside `body`, the message carries both parts and each client shows the one it reads.

`body` becomes optional as a consequence, so a call giving neither argument is now refused by the input schema rather than writing an empty message. Every call that already gave `body` keeps producing the exact message it produced before.

The confirmation shown before a send names the body format, and for an HTML body it also shows the text a reader would see and the link targets that degradation erases.
