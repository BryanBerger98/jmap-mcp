---
title: Carte du code
status: draft
updated: 2026-09-01
owner: bryan
---

# Carte du code

> [!NOTE]
> Le mail expose dix outils : `mail_search`, `mail_read`, `mail_folders`, `mail_identities`, `mail_compose`, `mail_send`, `mail_move`, `mail_flag`, `mail_delete`, `mail_folder_manage` ; les contacts en exposent cinq, deux en lecture et trois en écriture : `contacts_search`, `contacts_read`, `contacts_write`, `contacts_delete`, `contacts_book_manage` ; les agendas en exposent trois, tous en lecture : `calendar_search`, `calendar_read`, `calendar_availability`.
> Les trois autres domaines restent des manifestes à `tools: []`.

## 🗺️ Découpe

Le diagramme montre les zones de `src/` et leur dépendance.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
flowchart TD
    A([index.ts]) --> B[server.ts]
    B --> C[registry]
    D[config] --> C
    E[jmap] --> C
    C --> F[domains]
    F --> G[shared]
    F --> E

    classDef neutre fill:#f8fafc,stroke:#94a3b8,color:#334155
    classDef bleu fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a

    class A,B neutre
    class C,D,E,F,G bleu
```

## 📂 Zones

| Zone | Responsabilité |
| --- | --- |
| `src/config/` | Schéma, chargement, politique, périmètre des destinataires |
| `src/jmap/` | Session, client, erreurs, blobs, types |
| `src/registry/` | Définition d'outil, manifeste, composition |
| `src/domains/` | Les six domaines métier |
| `src/shared/` | Pagination, plafond de lot, rendu compact |
| `tests/` | Unitaires, contrat, fixtures |

Les types JMAP vivent sous `src/jmap/types/`, un fichier par spécification.
Chaque domaine sous `src/domains/` regroupe ses outils par verbe métier, jamais par méthode JMAP.
Un domaine peut se scinder en plusieurs manifestes : le mail en a trois, les contacts deux, les agendas deux.

| Manifeste | Capacités | Outils |
| --- | --- | --- |
| `mailDomain` | `mail` | `mail_search`, `mail_read`, `mail_folders` |
| `mailOrganizingDomain` | `mail` | `mail_move`, `mail_flag`, `mail_delete`, `mail_folder_manage` |
| `mailSendingDomain` | `mail`, `submission` | `mail_identities`, `mail_compose`, `mail_send` |
| `contactsDomain` | `contacts` | `contacts_search`, `contacts_read` |
| `contactsWritingDomain` | `contacts` | `contacts_write`, `contacts_delete`, `contacts_book_manage` |
| `calendarDomain` | `calendars` | `calendar_search`, `calendar_read` |
| `calendarAvailabilityDomain` | `calendars`, `principals:availability` | `calendar_availability` |

Sans ce découpage, un serveur qui n'expédie pas ferait taire aussi les outils de lecture.
Le rangement est séparé de la lecture sur la même capacité, pour une autre raison : `mailDomain` reste ainsi prouvablement en lecture seule, et le contrat qui l'affirme vaut mieux qu'un fichier de moins.
`src/domains/mail/organize.ts` porte ce que les quatre outils de rangement partagent : plafond de lot, résolution des dossiers mise en cache, rendu des refus par identifiant.

Les contacts se scindent en deux manifestes sur la même capacité, pour la raison qui vaut déjà pour le mail : la lecture reste prouvablement sans écriture, et un test de contrat le tient.
`src/domains/contacts/card.ts` porte ce que les outils de lecture partagent : nom d'affichage, adresse principale, propriétés et noms de carnets, marque de périmètre et rendu d'une fiche complète.
`src/domains/contacts/edit.ts` en est le pendant en écriture : construction du patch et de la création, résolution des carnets mise en cache, appartenances par uid, rendu des refus par identifiant.

Les agendas se scindent pour une raison qui n'a rien à voir avec l'écriture : `calendar_availability` est la seule à dépendre de `urn:ietf:params:jmap:principals:availability`, et un manifeste unique aurait fait taire la recherche et la lecture sur un serveur qui n'annonce pas cette capacité.
`src/domains/calendar/time.ts` porte tout ce qui touche aux fuseaux et aux bornes : validation d'un nom IANA, normalisation d'une date locale, conversion local vers UTC par `Intl.DateTimeFormat`, `Temporal` étant absent de Node 24.
`src/domains/calendar/event.ts` porte le rendu partagé : légende des agendas, chaîne de repli du fuseau, ligne d'événement, bloc de détail, participants, fusion d'intervalles. Il n'importe aucun client JMAP.

Deux choses vivent hors du domaine parce qu'un second domaine les lit déjà.
`src/shared/pagination.ts` remet les identifiants demandés dans leur ordre, pour le mail, les contacts et les agendas.
`src/shared/batch.ts` porte le plafond dur de cinquante identifiants par appel, que le rangement du mail et l'écriture des contacts partagent : deux plafonds auraient divergé au premier ajustement.

## 🚪 Points d'entrée

- `src/index.ts` : exécutable déclaré par `bin.jmap-mcp`.
- `src/server.ts` : construit le `McpServer` et branche le transport stdio.
