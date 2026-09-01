---
title: PRD — Lire ses agendas
status: draft
updated: 2026-09-01
owner: bryan
---

# PRD — Lire ses agendas

Sixième tranche de jmap-mcp : l'assistant liste les agendas du compte, cherche des
événements sur une fenêtre de temps, et dit quand quelqu'un est libre.
Elle ouvre la branche agendas, restée entière depuis le module 1.

## 🔭 Vue d'ensemble

Quinze outils sont exposés, dix sur le mail et cinq sur les contacts
(`aidd_docs/ROADMAP.md:232`). La branche agendas n'est qu'un manifeste vide :
`src/domains/calendar/index.ts` déclare `tools: []`, et `src/jmap/types/calendars.ts`
n'exporte rien.

Le compte est aujourd'hui lisible pour ce qu'il a reçu, jamais pour ce qu'il a prévu.
L'assistant lit un mail qui propose mardi 14 h et n'a aucun moyen de savoir ce que
mardi 14 h contient déjà.

C'est la dernière branche de lecture qui manque au parcours quotidien : mail et
contacts sont livrés, le temps ne l'est pas.

## ❌ Problème

| Manque | Coût aujourd'hui |
| --- | --- |
| Aucune liste d'agendas | L'assistant ignore combien de calendriers existent |
| Aucune recherche d'événement | « Qu'ai-je jeudi ? » sort de l'assistant |
| Aucune disponibilité | Répondre à une proposition de créneau se fait à l'aveugle |
| Aucun accès aux participants | Qui vient, qui a décliné, invisible |
| Fuseau non exprimé | Une heure lue sans fuseau est une heure fausse |

Le manque de disponibilité est le plus coûteux, parce qu'il rend le mail incomplet.
Le module 3 sait rédiger une réponse ; il ne sait pas dire si la réponse est
raisonnable. Accepter un rendez-vous reste un geste que l'utilisateur fait ailleurs,
avec un second client ouvert à côté.

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Voir ses agendas | Nom, rôle, fuseau et couleur de chacun |
| Chercher un événement | Par texte, par titre, par lieu, par participant |
| Voir une journée | Une fenêtre de temps rend les événements qu'elle contient |
| Lire un événement | Horaires, lieu, participants, statuts de réponse |
| Nommer le fuseau | Toute heure rendue porte le fuseau qui l'interprète |
| Dire une disponibilité | Une fenêtre rend les plages occupées |
| Borner le volume | Une fenêtre large pagine au lieu de tout tirer |
| Rester prouvablement en lecture | Aucune méthode hors `get`, `query`, `getAvailability` |
| Gater sur la capacité | Serveur sans agendas : aucun outil exposé |

L'objectif du fuseau est le plus exigeant, et le moins visible.
Les bornes de recherche sont des dates locales interprétées dans un fuseau fourni par
l'appel (`aidd_docs/memory/external/stalwart-jmap.md:139`) : un fuseau implicite décale
toute la réponse sans qu'aucune erreur ne le signale.

## 🚫 Hors périmètre

- Créer, modifier ou supprimer un événement : module 8.
- Répondre à une invitation, le RSVP étant une écriture : module 8.
- Les identités de participant, lues pour savoir sous quel nom on répond : module 8.
- Les notifications d'événement, `CalendarEventNotification`, qui sont une file à
  traiter, pas un agenda à lire.
- Importer un `.ics` reçu en pièce jointe : l'extension `calendars:parse` dépend d'un
  blob, donc du module 9.
- Les pièces jointes et alarmes d'un événement.
- Partager un agenda ou lire celui d'un tiers par droit accordé : module 11.
- Découvrir les principals d'un annuaire : `Principal/query` rend zéro tant que
  `allowDirectoryQueries` reste désactivé (`aidd_docs/ROADMAP.md:220`).
- La synchronisation incrémentale et le suivi des changements.
- Le multi-compte, comme aux modules 4 et 6.

## 👤 User stories

- En tant qu'utilisateur, je veux voir la liste de mes agendas, afin de savoir où
  chercher avant de chercher.
- En tant qu'utilisateur, je veux demander ce que contient une journée, afin de
  préparer ma matinée sans ouvrir un autre client.
- En tant qu'utilisateur, je veux chercher un événement par mot-clé, afin de retrouver
  une réunion dont je n'ai que le sujet en tête.
- En tant qu'utilisateur, je veux chercher les événements où une personne est invitée,
  afin de retrouver quand je l'ai vue.
- En tant qu'utilisateur, je veux lire un événement en entier, afin de connaître son
  lieu, ses participants et qui a décliné.
- En tant qu'utilisateur, je veux que chaque heure affichée porte son fuseau, afin de
  ne jamais lire un horaire décalé sans m'en apercevoir.
- En tant qu'utilisateur, je veux restreindre une recherche à un agenda, afin de ne pas
  mêler le professionnel au personnel.
- En tant qu'utilisateur, je veux savoir si je suis libre sur une plage, afin de
  répondre à une proposition de créneau dans le même échange.
- En tant qu'utilisateur, je veux qu'une fenêtre trop large soit paginée plutôt que
  tronquée en silence, afin de savoir qu'il reste des résultats.
