# Contributing to jmap-mcp

## Setup

See [`aidd_docs/INSTALL.md`](aidd_docs/INSTALL.md).
The user documentation lives under [`docs/`](docs/README.md).

## Workflow

1. Branch off `main`, named `type/short-description` (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`).
2. Implement inside the existing architecture boundaries — the six domain modules never bypass the policy guard (see `INSTALL.md`).
3. Add or extend tests alongside the code. Any tool in the `send` or `destroy` operation class needs a contract test.
4. Run the suite before opening a pull request.

## Documentation

Every page under `docs/` is written in English, without front-matter and without emoji in headings, and passes the Markdown checker with those two rules ignored:

```sh
node ~/.claude/skills/markdown-style/scripts/check-markdown.js docs/<page>.md --ignore=FM001,EMO001
```

A new page is linked from [`docs/README.md`](docs/README.md), and every relative link it carries resolves.

## Conventions

- Commits: conventional commits (`<type>(<scope>): description`), imperative and lowercase. Useful scopes are the touched domain: `mail`, `calendar`, `registry`, `config`.
- Removing an exposed MCP tool is a breaking change; adding one is not.
- Keep the CI pipeline green on every push.
