---
objective: "L'assistant rédige un brouillon dans la boîte Stalwart de son utilisateur et ne l'expédie qu'après une confirmation explicite, bornée à un périmètre de destinataires réglable."
status: implemented
---

# Plan: Rédiger et envoyer un mail depuis l'assistant

## Overview

| Field      | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| **Goal**   | Trois outils d'envoi exposés, première traversée réelle de la garde `confirm` |
| **Source** | [`2026_08_30-mail-sending-prd.md`](../2026_08_30-mail-sending-prd.md)   |

## Phases

| #   | Phase                                     | File                         |
| --- | ----------------------------------------- | ---------------------------- |
| 1   | Refus quand le client ne sait pas confirmer | [`phase-1.md`](./phase-1.md) |
| 2   | Types d'envoi, manifeste et `mail_identities` | [`phase-2.md`](./phase-2.md) |
| 3   | `mail_compose`                            | [`phase-3.md`](./phase-3.md) |
| 4   | `mail_send` et l'envoi d'un trait         | [`phase-4.md`](./phase-4.md) |
| 5   | Périmètre des destinataires               | [`phase-5.md`](./phase-5.md) |

L'ordre suit le risque, pas la valeur.
La phase 1 ferme la porte du refus avant qu'un seul outil d'écriture existe, ce qui rend impossible d'introduire un envoi silencieux entre-temps.
Les phases 3 et 4 sont séparées parce que rédiger se vérifie sans jamais rien expédier, alors que valider la phase 4 sort un message de la machine.

## Resources

| Source                                                                 | Verified                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [RFC 8621 §7.5](https://www.rfc-editor.org/rfc/rfc8621.txt)             | `EmailSubmission/set`, `onSuccessUpdateEmail`, réponse `Email/set` implicite |
| [RFC 8621 §4.6](https://www.rfc-editor.org/rfc/rfc8621.txt)             | Création d'`Email` : `bodyValues` + `textBody`, `headers` interdit           |
| [RFC 8621 §1.3.2](https://www.rfc-editor.org/rfc/rfc8621.txt)           | `Identity` relève de la capacité `submission`, pas de `mail`                 |
| [RFC 9553 §2.3.1](https://www.rfc-editor.org/rfc/rfc9553.txt)           | `ContactCard.emails` est une map d'`EmailAddress`, `address` obligatoire     |
| `@modelcontextprotocol/server@2.0.0`, `Server.getClientCapabilities`    | Déprécié mais fonctionnel, réalimenté depuis l'enveloppe validée             |
| [`elicitation-claude-desktop.md`](../../../backlog/spikes/elicitation-claude-desktop.md) | Le refus se décide au handshake, jamais sur un `action: cancel`   |
| [`envoi-differe-stalwart.md`](../../../backlog/spikes/envoi-differe-stalwart.md) | L'envoi différé passe par `envelope.mailFrom.parameters`, rien à réserver |

## Decisions

| Decision                                                              | Why                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Second manifeste `mail` exigeant `mail` **et** `submission`            | Un serveur sans soumission garde ses trois outils de lecture, condition d'acceptation du PRD       |
| Détection d'élicitation par appel, jamais à la composition             | La composition tourne avant `connect()`, où aucune capacité client n'est encore connue             |
| Refus en échec fermé quand la capacité est indécidable                 | Une incertitude sur le client ne doit jamais se résoudre en expédition                             |
| `send` est un argument de `mail_compose`, pas un quatrième outil       | La classification par argument est le principe du registre, et le budget d'outils reste à six      |
| Brouillon déplacé par `onSuccessUpdateEmail`, jamais détruit           | Le message reste consultable dans les envoyés, et `onSuccessDestroyEmail` est interdit             |
| `recipients.scope` vaut `anyone` à l'installation                      | Le garde-fou par carnet coûte une lecture des contacts, que personne ne paie sans l'avoir demandé  |
| Périmètre restreint = carnets **∪** liste explicite                    | Une adresse de service légitime n'a pas à entrer dans un carnet pour être joignable                |

Le quatrième arbitrage tranche la seule contradiction apparente du PRD : la feuille de route fixe trois outils, l'utilisateur en veut quatre gestes.
Rédiger et envoyer d'un trait est un état de `mail_compose`, dont `classify` bascule de `draft` à `send` sur la valeur de l'argument.
