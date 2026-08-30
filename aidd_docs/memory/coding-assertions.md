---
title: Assertions de code
status: draft
updated: 2026-08-29
owner: bryan
---

# Assertions de code

## 🔒 Portes câblées

Les quatre commandes sont exécutables et passent au vert.
Node 24 est requis : `nvm use` depuis la racine avant toute commande, sinon pnpm 11 s'interrompt sur `node:sqlite` absent.

| Rôle | Commande | Outil |
| --- | --- | --- |
| Typage | `pnpm typecheck` | TypeScript 7, compilateur natif Go |
| Lint et format | `pnpm lint`, `pnpm format` | Biome 2.5 |
| Tests | `pnpm test` | Vitest 4 |
| Build | `pnpm build` | `tsconfig.build.json` vers `dist/` |

Deux `tsconfig` : `tsconfig.json` couvre `src`, `tests` et `vitest.config.ts` en `noEmit`, `tsconfig.build.json` n'émet que `src`.
Sans ce découpage, l'éditeur signale `vitest/config` introuvable dans les tests.

## 🛠️ Comportement

Si un correctif est nécessaire, lancer un agent par assertion à réparer.
Typage, tests et règles violées sur une même catégorie font trois agents distincts.
