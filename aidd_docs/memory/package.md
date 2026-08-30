---
title: Paquet
status: draft
updated: 2026-08-29
owner: bryan
---

# Paquet

## 🚪 Surface publique

Le paquet ne ship qu'un exécutable, aucun point d'import.
`bin.jmap-mcp` est le contrat public : tout ce qui vit sous `src/` reste interne et peut changer sans préavis.

## 👥 Consommateurs

- Installation par `npx`, jamais en dépendance d'un projet tiers.
- Runtime : Node, `type: module`, `engines.node` verrouillé sur la ligne LTS.
- Licence MIT, dépôt public.

## 🔢 Versionnage

- Semver. Une rupture est un changement de la configuration attendue, du nom d'un outil MCP, ou de la sémantique d'une classe d'opération.
- Retirer un outil exposé est une rupture. En ajouter un ne l'est pas.
- Zod doit rester en copie unique : `pnpm why zod` le vérifie, un `pnpm.overrides` le corrige.
