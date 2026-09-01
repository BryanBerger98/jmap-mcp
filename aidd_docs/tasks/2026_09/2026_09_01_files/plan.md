---
objective: "L'assistant parcourt, récupère, dépose et supprime dans l'espace de fichiers du compte, aucun octet ne traversant la conversation et aucune destruction ne partant sans que son sous-arbre ait été compté."
title: Plan — Stockage de fichiers
status: in-progress
updated: 2026-09-01
owner: bryan
---

# Plan — Stockage de fichiers

## 🎯 Overview

| Champ | Valeur |
| --- | --- |
| **But** | Quatre outils sur l'espace de fichiers |
| **Source** | [`2026_09_01-files-prd.md`](../2026_09_01-files-prd.md) |
| **Surface** | 21 outils aujourd'hui, 25 après, sur 26 |
| **Socle** | Module 1 seul, aucune branche métier |

Le module ouvre la première branche du projet où l'objet manipulé n'est pas du texte mais des octets, et la première où le serveur MCP touche le disque de la machine.
Deux points gouvernent tout le plan : les octets ne transitent jamais par la conversation, et une requête de recherche n'émet que les conditions que Stalwart honore réellement.

## 🧭 Phases

| # | Phase | Fichier |
| --- | --- | --- |
| 1 | Types, canal d'octets et frontière du disque | [`phase-1.md`](./phase-1.md) |
| 2 | `files_browse` et `files_fetch` — parcourir et récupérer | [`phase-2.md`](./phase-2.md) |
| 3 | `files_write` — déposer, créer, renommer, déplacer | [`phase-3.md`](./phase-3.md) |
| 4 | `files_delete` — détruire, cascade nommée d'avance | [`phase-4.md`](./phase-4.md) |
| 5 | Arbitrage du budget d'outils et mémoire projet | [`phase-5.md`](./phase-5.md) |

## 📚 Resources

Six sources lues cette session, chacune ayant tranché un point du plan.

| Source | Point tranché |
| --- | --- |
| [draft-jmap-filenode-14](https://www.ietf.org/archive/id/draft-ietf-jmap-filenode-14.html) | Objet `FileNode`, quatre valeurs de `onExists` |
| [`file/query.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/file/query.rs) | Treize conditions parsées puis ignorées |
| [`file/set.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/file/set.rs) | Noms interdits, seuil de `nodeHasChildren` |
| [`mailstore/capabilities.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/common/src/config/mailstore/capabilities.rs) | Contenu réel de la capacité annoncée |
| [`storage/dav.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/common/src/storage/dav.rs) | Le filtre `name` couvre fichiers et dossiers |
| [`jmap.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/common/src/config/mailstore/jmap.rs) | `upload_max_size` publié en `maxSizeUpload` |

**🕳️ Le filtre qui ment**

Neuf conditions de `FileNode/query` sont exécutées : `parentId`, `ancestorId`, `descendantId`, `isTopLevel`, `nodeType`, `name`, `nameMatch`, `minSize`, `maxSize`.
Les treize autres — `text`, `body`, `type`, `typeMatch`, `role`, `hasAnyRole`, `blobId`, `isExecutable` et les six bornes de date — tombent dans une branche vide de `query.rs:159-177`, sans erreur ni avertissement.
Une requête qui les nomme rend plus de résultats que demandé, exactement comme le filtre `header` du mail.

**🔀 Le tri qui disparaît**

Un comparateur non supporté n'est pas rejeté en `UnsupportedSort` : il est retiré de la liste à `query.rs:213-226`, et une liste vidée retombe en ordre de document.
Seuls `Name`, `Size` et `NodeType` survivent, ce que la capacité annonce d'ailleurs en `fileNodeQuerySortOptions`.

> [!CAUTION]
> Le plafond de vingt-cinq méga-octets attribué à `FileStorage.maxSize` par la mémoire projet n'apparaît nulle part dans `file/set.rs`.
> Le seul plafond lisible est `maxSizeUpload` du noyau, appliqué au point de téléversement HTTP, et c'est celui que l'outil annoncera.

## ⚖️ Decisions

| Décision | Pourquoi en une ligne |
| --- | --- |
| Manifeste `filesWritingDomain` distinct | La lecture reste prouvablement pure |
| Neuf conditions autorisées, liste close | Les treize autres mentent en silence |
| `onExists` toujours écrit à `null` | Trois de ses valeurs détruisent l'existant |
| `files.localRoot` obligatoire pour les octets | Le disque n'est pas la boîte aux lettres |
| `files_fetch` classé `read` | Il ne mute rien dans le compte |
| Cascade autorisée, jamais par défaut | Un sous-arbre se supprime, après comptage |
| Un seul identifiant par récupération | Un lot de téléchargements n'a pas de refus par identifiant |
| `symlink` absent des types offerts | Le serveur rend un ensemble vide |
| Trois gestes fondus dans `files_write` | Les scinder saturerait le budget |

**🧱 Le manifeste séparé**

Le patron vient des contacts et des agendas : `filesDomain` garde ses deux lectures, `filesWritingDomain` porte les deux écritures.
Un serveur qui refuserait l'écriture ne ferait pas taire le parcours.

**📏 La liste close des conditions**

Le schéma d'entrée de `files_browse` n'expose que les neuf conditions honorées, et un test de contrat vérifie qu'aucune autre ne part sur le fil.
Restreindre le schéma ne suffit pas : la règle porte sur ce qui est émis, comme la liste blanche de méthodes du contrat des agendas.

**🚪 La frontière du disque**

Une clé `files.localRoot` est ajoutée à la configuration, et tout chemin résolu hors de cette racine est refusé avant le transfert, dans les deux sens.
Sans elle, `files_fetch` et l'action de dépôt refusent en nommant la clé manquante ; le parcours, la création de dossier, le rangement et la suppression restent utilisables.
Le PRD laissait la question ouverte ; elle a été tranchée en faveur de la clé obligatoire, contre un répertoire temporaire implicite.
Un chemin de travail que l'utilisateur n'a pas nommé est un chemin qu'il ne surveille pas.

**🌳 La cascade, seule des trois à être offerte**

`onDestroyRemoveEmails` et `onDestroyRemoveContents` sont écrits à faux sans exception, parce qu'aucun besoin ne réclame de vider un dossier ou un carnet en un appel.
`onDestroyRemoveChildren` fait exception : supprimer une arborescence est le geste normal ici, et l'interdire forcerait des lots de cinquante identifiants feuille par feuille.
Le drapeau reste donc toujours écrit, faux par défaut, vrai seulement sur demande explicite, et la question de confirmation annonce le compte du sous-arbre avant d'être posée.

**🧩 Les trois gestes fondus**

`upload`, `create-folder` et `organize` partagent un schéma discriminé, sur le patron de `mail_folder_manage` et de `contacts_book_manage`.
Les scinder porterait la surface à vingt-six outils sur vingt-six, saturant le budget avant les modules Partages et Sieve.
C'est le point du plan le plus susceptible de se scinder à l'implémentation, et le seuil qui déclencherait la scission est la divergence des trois `precheck`, pas la taille du schéma.

**🔇 Le nom des outils**

`files_fetch` plutôt que `files_read` : le mot dit qu'un transfert a lieu et un fichier atterrit sur le disque, là où `files_read` laisserait croire que le contenu revient dans la conversation.
Un nom exposé est un contrat public, et le changer après publication serait une rupture semver.
