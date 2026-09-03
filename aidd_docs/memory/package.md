---
title: Paquet
status: draft
updated: 2026-09-03
owner: bryan
---

# Paquet

## 🚪 Surface publique

Le paquet est publié sous `@bryanberger/jmap-mcp`, sur le patron de `@bryanberger/mattermost-mcp`.
Le nom nu `jmap-mcp` est hors d'atteinte : il appartient à un tiers sur npm depuis mai 2025, et publier dessous est impossible.

Le paquet ne ship qu'un exécutable, aucun point d'import.
`bin.jmap-mcp` est le contrat public : tout ce qui vit sous `src/` reste interne et peut changer sans préavis.
Le binaire garde son nom court, la portée ne vivant que dans le nom du paquet.

`docs/` reste hors du paquet : `files` ne nomme que `dist/`, et le `README.md` est la seule vitrine que le registre affiche.
Il y renvoie par des liens GitHub, jamais par une copie, et la documentation ne déclenche donc aucun changeset.

## 👥 Consommateurs

- Installation par `npx @bryanberger/jmap-mcp`, jamais en dépendance d'un projet tiers.
- Runtime : Node, `type: module`, `engines.node` verrouillé sur la ligne LTS.
- Licence MIT, dépôt public.

## 🔢 Versionnage

- Semver. Une rupture est un changement de la configuration attendue, du nom d'un outil MCP, ou de la sémantique d'une classe d'opération.
- Retirer un outil exposé est une rupture. En ajouter un ne l'est pas.
- Zod doit rester en copie unique : `pnpm why zod` le vérifie, un `pnpm.overrides` le corrige.

## 🚀 Release

Changesets porte la version et la release, et rien d'autre ne les décide.
Une modification qui touche la surface publique arrive avec son fichier de changeset ; le numéro et le changelog en sont dérivés, jamais écrits à la main dans `package.json`.

| Étape | Commande |
| --- | --- |
| Déclarer l'impact d'un changement | `pnpm changeset` |
| Calculer la version et le changelog | `pnpm version` |
| Compiler puis publier sur npm | `pnpm release` |

`pnpm release` enchaîne `pnpm build` et `changeset publish` dans cet ordre : le paquet ne livre que `dist/`, et publier sans compiler enverrait le répertoire de la version précédente.

Un paquet à portée est privé par défaut aux yeux de npm : la publication réclame `publishConfig.access` à `public`, faute de quoi elle échoue sur un compte sans plan payant.
`.changeset/config.json` porte la même valeur, l'un servant la commande de publication et l'autre le registre.

`changeset init` ne tourne pas ici : il pose ses questions en interactif et s'interrompt sans TTY, sur un avertissement de top-level await non résolu.
Le fichier de configuration est donc écrit à la main, et son `$schema` suit la version de `@changesets/config` réellement installée, jamais celle de la CLI.