- En tant qu'utilisateur, je veux qu'un serveur sans agendas n'expose aucun outil
  d'agenda, afin qu'on ne me propose rien qui échouera.
- En tant qu'utilisateur, je veux que les outils d'agenda ne puissent rien écrire, afin
  de confier ma lecture sans confier mon planning.

## ✅ Critères d'acceptation

- La liste des agendas rend, pour chacun, son identifiant, son nom, son fuseau et s'il
  est celui par défaut.
- Une recherche sur une fenêtre de temps rend les événements qui la recoupent, et la
  réponse nomme explicitement le fuseau dans lequel les bornes ont été lues.
- Une recherche sans fuseau explicite ne devine jamais : elle applique un fuseau
  déterminé et le nomme dans la réponse.
- Une recherche accepte un filtre de texte, de titre, de lieu ou de participant, et
  peut se restreindre à un agenda.
- Lire un événement rend ses horaires, son lieu, sa description, ses participants et
  leur statut de réponse.
- Un événement récurrent est lisible sur la fenêtre demandée sans que l'utilisateur ait
  à interpréter une règle de récurrence.
- Une demande de disponibilité rend les plages occupées sur la fenêtre, sans révéler le
  contenu des événements qui les occupent.
- Un résultat dépassant la page demandée le signale et rend de quoi demander la suite,
  jamais une troncature muette.
- Les outils d'agenda n'émettent aucune méthode JMAP hors `get`, `query` et
  `getAvailability`, et un test de contrat le vérifie sur tout le manifeste.
- Aucun outil d'agenda n'est exposé sur un serveur qui n'annonce pas la capacité
  agendas, et le rapport de composition nomme la capacité manquante.
- La disponibilité reste indisponible plutôt qu'approximée quand la capacité qui la
  porte n'est pas annoncée.
- Les manifestes mail et contacts en lecture restent prouvablement en lecture seule
  après ce module.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Module 1 | Session, client, registre, garde |
| Capacité `urn:ietf:params:jmap:calendars` | Annoncée par Stalwart, draft `-28` |
| Capacité `urn:ietf:params:jmap:principals:availability` | Porte la disponibilité, annoncée séparément |
| Draft en mouvement | Le draft agendas bouge encore, le fichier de types l'isole |
| Budget d'outils | La tranche agendas en prévoyait six pour ses deux modules |

Aucune élicitation n'est requise : la classe `read` est en `allow`, donc ce module reste
utilisable sur un client sans MRTR, Claude Desktop compris.

Ce module conditionne le module 8, qui écrira les événements, et lui seul.

## ❓ Questions ouvertes

**Deux outils, ou trois ?**
La feuille de route en prévoit trois : `calendar_list`, `events_search`,
`availability_check` (`aidd_docs/ROADMAP.md:157`). Le module 5 avait refusé un outil
dédié aux carnets, leur liste tenant dans l'en-tête de `contacts_search`.
Recommandation : deux outils, la liste des agendas devenant l'en-tête de la recherche.
Un agenda porte plus de métadonnées qu'un carnet, mais pas assez pour valoir une entrée
au budget quand quinze sur vingt-six sont déjà consommées. À arbitrer : le contre-
argument est qu'une recherche d'événement force alors une fenêtre de temps pour obtenir
une simple liste d'agendas.

**Quel fuseau quand l'appel n'en donne pas ?**
Trois options : refuser l'appel, appliquer le fuseau de l'agenda par défaut, appliquer
UTC.
Recommandation : le fuseau de l'agenda par défaut, toujours nommé dans la réponse.
Refuser alourdit chaque question de calendrier ; UTC est le choix qui décale
silencieusement les réponses d'un utilisateur européen.

**Une récurrence se déplie-t-elle, ou se lit-elle comme règle ?**
Un rendez-vous hebdomadaire est un objet unique porteur d'une règle, alors que
l'utilisateur demande « jeudi ».
Recommandation : rendre les occurrences de la fenêtre demandée, la règle brute n'ayant
aucun sens pour la personne qui pose la question. Le mécanisme serveur exact reste à
constater avant de fixer le comportement.

**La disponibilité d'un tiers est-elle dans le périmètre ?**
`Principal/getAvailability` est le seul chemin vers la disponibilité
(`aidd_docs/memory/external/stalwart-jmap.md:134`), et il désigne une personne.
Recommandation : appliquer au tiers interrogé la même marque que les contacts, dedans
ou dehors du périmètre, sans refuser. Le périmètre borne à qui le compte écrit, pas ce
qu'il consulte. À trancher si la marque doit devenir un refus sous scope restreint.

**Ce module coûte-t-il une entrée au budget avant l'arbitrage du module 9 ?**
La tranche agendas prévoyait six outils pour ses deux modules, et le décalage d'une
unité pris au module 6 n'est rattrapé nulle part (`aidd_docs/ROADMAP.md:234`).
Recommandation : ne pas rogner ici, l'arbitrage restant fixé au module 9 sur une
surface réelle.

Trois faits restent à constater sur instance vivante, sans bloquer la construction :
la révision réellement installée face au draft `-28`, le comportement exact de
`CalendarEvent/query` sur une récurrence recoupant la fenêtre, et si la capacité de
disponibilité est annoncée par le serveur de test.
