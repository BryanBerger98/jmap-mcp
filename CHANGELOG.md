# @bryanberger/jmap-mcp

## 0.1.0

### Patch Changes

- 5f20290: Fix calendar writes against a real Stalwart, where every event carries a `baseEventId`.
  
  The server fills that property on everything it hands back, a base event pointing at itself, so testing its presence made `calendar_write`, `calendar_respond` and `calendar_delete` refuse every event on the account. The test is now the inequality with `id`.
  
  A windowed `calendar_search` also minted a synthetic instance id for one-off events, which those same tools refuse. Only a line that stands for one date of a series keeps its own id now; every other line carries the id of the event itself.
