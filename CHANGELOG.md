# @bryanberger/jmap-mcp

## 0.2.0

### Minor Changes

- 4deafbe: `mail_compose` takes an optional `htmlBody`, sent exactly as given: nothing is stripped, escaped or rewritten, and no plain-text version is derived from it. Given alongside `body`, the message carries both parts and each client shows the one it reads.
  
  `body` becomes optional as a consequence, so a call giving neither argument is now refused by the input schema rather than writing an empty message. Every call that already gave `body` keeps producing the exact message it produced before.
  
  The confirmation shown before a send names the body format, and for an HTML body it also shows the text a reader would see and the link targets that degradation erases.

## 0.1.0

### Patch Changes

- 5f20290: Fix calendar writes against a real Stalwart, where every event carries a `baseEventId`.
  
  The server fills that property on everything it hands back, a base event pointing at itself, so testing its presence made `calendar_write`, `calendar_respond` and `calendar_delete` refuse every event on the account. The test is now the inequality with `id`.
  
  A windowed `calendar_search` also minted a synthetic instance id for one-off events, which those same tools refuse. Only a line that stands for one date of a series keeps its own id now; every other line carries the id of the event itself.
