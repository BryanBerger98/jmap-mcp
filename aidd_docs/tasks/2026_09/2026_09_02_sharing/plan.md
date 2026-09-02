---
objective: "L'assistant voit qui a accès à quoi, ouvre et coupe un accès sans jamais toucher un bénéficiaire que l'appel n'a pas nommé, et la surface repasse à vingt-neuf outils par la fusion de deux verbes de rangement."
title: Plan — Partages
status: implemented
updated: 2026-09-02
owner: bryan
---

# Plan — Partages

## 🎯 Overview

| Champ | Valeur |
| --- | --- |
| **But** | Deux outils de partage, et un outil de rangement en moins |
| **Source** | [`2026_09_02-sharing-prd.md`](../2026_09_02-sharing-prd.md) |
| **Surface** | 28 outils aujourd'hui, 29 après, sur 26 visés |
| **Socle** | Modules 4, 6, 8 et 9 livrés : trois des quatre types partageables sont déjà écrits |

C'est le dernier domaine de la roadmap, et le seul où une écriture expose des données à quelqu'un d'autre que le titulaire du compte.
Deux points gouvernent tout le plan : un octroi se patche par chemin et jamais par remplacement de carte, et le module est le premier à écrire sur quatre types qu'il ne possède pas.

## 🧭 Phases

| # | Phase | Fichier |
| --- | --- | --- |
| 1 | Types, vocabulaires de droits et cible partageable | [`phase-1.md`](./phase-1.md) |
| 2 | `sharing_access` — qui a accès, et ce qu'on m'a ouvert | [`phase-2.md`](./phase-2.md) |
| 3 | `sharing_manage` — accorder, révoquer, écarter | [`phase-3.md`](./phase-3.md) |
| 4 | `mail_organize` — fondre deux verbes voisins | [`phase-4.md`](./phase-4.md) |
| 5 | Budget, mémoire projet et vitrine | [`phase-5.md`](./phase-5.md) |

## 📚 Resources

Sept sources lues cette session, chacune ayant tranché un point du plan.
Le dépôt Stalwart est épinglé au commit `e7594d3` du 2026-09-01, branche `main`.

