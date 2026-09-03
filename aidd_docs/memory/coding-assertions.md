---
title: Assertions de code
status: draft
updated: 2026-09-03
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

## 📄 La vitrine hors contrat

`README.md` et toute page sous `docs/**` sont exemptés du contrat Markdown : c'est la vitrine anglophone publiée sur GitHub et sur npm, pas un document de `aidd_docs/`.
Le contrat y imposerait un contenu français, un bloc de front-matter et des H2 emoji, trois choses qui n'ont pas leur place sur une page de dépôt public.

| Règle | Code | Sur `README.md` et `docs/**` |
| --- | --- | --- |
| Front-matter obligatoire | `FM001` | Ne s'applique pas |
| Emoji devant chaque H2 | `EMO001` | Ne s'applique pas |

Le vérificateur s'y lance donc avec `--ignore=FM001,EMO001`, sur le README comme sur chaque page de `docs/`.
C'est le seul mécanisme disponible : il n'offre aucun profil README, seulement `repo` et `wiki`.
Les erreurs `FM001` et `EMO001` qu'il signale sans ce drapeau sont attendues, jamais une régression à corriger.
Toute autre erreur reste une régression, et les avertissements `TBL002` sur les cellules longues sont tolérés.

Deux vérifications complètent le vérificateur sur `docs/` : chaque `.md` du dossier est lié depuis `docs/README.md`, et chaque lien relatif résout.
La référence des outils tient une troisième : les vingt-neuf `name:` des définitions sous `src/domains/` sont exactement les H3 des six pages de domaine et les lignes de `docs/reference/tools/README.md`, avec les classes du tableau `classes` de chacune.

## 🛠️ Comportement

Si un correctif est nécessaire, lancer un agent par assertion à réparer.
Typage, tests et règles violées sur une même catégorie font trois agents distincts.
