---
title: PRD — Consulter ses carnets d'adresses
status: draft
updated: 2026-08-31
owner: bryan
---

# PRD — Consulter ses carnets d'adresses

Quatrième tranche de jmap-mcp : l'assistant retrouve une fiche de contact, lit ses coordonnées et liste les carnets du compte.
Elle ouvre la branche contacts, la première à sortir du mail depuis le bootstrap.

## 🔭 Vue d'ensemble

Dix outils sont exposés à ce jour, tous sur le mail (`aidd_docs/ROADMAP.md:215`).
Le domaine contacts existe déjà, mais comme manifeste sans outil (`src/domains/contacts/index.ts:8`).

La capacité qu'il exige est pourtant lue à chaque démarrage : le serveur parcourt les carnets pour calculer le périmètre des destinataires (`src/server.ts:103`).
Les fiches sont donc lues, puis jetées. Seul un compte survit, dans la phrase d'initialisation (`src/config/recipients.ts:141`).

L'assistant sait écrire à Camille sans jamais pouvoir dire quelle est l'adresse de Camille.

## ❌ Problème

| Manque | Coût aujourd'hui |
| --- | --- |
| Aucune recherche de fiche | L'adresse se devine dans l'historique |
| Aucune lecture de fiche | Téléphone, organisation, note restent invisibles |
| Périmètre opaque | Règle nommée, contenu invisible |

Le troisième manque est le plus coûteux.
Quand une adresse est refusée, le message conseille d'ajouter une fiche de contact (`src/config/recipients.ts:73`), sans offrir aucun moyen de voir ce que les carnets contiennent déjà.
L'utilisateur ouvre alors un autre client pour répondre à une question que le serveur vient de lui poser.

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Retrouver une fiche | Un nom partiel la rend |
| Lire une fiche | Adresses, téléphones, organisation, note |
| Lister les carnets | Chacun nommé, le défaut signalé |
| Rendre le périmètre observable | Une adresse se vérifie sans sortir |
| Alimenter la rédaction | Une adresse trouvée, jamais recopiée |
| Rester prouvablement en lecture | Aucune écriture sur la surface |
| Nommer les écarts du serveur | Tri et filtre impossibles annoncés |
| Borner le volume rendu | Mille fiches ne saturent rien |

Le dernier objectif est le seul qui coûte : un carnet se consulte en entier bien plus souvent qu'une boîte mail.

## 🚫 Hors périmètre

- Créer, modifier ou supprimer une fiche ou un carnet : module 6.
- Élargir le périmètre des destinataires depuis un outil : la configuration reste la seule entrée.
- Recalculer le périmètre en cours de session : il est résolu une fois, au démarrage.
- Les carnets partagés par un tiers : module 11.
- Les photos de fiche, qui sont des blobs : module 9.
- L'import d'un vCard reçu en pièce jointe.
- La synchronisation incrémentale des changements.
- Les quatre domaines encore intouchés.

## 👤 User stories

- En tant qu'utilisateur, je veux retrouver une fiche à partir d'un bout de nom, afin d'écrire à quelqu'un sans chercher son adresse ailleurs.
- En tant qu'utilisateur, je veux retrouver une fiche à partir d'une adresse, afin de savoir à qui appartient celle que je viens de croiser.
- En tant qu'utilisateur, je veux retrouver les personnes d'une même organisation, afin de préparer un envoi collectif.
- En tant qu'utilisateur, je veux lire le détail d'une fiche, afin d'obtenir un téléphone ou une note sans ouvrir mon carnet.
- En tant qu'utilisateur, je veux savoir quels carnets existent, afin de comprendre où mes fiches sont rangées.
- En tant qu'utilisateur, je veux vérifier qu'une adresse figure dans mes carnets, afin de comprendre pourquoi un envoi a été refusé.
- En tant qu'utilisateur, je veux qu'on m'annonce l'ordre des fiches rendues, afin de savoir ce qu'une page ne contient pas.
- En tant qu'utilisateur, je veux qu'une recherche sur un prénom seul me dise ce qu'elle a réellement cherché, afin de ne rien conclure d'une absence.
- En tant qu'utilisateur, je veux parcourir un grand carnet page par page, afin qu'une consultation ne noie pas la conversation.
- En tant qu'utilisateur, je veux que consulter mes contacts ne modifie jamais rien, afin de le demander sans y réfléchir.
- En tant qu'utilisateur, je veux qu'un serveur sans contacts n'expose aucun outil de contacts, afin qu'on ne me propose rien qui échouera.

## ✅ Critères d'acceptation

- Une recherche sur un fragment de nom rend les fiches correspondantes, chacune avec son identifiant, son nom affiché et son adresse principale.
- Une recherche sur une adresse exacte dit si une fiche la porte, et laquelle.
- Lire une fiche rend son nom, ses adresses, ses téléphones, son organisation, sa note et les carnets auxquels elle appartient.
- Un identifiant inconnu échoue en le nommant, jamais par une réponse vide.
- La liste des carnets nomme chacun d'eux et signale celui par défaut.
- L'ordre des résultats est annoncé dans la réponse, et ne repose jamais sur le nom : ce tri est refusé par le serveur.
- Une recherche sur un prénom seul annonce qu'elle a interrogé le nom complet, les trois champs de nom partageant un index.
- Une page de résultats tient dans un budget de contexte fixe et rend un curseur pour la suivante, comme la recherche de mails.
- Aucune requête d'écriture n'est émise par ce module, et un test de contrat le vérifie sur toute sa surface.
- Aucun outil de contacts n'est exposé sur un serveur qui n'annonce pas la capacité contacts.
- Une fiche ajoutée depuis un autre client pendant la session est trouvée par la recherche, sans pour autant entrer dans le périmètre des destinataires avant le prochain démarrage.
- Aucune confirmation n'est demandée, quel que soit le volume consulté.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Capacité `urn:ietf:params:jmap:contacts` | Annoncée par Stalwart, déjà exigée |
| Fiches peuplées chez `alfred@bryanberger.dev` | Donnée de validation |
| Aucune élicitation | Tout est de classe `read` |
| Modules 2 à 4 | Aucun lien, la branche est indépendante |

Ce module ne débloque rien du mail, et le mail ne lui apporte rien.
Il conditionne en revanche le module 6, qui écrit dans ce que celui-ci rend enfin visible.

## ❓ Questions ouvertes

**Deux outils ou trois ?**
La feuille de route prévoit `contacts_search` et `contacts_read`, tout en rangeant la lecture des carnets dans le même module (`aidd_docs/ROADMAP.md:120`, `:122`).
Recommandation : deux outils, la liste des carnets tenant dans la recherche. Le budget passe de dix à douze sur vingt-six.

**Les fiches de groupe ?**
JSContact distingue une personne d'un groupe par `kind`.
Recommandation : rendre un groupe tel quel cette tranche. Le déplier en ses membres appartient à l'écriture, qui saura les manipuler.

Un fait reste à constater sans bloquer la construction : les fiches d'Alfred sont-elles assez variées pour exercer la recherche par organisation ?
