---
title: PRD — Écrire dans ses carnets d'adresses
status: draft
updated: 2026-09-01
owner: bryan
---

# PRD — Écrire dans ses carnets d'adresses

Cinquième tranche de jmap-mcp : l'assistant crée une fiche de contact, corrige une
coordonnée, range une fiche dans un carnet et supprime ce qui n'a plus lieu d'être.
Elle ferme la branche contacts et livre les deux derniers outils de sa tranche.

## 🔭 Vue d'ensemble

Douze outils sont exposés, dix sur le mail et deux sur les contacts
(`aidd_docs/ROADMAP.md:222`). Les contacts sont prouvablement en lecture seule :
un test de contrat interdit toute méthode hors `get` et `query`
(`aidd_docs/memory/testing.md`, `contacts-read-only.test.ts`).

Le module 5 a rendu les carnets visibles. Il les a laissés intouchables.

L'écart le plus visible se lit dans le message de refus d'un envoi : il conseille
d'ajouter une fiche de contact (`src/config/recipients.ts:73`) alors qu'aucun outil
du serveur ne sait en ajouter une. Le conseil désigne un autre client.

## ❌ Problème

| Manque | Coût aujourd'hui |
| --- | --- |
| Aucune création de fiche | Le conseil de refus est inapplicable ici |
| Aucune correction de fiche | Une adresse morte survit à sa propre obsolescence |
| Aucun rangement | Le carnet reçoit tout, jamais trié |
| Aucune suppression | Le carnet ne fait que grossir |
| Groupes figés | Le module 5 a renvoyé leur édition ici |

Le premier manque est le plus coûteux, parce qu'il est circulaire.
Sous un périmètre restreint, l'utilisateur ne peut écrire qu'aux adresses de ses
carnets, et le serveur ne sait pas alimenter ces carnets. Le périmètre ne peut donc
que rétrécir tant que ce module n'existe pas.

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Créer une fiche | Nom et adresse suffisent, la fiche est relue ensuite |
| Corriger une fiche | Un champ change, les autres sont intacts |
| Ranger une fiche | Son appartenance aux carnets se modifie |
| Éditer un groupe | Un membre entre ou sort |
| Gérer les carnets | Créer, renommer, supprimer un carnet |
| Supprimer une fiche | Confirmé, définitif, jamais en cascade |
| Ne jamais vider un carnet | Le contenu survit à la suppression du contenant |
| Rendre l'élargissement lisible | Écrire une adresse hors périmètre se dit |
| Borner le lot | Le plafond du mail vaut ici |

L'objectif « les autres champs sont intacts » est le plus exigeant.
Une fiche JSContact porte des propriétés que le serveur MCP ne rend pas ; les
réécrire toutes reviendrait à effacer ce qu'il n'a jamais su lire.

## 🚫 Hors périmètre

- Recalculer le périmètre des destinataires après une écriture : il reste résolu au
  démarrage, et l'écriture ne le déplace pas dans la session en cours.
- Élargir le périmètre depuis un outil : la configuration reste la seule entrée.
- Copier une fiche vers un autre compte : le multi-compte reste hors périmètre,
  comme `Email/copy` au module 4.
- Importer un vCard reçu en pièce jointe.
- Les photos de fiche, qui sont des blobs : module 9.
- Partager un carnet avec un tiers : module 11.
- La synchronisation incrémentale et la détection de conflit d'édition.
- Les quatre domaines encore intouchés.

## 👤 User stories

- En tant qu'utilisateur, je veux créer une fiche à partir d'un nom et d'une adresse,
  afin de pouvoir ensuite écrire à cette personne.
- En tant qu'utilisateur, je veux créer une fiche depuis un expéditeur que je viens de
  lire, afin de ne pas recopier une adresse à la main.
- En tant qu'utilisateur, je veux corriger une seule coordonnée, afin de ne pas
  reconstruire une fiche entière pour un numéro qui change.
- En tant qu'utilisateur, je veux que les champs que je n'ai pas nommés restent tels
  quels, afin de ne rien perdre que je n'aie pas vu.
- En tant qu'utilisateur, je veux déplacer une fiche d'un carnet à l'autre, afin de
  séparer le professionnel du personnel.
- En tant qu'utilisateur, je veux ajouter ou retirer un membre d'un groupe, afin
  d'entretenir une liste de diffusion.
- En tant qu'utilisateur, je veux créer, renommer ou supprimer un carnet, afin
  d'organiser mes fiches sans autre client.
- En tant qu'utilisateur, je veux qu'on me demande confirmation avant toute
  suppression, afin de ne jamais perdre une fiche par inadvertance.
- En tant qu'utilisateur, je veux que supprimer un carnet ne supprime jamais les fiches
  qu'il contient, afin qu'un geste de rangement ne soit pas un geste de destruction.
