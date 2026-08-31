---
status: pending
---

# Instruction: Documentation et mémoire projet

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── README.md                                  ✏️ dix outils, seuil de volume, plafond de lot
└── aidd_docs
    ├── ROADMAP.md                             ✏️ module 4 livré, budget à dix, outil renommé
    └── memory
        ├── architecture.md                    ✏️ second chemin vers la confirmation
        ├── codebase-map.md                    ✏️ troisième manifeste mail, dix outils
        └── testing.md                         ✏️ trois contrats de plus, compte de tests
```

## User Journey

Le diagramme suit ce qu'une personne découvrant le dépôt doit pouvoir apprendre sans lire le code.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
flowchart LR
    A([Lecteur]) --> B[README]
    B --> C{Que fait le serveur ?}
    C --> D[Dix outils, quatre classes]
    C --> E[Seuil de volume réglable]
    A --> F[ROADMAP]
    F --> G[Module 4 livré, budget à jour]
    A --> H[Mémoire projet]
    H --> I[Architecture, carte du code, tests]

    classDef neutre fill:#f8fafc,stroke:#94a3b8,color:#334155
    classDef bleu fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a

    class A,C neutre
    class B,D,E,F,G,H,I bleu
```

## Test Scope

```mermaid
---
title: Test scope
---
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
journey
  section Setup
    Relever le compte réel de tests et de fichiers rendu par pnpm test: 5: cli
  section Happy path
    Relire le README => les dix outils y figurent avec leur classe: 5: system
    Relire codebase-map => le troisième manifeste mail y est décrit: 5: system
    Relire testing => les trois nouveaux contrats et leur invariant y sont nommés: 5: system
  section Edge case - compte de tests périmé
    Chiffre du fichier différent de la sortie de pnpm test => correction du chiffre: 1: cli
  section Edge case - feuille de route contredite
    ROADMAP citant mailbox_manage => renommage en mail_folder_manage: 1: system
  section Teardown
    Exécuter les quatre portes câblées => typage, lint, tests et build au vert: 5: cli
```

## Tasks to do

### `1)` Mettre le README à jour

> Le README est le seul document qu'un utilisateur lit avant d'installer.

1. Décrire les quatre outils de rangement, avec la classe d'opération de chacun.
2. Dire que `mail_delete` met à la corbeille par défaut, et ne détruit que sur `permanent`.
3. Documenter `bulkConfirmAbove` et son équivalent `JMAP_BULK_CONFIRM_ABOVE`, défaut à vingt.
4. Dire que le plafond de cinquante identifiants par appel n'est pas réglable.
5. Dire que le marquage ne demande jamais de confirmation, quel que soit le volume.

### `2)` Refléter le module livré dans la feuille de route

> La feuille de route porte encore un nom d'outil que la tranche a changé.

1. Marquer le module 4 comme livré, à la façon du module 3.
2. Y renommer `mailbox_manage` en `mail_folder_manage`, et dire pourquoi en une ligne.
3. Corriger la table du budget : dix outils exposés sur vingt-six.
4. Noter l'écart assumé : `Email/copy` n'est pas utilisé, le multi-compte restant hors périmètre.
5. Vérifier qu'aucune autre ligne de la feuille de route ne cite l'ancien nom.

### `3)` Rafraîchir la mémoire projet

> Une mémoire qui décrit un état révolu coûte plus qu'elle ne rend.

1. Dans `architecture.md`, décrire le second chemin vers la confirmation, ouvert par l'outil.
2. Y dire que l'escalade suit `precheck` et jamais l'inverse, et pourquoi.
3. Dans `codebase-map.md`, décrire le troisième manifeste `mail` et son unique capacité.
4. Y porter le compte d'outils à dix, et lister les quatre nouveaux.
5. Dans `testing.md`, ajouter les contrats de rangement à la table des invariants.
6. Y corriger le compte de tests et de fichiers, relevé sur la sortie réelle de `pnpm test`.

### `4)` Passer les portes câblées

> Le module n'est fini que lorsque les quatre commandes sont vertes.

1. Lancer `nvm use` depuis la racine avant toute commande.
2. Exécuter `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
3. Corriger chaque assertion tombée avant de passer à la suivante.
4. Vérifier `pnpm why zod` : une seule copie du paquet, comme le veut la règle de versionnage.
5. Relever le compte final de tests et le reporter dans `testing.md`.

## Test acceptance criteria

| Task | Acceptance criteria                                                                   |
| ---- | --------------------------------------------------------------------------------------- |
| 1    | Le README liste les dix outils et documente le seuil ainsi que le plafond de lot          |
| 2    | Aucune occurrence de `mailbox_manage` ne subsiste dans le dépôt                           |
| 3    | Les trois fichiers de mémoire décrivent la surface réelle, sans compte périmé             |
| 4    | Les quatre portes câblées passent au vert, et `pnpm why zod` ne rend qu'une copie          |
