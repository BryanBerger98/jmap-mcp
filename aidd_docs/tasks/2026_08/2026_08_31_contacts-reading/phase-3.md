---
status: pending
---

# Instruction: `contacts_read`

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── src
│   └── domains
│       └── contacts
│           ├── read.ts                       ✅ lecture par identifiant, détail complet
│           └── index.ts                      ✏️ le manifeste expose son second outil
└── tests
    └── unit
        └── contacts-read.test.ts             ✅ détail, identifiant inconnu, groupe, périmètre
```

## User Journey

Le diagramme suit une lecture, de l'identifiant au bloc de détail.
La lecture prend des identifiants, jamais un critère : les identifiants viennent de `contacts_search`.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
flowchart TD
    A([🆔 Identifiants de fiches]) --> B[[📡 ContactCard/get + AddressBook/get]]
    B --> C[🔁 Ordre de l'appelant restauré]
    C --> D[📝 Bloc par fiche]
    B --> E{🕳️ notFound ?}
    E -->|oui| F[⚠️ Identifiants nommés]
    E -->|non| D
    D --> G([📄 Détail rendu])
    F --> G

    classDef violet fill:#f5f3ff,stroke:#8b5cf6,color:#4c1d95
    classDef bleu fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a
    classDef ambre fill:#fffbeb,stroke:#f59e0b,color:#78350f

    class A,G violet
    class B,C,D bleu
    class E,F ambre
```

## Test Scope

```mermaid
---
title: Test scope
---
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
journey
  section Setup
    Monter un transport factice servant ContactCard/get et AddressBook/get: 5: system
  section Happy path
    Lire une fiche => nom, adresses, téléphones, organisation, note et carnets rendus: 5: api
    Lire plusieurs fiches => les blocs sortent dans l'ordre demandé, séparés: 5: api
  section Edge case - identifiant inconnu
    Identifiant absent du compte => lecture => l'identifiant est nommé introuvable, jamais une réponse vide: 1: api
  section Edge case - tous les identifiants inconnus
    Aucun identifiant trouvé => lecture => une absence explicite, aucun bloc vide rendu: 1: api
  section Edge case - fiche de groupe
    Fiche de kind group => lecture => membres rendus en uid, aucune fiche membre lue: 1: api
  section Edge case - trop d'identifiants
    Plus d'identifiants que le plafond => lecture => refus du schéma nommant le plafond: 1: api
  section Edge case - périmètre restreint
    Scope restricted => lecture => chaque adresse porte son appartenance et la date de gel du périmètre: 1: api
  section Teardown
    Vérifier qu'une seule requête JMAP a été émise par appel: 5: system
```

## Tasks to do

### `1)` Poser l'outil de lecture

> Lire prend des identifiants vus dans une recherche : un outil qui refiltre lui-même rend autre chose que ce qui a été vu.

1. Créer `src/domains/contacts/read.ts` sur le patron de `src/domains/mail/read.ts`.
2. Déclarer `ids`, tableau non vide, borné par un plafond exporté ; une fiche pèse bien moins qu'un corps de message.
3. Écrire dans la description que l'outil ne prend aucun critère et renvoie vers `contacts_search`.
4. Classer l'outil : `classes: ["read"]`, `classify` rendant `read` quels que soient les arguments.
5. Écrire `summarize` rendant le nombre de fiches lues, comme `mail_read`.

### `2)` Lire et rendre le détail

> Un carnet répond en un aller-retour : les noms de carnets voyagent avec les fiches.

1. Émettre `ContactCard/get` et `AddressBook/get` dans une seule requête, sans back-référence, les deux appels étant indépendants.
2. Demander explicitement les propriétés du détail : `id`, `kind`, `uid`, `name`, `nicknames`, `organizations`, `titles`, `emails`, `phones`, `onlineServices`, `addresses`, `notes`, `members`, `addressBookIds`, `created`, `updated`.
3. Restaurer l'ordre des identifiants demandés, `ContactCard/get` ne promettant aucun ordre.
4. Rendre chaque fiche par `renderCard` de `card.ts`, séparées par le même séparateur que `mail_read`.
5. Rendre la liste des `notFound` en la nommant, à la suite des blocs.
6. Rendre une absence explicite quand aucun identifiant n'a été trouvé, jamais une chaîne vide.

### `3)` Exposer et couvrir

> Le second outil ferme le module : la surface est complète à la fin de cette phase.

1. Dans `src/domains/contacts/index.ts`, ajouter `contactsRead` à `tools`, après `contactsSearch`.
2. Vérifier que les deux noms portent le préfixe `contacts_`, ce que la phase 4 asserte.
3. Écrire `tests/unit/contacts-read.test.ts` couvrant les sept cas du Test Scope.
4. Réutiliser `tests/fixtures/contact-cards-detail.json` et `tests/fixtures/address-book-get.json` de la phase 1.
5. Asserter sur les propriétés demandées dans la requête émise, pas seulement sur le texte rendu.

## Test acceptance criteria

| Task | Acceptance criteria                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 1    | Un tableau d'identifiants dépassant le plafond est refusé par le schéma, en nommant le plafond                |
| 2    | Une fiche connue rend ses six familles de champs, et un identifiant inconnu est nommé dans la même réponse    |
| 3    | `pnpm test` passe, et une lecture de trois fiches coûte exactement un aller-retour                            |
