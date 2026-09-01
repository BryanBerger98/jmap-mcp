---
objective: "L'assistant cherche un événement, en lit le détail et dit quand le compte est occupé, sans jamais écrire dans un agenda ni promettre une disponibilité que le serveur refuse de calculer."
status: implemented
---

# Plan — Module 7, lecture des agendas

## 🎯 Contexte

**Pourquoi maintenant**
Quinze outils sont exposés, dix sur le mail et cinq sur les contacts. La branche agendas est un
manifeste vide : `src/domains/calendar/index.ts:8` déclare `tools: []`, `src/jmap/types/calendars.ts`
n'exporte rien.

**Le manque**
Le compte est lisible pour ce qu'il a reçu, jamais pour ce qu'il a prévu. Un mail propose mardi 14 h,
et l'assistant n'a aucun moyen de savoir ce que mardi 14 h contient déjà.

**Le résultat visé**
Trois outils en lecture seule, gatés sur capacité, tenus par un test de contrat qui parcourt le
manifeste. Source : `aidd_docs/tasks/2026_09/2026_09_01-calendar-reading-prd.md`.

## 🔍 Ce que le code de Stalwart impose

Cinq constats tirés du code, chacun changeant une décision du PRD.

| Constat | Preuve | Conséquence |
| --- | --- | --- |
| `getAvailability` refusé par défaut | `crates/jmap/src/principal/availability.rs:65`, `crates/http/src/auth/permissions.rs:90` | Un repli est nécessaire, ou l'outil ne répond jamais |
| `expandRecurrences` exige `after` **et** `before` | `crates/jmap/src/calendar_event/query.rs:263` | Sans fenêtre, pas de dépliage : deux modes assumés |
| `currentUserPrincipalId` = identifiant de compte | `crates/jmap/src/api/session.rs:41` et `:54` | La disponibilité de soi n'a besoin d'aucune découverte |
| `eventProperties` limité à `id` et `baseEventId` | `availability.rs:83` | Les plages ne peuvent pas fuiter de contenu |
| Tri `created`/`updated` refusé hors dépliage | `calendar_event/query.rs:227` | `start` ascendant est le seul ordre stable des deux côtés |

**🔒 Le verrou de la disponibilité**
Quand `allowDirectoryQueries` est faux, la permission `JmapPrincipalGetAvailability` est retirée de
tout jeton, et la méthode refuse ensuite en `forbidden`. Les deux sites concordent, pour soi comme
pour un tiers.

**⚡ La conséquence**
La capacité `urn:ietf:params:jmap:principals:availability` est pourtant annoncée sans condition
(`crates/jmap-proto/src/request/capability.rs:355`) : le gating par capacité ne protège de rien ici,
seul un repli tient la promesse.

## ⚖️ Décisions

Trois arbitrages du PRD, tranchés faute de réponse à la question posée. Chacun est réversible avant
la phase qui le porte.

| Décision | Retenu | Pourquoi |
| --- | --- | --- |
| Surface | 3 outils | 15 + 3 = 18, le module 8 en prend 3, le cumul de 21 de la tranche est tenu |
| Liste des agendas | En-tête de la recherche | Le module 5 a fait ce choix pour les carnets, aucun argument nouveau |
| Nommage | Préfixe `calendar_` | Les quinze outils livrés portent tous leur domaine en préfixe |
| Disponibilité | Serveur puis repli | Le seul chemin qui répond sur une instance non reconfigurée |
| Tiers | Hors périmètre | Son identifiant de principal passe par `Principal/query`, qui rend zéro par défaut |
| Fuseau implicite | Agenda par défaut | Recommandation du PRD, toujours nommé dans la réponse |

Le tiers n'est ni refusé ni marqué : il est absent du schéma d'entrée. Exposer un argument qu'aucune
lecture ne peut renseigner serait promettre une capacité que le serveur retient.

## 🗂️ Projection

