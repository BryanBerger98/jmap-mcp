# @bryanberger/jmap-mcp

## 0.3.0

### Minor Changes

- 0e62036: `mail_attachment_fetch` downloads one attachment of one message and returns its content in the reply. `mail_read` now lists a message's attachments — name, type, size, blobId — so a call can pick the `blobId` this tool takes.
  
  The attachment's declared size is checked against `files.maxDownloadSize` before any byte moves, the same guard `files_fetch` applies to a node. By default the tool inflates a gzip attachment, unpacks a zip one (every entry, each prefixed by its name, when it holds several), and returns a plain-text, XML or JSON attachment as-is; anything else, or `decode: "raw"`, comes back as base64. Decoded output is cut at `maxBytes` and the cut is announced, the same convention as `mail_read`.

## 0.2.2

### Patch Changes

- f2cfda0: Guarantee every text a tool call returns is well-formed Unicode, so a lone surrogate — from a truncated emoji or from server text in a refusal, confirmation, or error message — can no longer make a strict MCP client drop the response and hang until its own timeout.

## 0.2.1

### Patch Changes

- dec042d: Report the published package version to the MCP client instead of a literal that had drifted one release behind.

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