| Source | Point tranché |
| --- | --- |
| [`api/acl.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/api/acl.rs) | Le patch profond dans `shareWith` est accepté, et `null` retire un bénéficiaire |
| [`mailbox.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap-proto/src/object/mailbox.rs), [`calendar.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap-proto/src/object/calendar.rs) | Dix droits sur une boîte, huit sur un agenda |
| [`addressbook.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap-proto/src/object/addressbook.rs), [`file_node.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap-proto/src/object/file_node.rs) | Quatre droits sur un carnet, six sur un nœud |
| [`share_notification/get.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/share_notification/get.rs) | Huit propriétés, `name` inatteignable, `oldRights` jamais nul |
| [`share_notification/set.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/share_notification/set.rs) | `destroy` seul, jamais refusé, sans contrôle d'existence |
| [`principal/get.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/principal/get.rs), [`query.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/principal/query.rs) | Un annuaire fermé rend `forbidden`, jamais une liste vide |
| `npm view jmap-mcp` | Le nom est pris par un tiers, ce dépôt n'a jamais publié : la fusion reste possible |

**🔑 Les quatre vocabulaires, sans dénominateur commun**

Chaque type a le sien, et seuls `mayShare` et `mayDelete` leur sont communs.
Aucun vocabulaire unifié n'est inventé : les droits s'affichent et s'écrivent sous le nom que le serveur parse.

| Type | Droits |
| --- | --- |
| `Mailbox` | `mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen`, `maySetKeywords`, `mayCreateChild`, `mayRename`, `maySubmit`, `mayDelete`, `mayShare` |
| `Calendar` | `mayReadFreeBusy`, `mayReadItems`, `mayWriteAll`, `mayWriteOwn`, `mayUpdatePrivate`, `mayRSVP`, `mayShare`, `mayDelete` |
| `AddressBook` | `mayRead`, `mayWrite`, `mayShare`, `mayDelete` |
| `FileNode` | `mayRead`, `mayAddChildren`, `mayRename`, `mayDelete`, `mayModifyContent`, `mayShare` |

> [!WARNING]
> Chaque droit est un alias vers un ensemble d'ACL internes, et une lecture ne rend `true` que si tous ses ACL sont présents — `api/acl.rs:196`.
> Deux effets de bord en découlent : `maySetSeen` et `maySetKeywords` sont indiscernables sur une boîte, et révoquer `mayDelete` sur un agenda fait retomber `mayWriteAll` à `false` sans que rien ne le signale.

**🕳️ Ce qu'un droit refusé ne dit pas**

Un droit écrit à `false` ou un nom de droit inconnu écrit à `false` est ignoré sans erreur — `jmap-tools/src/json/value.rs:236-242`.
Seul un nom inconnu écrit à `true` fait remonter `invalidProperties`.
Le contrôle de saisie se tient donc côté client, sur la liste close du type, et jamais sur un refus du serveur.

**🚪 L'annuaire fermé rend une erreur, pas un vide**

`allowDirectoryQueries` vaut `false` par défaut, et les trois méthodes qui en dépendent rendent alors une erreur de méthode `forbidden` avec la phrase « The administrator has disabled directory queries. » — `principal/get.rs:34-40` et `query.rs:44-50`.
Un résultat vide n'arrive jamais par ce chemin, ce qui rend le onzième critère du PRD tenable sans deviner.

> [!NOTE]
> La condition est un ET, et le rôle utilisateur par défaut reçoit toute permission dont le nom commence par `jmap` — `common/src/auth/permissions.rs:264-275`.
> Sur une installation par défaut, `allowDirectoryQueries` à `false` ne bloque donc rien, et la mémoire projet dit l'inverse : la phase 5 la corrige.

## ⚖️ Decisions

| Décision | Pourquoi en une ligne |
| --- | --- |
| Deux outils, découpés par classe | La lecture reste prouvablement pure, comme dans les cinq domaines livrés |
| Le patch par chemin, jamais la carte entière | Le remplacement efface ce que la lecture ne montrait pas |
| Un émetteur unique pour les quatre `/set` | Trois contrats tiennent aujourd'hui un émetteur par méthode |
| `objectType` obligatoire en entrée | Un identifiant JMAP ne dit pas de quel type il est |
| Octroi `send`, révocation `destroy` | Ouvrir et couper sont deux gestes, deux confirmations |
| `mayShare` lu avant toute question | Un objet non partageable ne se fait pas confirmer |
| `mail_organize` fond `mail_move` et `mail_flag` | Même classe, même lot d'identifiants, aucune publication à rompre |
| Aucun outil dédié aux principals | Une surface qui rend zéro par configuration coûte une place |

**🧩 Deux outils et pas trois**

`sharing_access` lit, `sharing_manage` écrit.
La ROADMAP prévoyait une découpe par objet — les droits d'un côté, les notifications de l'autre — et cette découpe met une lecture et une destruction sous un même nom, ce que `internal/tool-budget.md:53` interdit explicitement.
La découpe par classe la remplace : elle rend la surface de lecture prouvable par contrat, comme dans les cinq domaines livrés, et laisse le compte inchangé à vingt-neuf.

**✂️ Le patch plutôt que la relecture-réécriture**

La ROADMAP prévoyait de lire la carte, la modifier et la réécrire entière.
Stalwart accepte mieux : `shareWith/{principalId}` remplace les droits d'un bénéficiaire, `shareWith/{principalId}: null` le retire, et `shareWith/{principalId}/{droit}` bascule un droit seul — `api/acl.rs:115-144`.
Le patch est la forme sûre parce qu'il ne dépend d'aucune lecture préalable : entre la lecture et la réécriture d'une carte entière, un partage accordé ailleurs disparaîtrait sans trace.

Un écart avec la RFC 8620 §5.3 joue ici en faveur du patch : Stalwart crée le bénéficiaire absent au lieu d'exiger que le chemin existe — `api/acl.rs:124-128`.
Un octroi et une révocation empruntent donc la même forme, et le second critère d'acceptation du PRD tient par construction plutôt que par vigilance.

**📮 L'émetteur unique**

Le module est le premier à écrire sur un type qu'il ne possède pas, et trois assertions de `tests/contract/no-cascade-destroy.test.ts` nomment aujourd'hui un émetteur unique par méthode — lignes 160, 216 et 273.
Tout `Mailbox/set`, `Calendar/set`, `AddressBook/set` et `FileNode/set` du module part donc d'un seul fichier, `src/domains/sharing/edit.ts`, et par une seule fabrique d'arguments.
Les trois assertions gagnent une entrée chacune plutôt que d'être assouplies, et une quatrième s'y ajoute : une écriture de partage ne porte que `update`, jamais `create` ni `destroy`.

**🗓️ Le contrat des agendas n'a rien à céder**

`calendar-write-guard.test.ts:538-547` interdit tout `Calendar/set`, et l'interdiction est portée par des appels réels aux trois outils de `calendarWritingDomain`.
Un outil vivant dans un manifeste `sharing` n'entre jamais dans cette liste : le contrat reste vrai mot pour mot, sans révision et sans exception à écrire.
La question ouverte du PRD tombe donc d'elle-même, à une condition qui devient une règle du plan — l'outil de partage ne rejoint aucun manifeste d'agenda.

**🔓 Ce que le gating ne protège pas**

`urn:ietf:params:jmap:principals` est annoncée sans condition, et `urn:ietf:params:jmap:mail:share` n'apparaît jamais au niveau session.
Gater sur la première ne prouve donc que la présence des méthodes `ShareNotification/*`, jamais qu'un partage aboutira, et gater sur la seconde ferait taire le module sur tous les serveurs.
Le manifeste garde `principals`, et le refus réel vient du serveur en `forbidden`, remonté tel quel : c'est le même patron fail-open que `calendar_availability`.

Le type visé apporte sa propre condition : écrire un partage de fichier sur un serveur sans `urn:ietf:params:jmap:filenode` échouerait au premier appel.
La composition étant statique, le schéma ne peut pas rétrécir, donc l'outil refuse le type dont la capacité manque en la nommant.

**🔢 Le compte d'outils**

| Moment | Outils |
| --- | --- |
| Aujourd'hui | 28 |
| Après la fusion du rangement | 27 |
| Après les deux outils de partage | 29 |

La cible de vingt-six reste dépassée de trois, sous le seuil de dégradation de trente.
La fusion est possible parce que rien n'a jamais été publié sous ces noms : `npm view jmap-mcp` rend un paquet d'un autre auteur, publié en mai 2025, et ce dépôt n'a ni tag ni version au registre.

**⚠️ Un constat annexe, hors périmètre**

Le nom `jmap-mcp` est déjà pris sur npm par un tiers.
C'est sans effet sur ce plan, mais la première publication devra trancher un nom, et ce n'est pas une décision de ce module.
