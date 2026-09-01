---
title: VCS
status: draft
updated: 2026-09-02
owner: bryan
---

# VCS

## ⚙️ Mise en place

- Dépôt : `github.com/BryanBerger98/jmap-mcp`, public, distant `origin` en SSH.
- Branche principale et branche par défaut : `main`.
- Licence : MIT, fichier `LICENSE` à la racine.
- Outil en ligne de commande : `gh`.

## 🌿 Branches

- Format : `type/description-courte`.
- Types en usage : `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

## 📝 Commits

- Convention : Conventional Commits.
- Format : `type(scope): description`.
- Règles : impératif, minuscule, sujet court.
- Scope utile : le domaine touché (`mail`, `calendar`, `registry`, `config`).

## 🔀 Pull requests

- Base : toujours `main`, aucun préfixe de branche n'en désigne une autre.
- Ouverture prête à relire, jamais en draft : le skill `aidd-vcs` dit l'inverse, cette règle le prime.
- Aucun template dans le dépôt : celui du skill `aidd-vcs` fait foi.
- Label de triage déduit du préfixe, posé seulement s'il existe déjà.

| Préfixe | Label |
| --- | --- |
| `feat` | `enhancement` |
| `fix` | `bug` |
| `docs` | `documentation` |
| `chore`, `refactor`, `test` | aucun |

## 🤖 Stratégie de commit

L'IA commite automatiquement : `after phase`.