```txt
src/
├── jmap/types/
│   ├── calendars.ts        ✏️ Calendar, CalendarEvent, filtres, arguments, BusyPeriod
│   └── core.ts             ✏️ + CAPABILITY_PRINCIPALS_AVAILABILITY
├── jmap/session.ts         ✏️ + accessor principalId
├── domains/calendar/
│   ├── index.ts            ✏️ deux manifestes, trois outils
│   ├── event.ts            ✅ rendu partagé, sans client JMAP
│   ├── time.ts             ✅ fuseaux, bornes locales, conversion UTC
│   ├── search.ts           ✅ calendar_search
│   ├── read.ts             ✅ calendar_read
│   └── availability.ts     ✅ calendar_availability
└── domains/index.ts        ✏️ + calendarAvailabilityDomain

tests/
├── contract/calendar-read-only.test.ts   ✅ le contrat du manifeste
├── unit/calendar-time.test.ts            ✅
├── unit/calendar-event.test.ts           ✅
├── unit/calendar-search.test.ts          ✅
├── unit/calendar-read.test.ts            ✅
├── unit/calendar-availability.test.ts    ✅
└── fixtures/                             ✅ 5 fichiers + session.json ✏️
```

## 🧩 Ce qui est réutilisé

Rien de ce qui suit n'est réécrit : le module s'y branche.

| Existant | Usage |
| --- | --- |
| `src/shared/pagination.ts` | `encodeCursor`, `fingerprint`, `takeWithinBudget`, `inRequestedOrder` |
| `src/shared/render.ts` | `renderTable`, `renderFields`, `truncate` |
| `src/registry/define-tool.ts` | `defineTool`, classe `read`, aucun `precheck` |
| `src/registry/manifest.ts` | `defineDomain`, gating par capacité |
| `tests/fixtures/client.ts` | `fakeTransport`, `fixtureSession` |
| `src/domains/contacts/card.ts` | Le patron du fichier de rendu partagé, à imiter |

## 📐 Phase 1 — Types et rendu

**Objectif** : tout ce qui ne parle pas au réseau, testable sans transport.

1. `src/jmap/types/calendars.ts` : `Calendar` (`id`, `name`, `description`, `color`, `timeZone`,
   `isDefault`, `isVisible`, `isSubscribed`, `includeInAvailability`), `CalendarEvent` (JSCalendar
   RFC 8984 : `title`, `description`, `start`, `duration`, `timeZone`, `showWithoutTime`, `status`,
   `freeBusyStatus`, `privacy`, `locations`, `virtualLocations`, `participants`, `recurrenceRules`,
   `recurrenceId`, `uid`, plus `calendarIds`, `baseEventId`, `utcStart`, `utcEnd`),
   `CalendarEventFilterCondition`, arguments de `query` et `get`, `BusyPeriod`.
   Commentaire de tête obligatoire : `recurrenceOverrides` ne se demande jamais avec
   `utcStart`/`utcEnd`, et le draft `-28` bouge.
2. `src/jmap/types/core.ts` : ajouter `CAPABILITY_PRINCIPALS_AVAILABILITY`.
3. `src/jmap/session.ts` : accessor `principalId`, lu dans
   `accountCapabilities["urn:ietf:params:jmap:principals"].currentUserPrincipalId`, replié sur
   `accountId`.
4. `src/domains/calendar/time.ts` : validation d'un nom IANA par `Intl.DateTimeFormat`,
   normalisation d'une borne (`2026-09-03` → `2026-09-03T00:00:00`, borne haute à `T23:59:59`),
   conversion local → UTC par `formatToParts`, sans dépendance ni `Temporal`, absent de Node 24.
5. `src/domains/calendar/event.ts` : légende des agendas, `resolveTimeZone`, ligne d'événement,
   bloc de détail, rendu des participants et de leur `participationStatus`, fusion d'intervalles.
   Aucun import de client JMAP dans ce fichier.
