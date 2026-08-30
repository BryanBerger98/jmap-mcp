---
title: Assertions de code
status: draft
updated: 2026-08-29
owner: bryan
---

# Assertions de code

> [!WARNING]
> Aucune porte n'est câblée : `package.json` n'existe pas encore, donc aucun script n'est exécutable.
> Ce fichier liste les outils arrêtés, pas des commandes vérifiées.

## 🔒 Outils retenus

| Rôle | Outil |
| --- | --- |
| Typage | TypeScript, compilateur natif Go |
| Lint et format | Biome |
| Tests | Vitest |
| Paquets | pnpm |

## 🛠️ Comportement

Si un correctif est nécessaire, lancer un agent par assertion à réparer.
Typage, tests et règles violées sur une même catégorie font trois agents distincts.
