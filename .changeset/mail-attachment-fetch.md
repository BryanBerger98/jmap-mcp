---
"@bryanberger/jmap-mcp": minor
---

`mail_attachment_fetch` downloads one attachment of one message and returns its content in the reply. `mail_read` now lists a message's attachments — name, type, size, blobId — so a call can pick the `blobId` this tool takes.

The attachment's declared size is checked against `files.maxDownloadSize` before any byte moves, the same guard `files_fetch` applies to a node. By default the tool inflates a gzip attachment, unpacks a zip one (every entry, each prefixed by its name, when it holds several), and returns a plain-text, XML or JSON attachment as-is; anything else, or `decode: "raw"`, comes back as base64. Decoded output is cut at `maxBytes` and the cut is announced, the same convention as `mail_read`.