6. Fixtures : `calendar-get.json`, `calendar-event-query.json`, `calendar-event-rows.json`,
   `calendar-event-detail.json`, `principal-availability.json`. `session.json` gagne les capacités
   agendas, principals et availability, plus `currentUserPrincipalId` sur le compte.

**Critères**

| Tâche | Comportement observable |
| --- | --- |
| 4 | Un fuseau invalide est rejeté ; une conversion tenant un changement d'heure est exacte |
| 5 | Un événement sans titre, sans lieu ou sans participant rend un bloc lisible, jamais une ligne vide |
| 5 | Deux plages qui se recouvrent fusionnent en une |
| 6 | `pnpm test` reste vert : aucune assertion existante ne lit `session.json` sur ses capacités |

## 📐 Phase 2 — `calendar_search`

**Objectif** : chercher des événements, avec ou sans fenêtre, et lire les agendas en en-tête.

1. Schéma : `after`, `before` (dates locales), `timeZone`, `text`, `title`, `description`,
   `location`, `attendee`, `owner`, `uid`, `calendarId`, `limit`, `cursor`. Tout optionnel, pour
   que la dérivation d'arguments minimaux du contrat continue de fonctionner.
2. Deux allers-retours, et la raison est écrite en commentaire : le `timeZone` de
   `CalendarEvent/query` dépend du `Calendar/get` qui le précède, et un argument ne se renseigne pas
   par back-reference.
   - Appel 1 : `Calendar/get`, `ids: null`.
   - Appel 2 : `CalendarEvent/query` puis `CalendarEvent/get` par back-reference `#ids`.
3. `expandRecurrences: true` seulement quand les deux bornes sont fournies ; sinon `false`, et
   l'en-tête dit que les récurrences ne sont pas dépliées.
4. Tri `[{ property: "start", isAscending: true }]`, le seul accepté des deux côtés.
5. Pagination : `position`, `limit`, `calculateTotal`, empreinte portant le filtre, le fuseau et le
   drapeau de dépliage.
6. En-tête : nombre de résultats, fuseau retenu et son origine, légende des agendas avec
   identifiant, fuseau et drapeau par défaut.
7. `src/domains/calendar/index.ts` : `calendarDomain` requiert `[calendars]`, expose l'outil.
8. `tests/contract/calendar-read-only.test.ts` : écrit dès maintenant, parcourant le manifeste, donc
   il tient les outils des phases 3 et 4 le jour où ils atterrissent. Liste blanche de méthodes par
   nom entier, pas par suffixe : `Principal/getAvailability` ne finit pas par `/get`.

**Critères**

| Tâche | Comportement observable |
| --- | --- |
| 2 | Une recherche émet exactement deux requêtes HTTP, la seconde portant deux appels |
| 3 | Sans fenêtre, aucun `expandRecurrences: true` ne part sur le fil |
| 5 | Une page tronquée rend un curseur ; la dernière page n'en rend aucun |
| 6 | La réponse nomme le fuseau, y compris quand l'appel n'en donnait pas |
| 8 | Le contrat tombe au rouge si un outil du manifeste émet autre chose que les quatre méthodes |

## 📐 Phase 3 — `calendar_read`

**Objectif** : lire jusqu'à vingt événements par identifiant, occurrences comprises.

1. Schéma : `ids` (1 à 20), `timeZone` optionnel.
2. `CalendarEvent/get` avec les propriétés de détail et l'argument `timeZone` ; `Calendar/get` dans
   le même aller-retour, sans back-reference, pour nommer les agendas.
3. Jamais `recurrenceOverrides` dans `properties` : la règle du draft interdit de le demander avec
   `utcStart`/`utcEnd`, et le dépliage rend la question sans objet.
4. Un identifiant synthétique se lit comme un autre : le serveur résout les surcharges et rend
   `recurrenceRule` à `null`. Un événement porteur d'une règle affiche une mention, jamais la règle.
5. Rendu : horaires avec fuseau, durée, lieu, description, participants avec statut de réponse,
   agendas, identifiant.

