---
title: "Spike : envoi différé sur Stalwart"
type: spike
status: resolved
updated: 2026-08-30
owner: bryan
source: aidd_docs/tasks/2026_08/2026_08_30-mail-sending-prd.md
parents:
  - aidd_docs/tasks/2026_08/2026_08_30-mail-sending-prd.md
---

# Spike : envoi différé sur Stalwart

## ❓ Question

Stalwart sait-il différer l'expédition d'un message, et par quel champ JMAP un client demande-t-il ce report ?

## 🎯 Décision

Inscrire ou non l'envoi planifié à la feuille de route, et figer en conséquence la signature de `mail_send` avant sa première publication.

Un argument de planification ajouté après coup reste additif, donc non rupturant.
Une promesse faite puis retirée, elle, casse le contrat public du paquet.

## 📐 Bornes

| Preuve attendue | Où la chercher |
| --- | --- |
| Valeur de `maxDelayedSend` | Session JMAP de l'instance d'Alfred |
| Champ portant la date d'envoi | Texte normatif de la RFC 8621 |
| Prise en compte réelle du report | Code ou CHANGELOG de Stalwart |

**Arrêt** : quand la valeur annoncée par l'instance est connue **et** le champ porteur identifié, ou quand le code de Stalwart prouve qu'il ignore le report.

Hors bornes : l'annulation d'un envoi déjà soumis, le suivi de son état, et la conception de l'outil MCP qui l'exposerait.

## 🔬 Investigation

Dépôt `stalwartlabs/stalwart`, branche `main`, consulté le 2026-08-30.

| Tentative | Preuve | Résultat |
| --- | --- | --- |
| Valeur annoncée | `crates/common/src/config/mailstore/capabilities.rs:213` | `max_delayed_send: 86400 * 30`, soit trente jours |
| Extension annoncée | `crates/common/src/config/mailstore/capabilities.rs:215` | `FUTURERELEASE` présent dans `submissionExtensions` |
| Statut de `sendAt` | RFC 8621, ligne 4233 | `immutable; server-set` — le client ne l'écrit jamais |
| Porteur de la demande | RFC 8621, lignes 4162 et 4193 | `envelope.mailFrom.parameters`, une map de mail-parameters SMTP |
| Lecture par Stalwart | `crates/jmap/src/submission/set.rs:414` | Les paramètres de `mailFrom` passent au parseur RFC 5321 |
| Calcul de `sendAt` | `crates/jmap/src/submission/set.rs:651-654` | `hold_until`, sinon `hold_for + now()`, sinon `now()` |
| Preuve exécutée | `tests/src/jmap/mail/submission.rs:426` et `:438` | Un test du dépôt pose `HOLDUNTIL` et vérifie `sendAt` |

Le test de Stalwart est décisif : il crée une soumission avec `.parameter("HOLDUNTIL", "2079-11-20T05:00:00Z")` et affirme que `sendAt` vaut exactement cette date.

## 📊 Résultat

- **Résultat** : oui. Stalwart diffère un envoi jusqu'à trente jours, et la demande passe par le paramètre SMTP `HOLDFOR` ou `HOLDUNTIL` posé sur `envelope.mailFrom.parameters` de l'`EmailSubmission`. Aucun champ JMAP dédié n'existe : `sendAt` est un miroir en lecture seule.
- **Confiance** : élevée. Trois sources indépendantes concordent — la configuration qui annonce, le code qui lit, le test du dépôt qui exécute.
- **Incertitude restante** :
  - La valeur annoncée par l'instance d'Alfred n'a pas été observée : `86400 * 30` est le défaut du code, pas une mesure.
  - Aucun bornage de `hold_until` sur `maxDelayedSend` dans `submission/set.rs` — le test passe une date à cinquante-trois ans. Le plafond annoncé paraît indicatif, pas appliqué.
  - Le trajet de `hold_until` jusqu'à la libération effective par la file SMTP n'a pas été tracé.

## 🔁 Suite

La question ouverte du PRD est tranchée : l'envoi planifié est faisable, et son mécanisme est connu.
Il reste hors périmètre de la tranche courante, mais il cesse d'être une inconnue et devient un choix de feuille de route.

Deux conséquences pour la conception de `mail_send` :

- Un futur argument de planification se traduira en `envelope.mailFrom.parameters`, jamais en `sendAt`. La signature de l'outil n'a donc rien à réserver aujourd'hui.
- La classe d'opération ne change pas : une soumission différée part quand même, sans retour possible côté client. Elle reste `send`.

Vérification restante, une seule commande sur l'instance réelle : lire `accountCapabilities` de `urn:ietf:params:jmap:submission` dans la session JMAP et comparer `maxDelayedSend` au défaut de trente jours.
