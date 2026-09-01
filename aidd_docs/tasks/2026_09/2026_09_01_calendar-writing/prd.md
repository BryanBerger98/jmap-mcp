---
title: PRD — Écriture des agendas
status: draft
updated: 2026-09-01
owner: bryan
---

# PRD — Écriture des agendas

Le module ouvre l'agenda à l'écriture : créer un rendez-vous, le corriger, inviter, répondre à une invitation, annuler.
C'est le premier endroit du projet où un même geste part en brouillon local ou en mail réellement expédié selon un seul argument.

## 🎯 Contexte

Le module 7 a livré la lecture : chercher un événement, le lire, mesurer une disponibilité.
Un assistant sait donc répondre « tu es pris jeudi à 14 h », mais ne peut ni déplacer le créneau ni prévenir les participants ; l'utilisateur retourne à son client d'agenda pour le geste qui compte.

L'écriture est aussi la démonstration du principe qui tient tout le projet : la classe d'opération se lit sur les arguments, jamais sur le nom de la méthode.

## ❌ Problème

| Situation aujourd'hui | Coût |
| --- | --- |
| L'assistant lit l'agenda mais n'y écrit rien | Toute décision se termine par un aller-retour manuel |
| Une invitation reçue reste sans réponse | L'organisateur ne sait pas si le créneau tient |
| Annuler suppose d'ouvrir un autre outil | Les participants sont prévenus tard, ou pas |

Le risque miroir est réel : une écriture d'agenda qui expédie un mail sans que l'utilisateur l'ait voulu prévient des tiers d'une chose qu'il croyait privée.
Aucune fonctionnalité ne vaut ce défaut.

## ✅ Objectifs

| Objectif | Ce qui l'atteste |
| --- | --- |
| Créer et corriger un événement de son propre agenda | Un événement demandé apparaît dans le client d'agenda de l'utilisateur |
| Séparer l'écriture locale de l'expédition d'invitations | Aucun mail ne part sans confirmation explicite nommant les destinataires |
| Répondre à une invitation reçue | Le statut de participation de l'utilisateur change, aucun autre |
| Annuler un événement | La suppression est confirmée, et dit si une annulation part aux participants |
| Préserver ce que l'appel n'a pas nommé | Corriger l'heure ne perd ni les participants, ni la description, ni la récurrence |
| Rester dans le budget d'outils | Trois entrées, vingt et une cumulées sur vingt-six |

## 🚫 Hors périmètre

- La gestion des agendas eux-mêmes : créer, renommer, supprimer un agenda.
- Le partage d'un agenda avec un tiers, qui reste au module 11.
- La modification d'une occurrence isolée d'une série récurrente.
- L'import et l'export iCalendar, et l'analyse d'une pièce jointe de calendrier.
- La copie d'un événement vers un autre compte : le multi-compte reste hors projet, comme au module 4 et au module 6.
- La boîte de notifications d'invitations : les invitations se trouvent par la recherche déjà livrée.
- L'écriture dans l'agenda d'un tiers.

## 👤 Récits utilisateur

- En tant qu'utilisateur, je veux créer un rendez-vous dans mon agenda sans prévenir personne, afin de bloquer un créneau pour moi seul.
- En tant qu'utilisateur, je veux corriger l'heure, le lieu ou le titre d'un événement existant, afin de refléter un changement sans tout ressaisir.
- En tant qu'utilisateur, je veux inviter des participants et que l'invitation parte réellement, afin de ne pas doubler le geste dans un autre outil.
- En tant qu'utilisateur, je veux qu'aucune invitation ne parte sans que je l'aie confirmée, afin de ne jamais prévenir un tiers par accident.
- En tant qu'utilisateur, je veux accepter, refuser ou marquer comme provisoire une invitation reçue, afin que l'organisateur sache où j'en suis.
- En tant qu'utilisateur, je veux annuler un événement et choisir si les participants en sont informés, afin de distinguer un nettoyage d'agenda d'une annulation publique.
- En tant qu'utilisateur, je veux savoir dans quel fuseau horaire l'heure que je donne est comprise, afin qu'un rendez-vous ne se pose pas à la mauvaise heure.

## 📋 Critères d'acceptation

**🔒 Ce qui protège**

| # | Condition |
| --- | --- |
| 1 | Une écriture qui n'expédie aucune invitation ne pose pas de question d'envoi |
| 2 | Une écriture qui expédie des invitations est toujours confirmée, la question nommant les destinataires et leur nombre |
| 3 | Sans élicitation côté client, toute écriture avec envoi et toute suppression refusent au lieu de s'exécuter |
| 4 | Une suppression annonce, avant confirmation, si une annulation part aux participants |
| 5 | Au-delà du seuil de lot, une écriture massive est confirmée sans changer de classe ; au-delà de cinquante identifiants, elle est refusée |
| 6 | Sans la capacité agendas annoncée par le serveur, aucun outil du module n'est exposé |

**✍️ Ce qui doit être juste**

| # | Condition |
| --- | --- |
| 7 | Une correction ne touche que les champs nommés par l'appel ; les autres survivent à l'écriture |
| 8 | Toute heure écrite est comprise dans un fuseau nommé, et la réponse redit lequel |
| 9 | Modifier ou supprimer un événement récurrent dit explicitement que le geste porte sur toute la série |
| 10 | Une réponse à invitation ne change que le statut de l'utilisateur, jamais celui d'un autre participant |
| 11 | Un refus par identifiant est rendu tel quel : l'appel dit ce qui a réussi et ce qui a échoué, jamais un succès global approximatif |

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Module 7 livré | La recherche et la lecture fournissent les identifiants que l'écriture consomme |
| Élicitation MCP | Sans elle, les classes `send` et `destroy` refusent ; Claude Desktop reste exclu par conception |
| Expédition du serveur | Une invitation ne part réellement que si le serveur est configuré pour l'expédier |
| Budget d'outils | Trois entrées prévues par la tranche agendas, sans rattrapage du décalage hérité des contacts |

## ❓ Questions ouvertes

| Question | Recommandation |
| --- | --- |
| La gestion des agendas rejoint-elle ce module, par symétrie avec les carnets d'adresses au module 6 ? | Non : hors périmètre ici, à traiter avec le partage, qui en a besoin de toute façon |
| Une occurrence isolée d'une série peut-elle être modifiée ou annulée ? | Pas dans ce module ; l'écart est dit dans la description de l'outil, la demande est fréquente et reviendra |
| Le périmètre des destinataires, qui borne déjà l'envoi de mail, s'applique-t-il aux participants invités ? | Oui : une invitation est un mail expédié, la même règle doit valoir |
| Les outils gardent-ils les noms de la feuille de route, sans préfixe de domaine ? | Non : le préfixe `calendar_` rassemble le domaine, règle posée au module 4 |
| Une suppression prévient-elle les participants par défaut ? | Non : le silence est le défaut, prévenir est un geste demandé |
