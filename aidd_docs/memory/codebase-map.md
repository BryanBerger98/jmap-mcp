---
title: Carte du code
status: draft
updated: 2026-09-02
owner: bryan
---

# Carte du code

> [!NOTE]
> Vingt-cinq outils sont exposés, le mail en portant dix : `mail_search`, `mail_read`, `mail_folders`, `mail_identities`, `mail_compose`, `mail_send`, `mail_move`, `mail_flag`, `mail_delete`, `mail_folder_manage` ; les contacts cinq, deux en lecture et trois en écriture : `contacts_search`, `contacts_read`, `contacts_write`, `contacts_delete`, `contacts_book_manage` ; les agendas six, trois en lecture et trois en écriture : `calendar_search`, `calendar_read`, `calendar_availability`, `calendar_write`, `calendar_respond`, `calendar_delete` ; les fichiers quatre, deux en lecture et deux en écriture : `files_browse`, `files_fetch`, `files_write`, `files_delete`.
> Les deux autres domaines, partages et Sieve, restent des manifestes à `tools: []`.
> Le chiffre se relève sur le rapport de composition, jamais en comptant les fichiers sources ; la place qui reste sous la cible est arbitrée par `internal/tool-budget.md`.

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
Un domaine peut se scinder en plusieurs manifestes : le mail en a trois, les contacts deux, les agendas trois, les fichiers deux.

| Manifeste | Capacités | Outils |
| --- | --- | --- |
| `mailDomain` | `mail` | `mail_search`, `mail_read`, `mail_folders` |
| `mailOrganizingDomain` | `mail` | `mail_move`, `mail_flag`, `mail_delete`, `mail_folder_manage` |
| `mailSendingDomain` | `mail`, `submission` | `mail_identities`, `mail_compose`, `mail_send` |
| `contactsDomain` | `contacts` | `contacts_search`, `contacts_read` |
| `contactsWritingDomain` | `contacts` | `contacts_write`, `contacts_delete`, `contacts_book_manage` |
| `calendarDomain` | `calendars` | `calendar_search`, `calendar_read` |
| `calendarAvailabilityDomain` | `calendars`, `principals:availability` | `calendar_availability` |
| `calendarWritingDomain` | `calendars` | `calendar_write`, `calendar_respond`, `calendar_delete` |
| `filesDomain` | `filenode` | `files_browse`, `files_fetch` |
| `filesWritingDomain` | `filenode` | `files_write`, `files_delete` |

Sans ce découpage, un serveur qui n'expédie pas ferait taire aussi les outils de lecture.
Le rangement est séparé de la lecture sur la même capacité, pour une autre raison : `mailDomain` reste ainsi prouvablement en lecture seule, et le contrat qui l'affirme vaut mieux qu'un fichier de moins.
`src/domains/mail/organize.ts` porte ce que les quatre outils de rangement partagent : plafond de lot, résolution des dossiers mise en cache, rendu des refus par identifiant.

Les contacts se scindent en deux manifestes sur la même capacité, pour la raison qui vaut déjà pour le mail : la lecture reste prouvablement sans écriture, et un test de contrat le tient.
`src/domains/contacts/card.ts` porte ce que les outils de lecture partagent : nom d'affichage, adresse principale, propriétés et noms de carnets, marque de périmètre et rendu d'une fiche complète.
`src/domains/contacts/edit.ts` en est le pendant en écriture : construction du patch et de la création, résolution des carnets mise en cache, appartenances par uid, rendu des refus par identifiant.

Les agendas se scindent pour une raison qui n'a rien à voir avec l'écriture : `calendar_availability` est la seule à dépendre de `urn:ietf:params:jmap:principals:availability`, et un manifeste unique aurait fait taire la recherche et la lecture sur un serveur qui n'annonce pas cette capacité.
`src/domains/calendar/time.ts` porte tout ce qui touche aux fuseaux et aux bornes : validation d'un nom IANA, normalisation d'une date locale, conversion local vers UTC par `Intl.DateTimeFormat`, `Temporal` étant absent de Node 24.
`src/domains/calendar/event.ts` porte le rendu partagé : légende des agendas, chaîne de repli du fuseau, ligne d'événement, bloc de détail, participants, fusion d'intervalles. Il n'importe aucun client JMAP.

L'écriture des agendas forme un troisième manifeste, sur la capacité des lectures, pour la raison qui vaut déjà pour le mail et les contacts : `calendarDomain` reste prouvablement sans écriture.
`src/domains/calendar/edit.ts` porte ce que les trois outils d'écriture partagent : construction du patch et de la création, résolution des agendas et des identités mises en cache, clé du participant que le compte occupe, refus d'une occurrence isolée, rendu des refus par identifiant.
Seules deux de ses fonctions touchent le réseau, tout le reste se teste sans serveur.

Les fichiers se scindent pour la même raison que les trois autres, et le manifeste d'écriture s'appelle `files-writing` et non `files` : le rapport de composition nomme un domaine écarté, et deux entrées portant le même nom ne diraient pas laquelle des deux surfaces s'est tue.
Cinq modules se partagent le domaine, dont un seul touche le disque local.

| Module | Ce qu'il porte |
| --- | --- |
| `node.ts` | Rendu d'un nœud, taille lisible, résolution mise en cache |
| `edit.ts` | Patch, création, arguments de `FileNode/set`, refus traduits |
| `local.ts` | Frontière du disque : racine, résolution, taille, lecture |
| `name.ts` | Contrôle du nom et type MIME déduit de l'extension |
| `delete.ts` | Comptage du sous-arbre, partagé par `precheck` et `summarize` |

Le canal d'octets vit dans `src/jmap/blob.ts` et non dans le domaine, parce qu'il ferme sur le jeton et sur les deux gabarits d'URL du noyau.
Un outil qui atteindrait les blobs lui-même aurait le jeton en main ; ce qui lui parvient est deux méthodes, `upload` et `download`, et rien qu'il puisse divulguer.

Trois choses vivent sous `src/shared/` parce qu'un second domaine les lit déjà.

| Module | Ce qu'il porte | Lu par |
| --- | --- | --- |
| `pagination.ts` | Ordre des identifiants demandés | Mail, contacts, agendas, fichiers |
| `batch.ts` | Plafond de cinquante identifiants par appel | Rangement du mail, trois écritures |
| `render.ts` | Rendu compact, `SetError` en une ligne | Les quatre mêmes domaines |

Quatre plafonds auraient divergé au premier ajustement, et le `SetError` avait déjà quatre copies identiques à l'octet près.
Aucune ne mappait le moindre code : elles concaténaient le type et la description, donc les remonter n'a rien changé à ce qui s'affiche.

## 🚪 Points d'entrée

- `src/index.ts` : exécutable déclaré par `bin.jmap-mcp`.
- `src/server.ts` : construit le `McpServer` et branche le transport stdio.