**Critères**

| Tâche | Comportement observable |
| --- | --- |
| 2 | Un seul aller-retour, deux appels dedans |
| 4 | Un événement récurrent lu par sa base porte une mention de récurrence |
| 5 | Un participant sans nom est rendu par son adresse, jamais par une ligne vide |
| 5 | Un identifiant inconnu est nommé dans la réponse, pas silencieusement absent |

## 📐 Phase 4 — `calendar_availability`

**Objectif** : dire quand le compte est occupé, sur une instance par défaut comme sur une instance
ouverte.

1. Schéma : `after`, `before` obligatoires, `timeZone` optionnel. Les bornes sont converties en
   `UTCDateTime` par `time.ts`.
2. Refus avant requête quand la fenêtre dépasse `maxAvailabilityDuration`, lu sur la capacité et
   replié sur 365 jours.
3. Chemin serveur : `Principal/getAvailability` avec `id` = `session.principalId`,
   `showDetails: false`, `eventProperties: null`. Aucune autre propriété n'est acceptée par
   Stalwart.
4. Repli sur `JmapMethodError` de type `forbidden` uniquement : `Calendar/get` puis
   `CalendarEvent/query` déplié sur la fenêtre, en écartant les agendas `includeInAvailability`
   à `none`, les événements `freeBusyStatus: "free"` et les événements annulés, puis fusion des
   intervalles.
5. La réponse nomme toujours le chemin qui a répondu, et le repli dit ce qu'il ignore : les agendas
   partagés, et la nuance `attending` traitée comme `all` faute de pouvoir juger l'assistance sans
   lire les participants.
6. `calendarAvailabilityDomain` requiert `[calendars, principals:availability]`, sur le patron de
   `mailSendingDomain`. `src/domains/index.ts` l'enregistre.

**Critères**

| Tâche | Comportement observable |
| --- | --- |
| 2 | Une fenêtre de deux ans est refusée sans qu'aucune méthode ne parte |
| 3 | Aucune réponse ne contient de titre, de participant ni de description d'événement |
| 4 | Un `forbidden` déclenche le repli ; une erreur de transport ne le déclenche pas |
| 5 | La réponse dit lequel des deux chemins a répondu |
| 6 | Sans la capacité availability, le rapport de composition nomme celle qui manque |

## ✅ Vérification

Node 24 requis : `nvm use` avant toute commande, sinon pnpm 11 s'interrompt sur `node:sqlite`.

| Étape | Commande | Attendu |
| --- | --- | --- |
| Typage | `pnpm typecheck` | Aucune erreur |
| Lint | `pnpm lint` | Aucune violation |
| Tests | `pnpm test` | 445 tests existants toujours verts, plus les nouveaux |
| Mutation | Retirer la liste blanche du contrat | Le contrat passe au rouge |

**Bout en bout, sur instance réelle**
Enregistrer le serveur auprès du client MCP, puis trois appels : une recherche sur une journée, une
lecture d'un identifiant qu'elle a rendu, une demande de disponibilité sur la même fenêtre.

Trois faits se constatent alors, aucun ne bloquant la construction : la révision installée face au
draft `-28`, le comportement exact du dépliage sur une récurrence recoupant la fenêtre, et lequel
des deux chemins de disponibilité répond.

## ⚠️ Risques

| Risque | Parade |
| --- | --- |
| Le repli de disponibilité double la surface à tester | Phase isolée, retirable sans toucher aux trois autres |
| `max_ical_instances` fait échouer un dépliage large | L'erreur est rendue telle quelle, avec la fenêtre à réduire |
| Le draft `-28` bouge | Un seul fichier de types, comme pour Filenode |
| Le fuseau d'un agenda peut être nul | Chaîne de repli explicite jusqu'à `Etc/UTC`, toujours nommée |
| `session.json` est partagé par tous les tests | Ajout de capacités seulement, aucune suppression |
