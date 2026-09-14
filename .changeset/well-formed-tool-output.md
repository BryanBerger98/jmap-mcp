---
"@bryanberger/jmap-mcp": patch
---

Guarantee every text a tool call returns is well-formed Unicode, so a lone surrogate — from a truncated emoji or from server text in a refusal, confirmation, or error message — can no longer make a strict MCP client drop the response and hang until its own timeout.
