---
objective: "L'assistant crée, corrige, répond et annule dans l'agenda du compte, aucun mail d'invitation ne partant sans une confirmation qui nomme ses destinataires."
title: Plan — Écriture des agendas
status: in-progress
updated: 2026-09-01
owner: bryan
---

# Plan — Écriture des agendas

## 🎯 Overview

| Champ | Valeur |
| --- | --- |
| **But** | Trois outils d'écriture d'agenda |
| **Source** | `2026_09_01_calendar-writing/prd.md` |
| **Surface** | 18 outils aujourd'hui, 21 après, sur 26 |
| **Socle** | Module 7 livré, en lecture seule |

Le module ouvre la première branche du projet où un même appel reste local ou expédie un mail selon un seul booléen.
Tout le plan tient sur ce point : `sendSchedulingMessages` est écrit explicitement à chaque `CalendarEvent/set`, et c'est lui qui décide de la classe.

## 🧭 Phases

| # | Phase | Fichier |
| --- | --- | --- |
| 1 | Types, politique dans le contexte et patch d'écriture | [`phase-1.md`](./phase-1.md) |
| 2 | `calendar_write` — créer et corriger, inviter ou non | [`phase-2.md`](./phase-2.md) |
| 3 | `calendar_respond` — répondre à une invitation reçue | [`phase-3.md`](./phase-3.md) |
| 4 | `calendar_delete` — annuler, en silence ou en prévenant | [`phase-4.md`](./phase-4.md) |

## 📚 Resources

Cinq sources lues cette session, chacune ayant tranché un point du plan.

| Source | Point tranché |
| --- | --- |
| [draft-jmap-calendars-28](https://www.ietf.org/archive/id/draft-ietf-jmap-calendars-28.html) | Sémantique de `sendSchedulingMessages` |
| [`calendar_event/set.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/calendar_event/set.rs) | Conditions réelles de l'expédition |
| [`participant_identity/get.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/participant_identity/get.rs) | Résolution de l'identité du compte |
| [`scheduling/event_create.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/groupware/src/scheduling/event_create.rs) | Refus `NotOrganizer` hors compte local |
| [`jscalendar/types.rs`](https://raw.githubusercontent.com/stalwartlabs/calcard/main/src/jscalendar/types.rs) | Noms de propriétés JSCalendar acceptés |

**📖 Ce que le draft impose**
`sendSchedulingMessages` est un argument de `CalendarEvent/set`, à faux par défaut, honoré aussi au `destroy` où il émet un `CANCEL`.
`utcStart` ne se combine ni avec `start` ni avec `duration`, et `isDraft` ne se pose qu'à la création sans jamais revenir à vrai.

**🔒 Ce que le serveur ajoute**
Le bloc d'expédition est sauté sans erreur si `itip_enabled` est faux, si la permission `CalendarSchedulingSend` manque, ou si l'événement est entièrement passé — `set.rs:429-435`.
Un dépassement de `itip_outbound_max_recipients` fait échouer l'écriture entière, et les identifiants synthétiques d'occurrence sont détournés vers un plan d'instance — `set.rs:487`, `set.rs:231`.

**⚠️ L'asymétrie qui gouverne les réponses**
Un `CalendarEvent/set` réussi ne prouve pas qu'un mail est parti.
La direction inverse reste impossible, l'argument n'étant écrit à vrai qu'après confirmation.
Aucune réponse d'outil n'écrit donc « invitation envoyée » : elle dit ce qui a été demandé.

## ⚖️ Decisions

| Décision | Pourquoi en une ligne |
| --- | --- |
| Manifeste `calendarWritingDomain` distinct | La lecture reste prouvablement pure |
| `sendSchedulingMessages` toujours écrit | Un défaut serveur n'est pas une garantie |
| `start` et `duration`, jamais `utcStart` | Le draft interdit la combinaison |
| `policy` ajouté au `ToolContext` | Une destruction peut expédier |
| Occurrence isolée refusée avant écriture | Hors périmètre, mais acceptée par le serveur |
| Périmètre appliqué aux participants | Une invitation est un mail |
| `notify` faux à l'écriture, vrai à la réponse | Prévenir est un geste demandé |
| `isDraft` jamais écrit | Verrou irréversible, sans besoin ici |

**🧱 Le manifeste séparé**
Le patron vient des contacts : `calendarDomain` garde ses trois lectures, et `tests/contract/calendar-read-only.test.ts` continue de le tenir sans une ligne réécrite.

**🚩 L'argument toujours écrit**
Le patron vient de `onDestroyRemoveEmails` : l'absence d'un argument ne se voit sur aucun test unitaire, alors qu'une valeur explicite se lit et se garde.

**🕰️ L'heure murale plutôt que l'instant**
Une récurrence et un changement d'heure suivent l'heure locale, jamais un instant UTC figé.
Le fuseau nommé est donc écrit avec la borne, et redit dans la réponse.

**🔓 La politique dans le contexte**
`calendar_delete` est le premier appel du projet de classe `destroy` dont l'effet de bord est un envoi.
Sans la politique en main, une configuration refusant `send` laisserait pourtant partir l'annulation.

**🧩 L'occurrence isolée**
Stalwart accepte l'identifiant synthétique et le détourne vers un plan d'instance.
Le PRD la met hors périmètre : le refus doit donc venir d'ici, pas d'un serveur qui obéirait.
