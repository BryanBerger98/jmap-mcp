---
title: CLI
status: draft
updated: 2026-09-03
owner: bryan
---

# CLI

## ⌨️ Surface

`jmap-mcp` n'a ni sous-commande ni verbe.
Le binaire démarre un serveur MCP sur stdio et rend la main au client, jamais à un humain.

## 🔌 Interface

- Entrée et sortie : JSON-RPC sur stdio, réservé au client MCP.
- Configuration : `JMAP_SESSION_URL` et `JMAP_BEARER_TOKEN`, complétées par `~/.config/jmap-mcp/config.json` ; l'environnement l'emporte sur le fichier.
- Le jeton ne transite jamais par un argument de ligne de commande.

## 📦 Distribution

Lancement via `npx`, entrée déclarée par `bin.jmap-mcp` pointant sur `src/index.ts` compilé.
Le serveur tourne sur la machine de l'utilisateur, enregistré auprès de Claude Code, Claude Desktop ou Cursor ; `docs/getting-started/` porte une page par client.