- En tant qu'utilisateur, je veux savoir quand la fiche que je crée porte une adresse
  hors périmètre, afin de comprendre que l'envoi restera refusé jusqu'au redémarrage.
- En tant qu'utilisateur, je veux être averti quand j'écris une fiche pour une adresse
  déjà connue, afin de ne pas dupliquer un contact.
- En tant qu'utilisateur, je veux qu'un gros lot d'écritures me soit confirmé, afin de
  ne pas modifier cent fiches sur une phrase ambiguë.
- En tant qu'utilisateur, je veux qu'un serveur sans contacts n'expose aucun outil
  d'écriture de contacts, afin qu'on ne me propose rien qui échouera.

## ✅ Critères d'acceptation

- Créer une fiche avec un nom et une adresse rend son identifiant, et une lecture
  immédiate la retrouve.
- Modifier un champ laisse tous les autres inchangés, y compris ceux que la lecture
  ne rend pas.
- Une écriture désigne toujours des fiches par identifiant, jamais par un critère de
  recherche.
- Le carnet de destination est explicite ; à défaut, la fiche va dans le carnet par
  défaut, et la réponse le nomme.
- Ajouter ou retirer un membre d'un groupe laisse les autres membres en place.
- Toute suppression de fiche ou de carnet est refusée sans confirmation, et aucune
  requête n'est émise quand la confirmation manque.
- Toute requête de suppression de carnet porte l'ordre de ne pas supprimer son
  contenu, y compris celles qui ne suppriment rien, et un test de contrat le vérifie
  sur toute la surface.
- Une écriture au-delà du seuil de lot demande confirmation sans changer de classe,
  et un lot dépassant le plafond dur est refusé avant toute question.
- Écrire une adresse hors du périmètre des destinataires réussit, et la réponse
  indique que l'envoi restera refusé jusqu'au prochain démarrage.
- Écrire une fiche portant une adresse déjà présente dans un carnet le signale dans
  la réponse, sans bloquer l'écriture.
- Un échec partiel nomme chaque identifiant refusé et sa raison, les autres écritures
  du lot étant appliquées.
- Aucun outil de contacts n'est exposé sur un serveur qui n'annonce pas la capacité
  contacts.
- Le manifeste de lecture des contacts reste prouvablement en lecture seule après
  l'ajout de ce module.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Module 5 | Lecture livrée, les fiches sont désignables |
| Capacité `urn:ietf:params:jmap:contacts` | Annoncée par Stalwart |
| Élicitation côté client | Toute suppression en dépend |
| Claude Desktop | Sans élicitation : suppressions inutilisables par conception |
| Budget d'outils | Deux entrées restent à la tranche contacts |

Ce module conditionne le module 11, qui patchera le `shareWith` porté par
`AddressBook`.

## ❓ Questions ouvertes

**Deux outils, ou trois ?**
La tranche contacts a un budget de quatre outils, deux consommés
(`aidd_docs/ROADMAP.md:218`). La feuille de route range `AddressBook/set` dans
`contacts_write` et `contacts_delete` (`:139`), alors que le mail a isolé la gestion
des dossiers dans `mail_folder_manage`.
Recommandation : trois outils, `contacts_write`, `contacts_delete` et un outil de
carnets, quitte à passer la tranche à quinze. Mélanger une fiche et un carnet dans
un même schéma a été jugé confus au module 4, et rien n'a changé depuis. À arbitrer
contre la cible de vingt-six.

**Créer une fiche est-il un geste de sécurité ?**
Écrire une adresse dans un carnet, c'est s'autoriser à lui écrire au prochain
démarrage. La classe prévue est `draft` (`aidd_docs/ROADMAP.md:138`), donc sans
confirmation.
Recommandation : garder `draft`, et rendre l'élargissement lisible dans la réponse.
Le gel du périmètre au démarrage laisse une session entière à l'utilisateur pour
s'en apercevoir. Une confirmation systématique sur toute création de fiche sous
périmètre restreint est l'alternative, plus lourde.

**L'import d'un vCard revient-il ici ?**
`ContactCard/parse` est une extension Stalwart hors RFC. Le module 5 l'avait mis
hors périmètre.
Recommandation : l'y laisser. Il dépend d'un blob de pièce jointe, donc du module 9.

**Le doublon bloque-t-il ou informe-t-il ?**
Rien dans JMAP n'empêche deux fiches de porter la même adresse.
Recommandation : informer sans bloquer. Un homonyme légitime existe, et un refus
obligerait à sortir de l'assistant pour le contourner.

Un fait reste à constater sans bloquer la construction : Stalwart accepte-t-il une
`ContactCard/set` update en patch partiel sur un chemin JSContact imbriqué, ou
exige-t-il l'objet complet ?
