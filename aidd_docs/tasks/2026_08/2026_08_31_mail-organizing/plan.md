---
objective: "L'assistant classe, marque, met à la corbeille et détruit les messages désignés par leur identifiant, et gère l'arborescence des dossiers, sans qu'aucun geste irréversible ni aucun lot massif ne passe sans confirmation."
status: in-progress
---

# Plan: Classer, marquer et supprimer ses mails

## Overview

| Field      | Value                                                                              |
| ---------- | ---------------------------------------------------------------------------------- |
| **Goal**   | Quatre outils de rangement exposés, première traversée réelle de la classe `destroy` |
| **Source** | [`2026_08_31-mail-organizing-prd.md`](../2026_08_31-mail-organizing-prd.md)         |

## Phases

| #   | Phase                                          | File                         |
| --- | ---------------------------------------------- | ---------------------------- |
| 1   | Escalade de confirmation et seuil configurable | [`phase-1.md`](./phase-1.md) |
| 2   | Socle de rangement, `mail_move` et `mail_flag` | [`phase-2.md`](./phase-2.md) |
| 3   | `mail_delete`, corbeille et destruction        | [`phase-3.md`](./phase-3.md) |
| 4   | `mail_folder_manage`                           | [`phase-4.md`](./phase-4.md) |
| 5   | Documentation et mémoire projet                | [`phase-5.md`](./phase-5.md) |

L'ordre suit le risque, pas la valeur.
La phase 1 installe le mécanisme qui fait confirmer un lot massif avant qu'un seul outil d'écriture existe, ce qui rend impossible d'introduire entre-temps un déplacement de deux cents messages passé sous silence.
Les phases 2 et 3 sont séparées parce que déplacer et marquer se valident sans qu'aucun message ne disparaisse, alors que valider la phase 3 en détruit un pour de bon.

## Resources

| Source                                                     | Verified                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [RFC 8621 §2](https://www.rfc-editor.org/rfc/rfc8621.txt)   | `Mailbox` : `name`, `parentId`, `role`, `sortOrder`, `isSubscribed` posables ; compteurs serveur |
| [RFC 8621 §2.5](https://www.rfc-editor.org/rfc/rfc8621.txt) | `onDestroyRemoveEmails` par défaut faux ; `mailboxHasEmail` et `mailboxHasChild` en `SetError`  |
| [RFC 8621 §4.1.1](https://www.rfc-editor.org/rfc/rfc8621.txt) | Mots-clés standards : `$draft`, `$seen`, `$flagged`, `$answered`, `$forwarded`, `$phishing`, `$junk`, `$notjunk` |
| [`stalwart-jmap.md`](../../../memory/external/stalwart-jmap.md) | `setMaxObjects` vaut 500 ; `Email/set` update sur `mailboxIds` est réversible, destroy ne l'est pas |
| [`ROADMAP.md`](../../../ROADMAP.md)                        | Module 4 : quatre outils, classes `draft` et `destroy`, cascade à désactiver par défaut          |

> [!NOTE]
> La RFC n'interdit pas de détruire un dossier portant un rôle : ce refus est une règle de l'outil, pas du serveur.

## Decisions

| Decision                                                             | Why                                                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Un hook `confirmWhen` sur la définition d'outil, distinct de `classify` | Faire passer un déplacement de masse pour un `destroy` mentirait à l'utilisateur au moment même où on lui demande d'arbitrer |
| Le seuil de volume est une valeur de configuration, le plafond de lot une constante | Le premier règle une prudence personnelle, le second protège le serveur : seul le premier est une préférence |
| Le plafond de cinquante identifiants est appliqué en `precheck`        | Un refus porté par le seul schéma ne serait jamais traversé par un test de contrat, qui appelle le handler directement |
| `mail_delete` porte la corbeille et la destruction, `permanent` bascule la classe | Un argument qui fait basculer la classe est le patron du registre, et le budget reste à dix outils sur vingt-six |
| Un troisième manifeste `mail` sur la seule capacité `mail`             | Le rangement s'expose sur un serveur qui n'expédie pas, et le manifeste de lecture garde son invariant de pureté |
| L'outil de dossiers s'appelle `mail_folder_manage`, non `mailbox_manage` | Tout le domaine partage le préfixe `mail_` et parle de « folder » ; `mailbox` est le nom de l'objet JMAP, pas celui du geste |
| Déplacer réécrit `mailboxIds` en entier au lieu de le patcher          | Un message classé doit disparaître de son ancien dossier, ce qu'un patch additif ne fait pas       |
| `$draft` reste hors de `mail_flag`                                     | Poser ce mot-clé sur un message reçu ne le rend pas expédiable, et le retirer d'un vrai brouillon le casse |
| `onDestroyRemoveEmails` est émis explicitement à faux                  | Un test de contrat qui exige une valeur tient mieux qu'un test qui constate une absence            |

Le premier arbitrage tranche la seule tension du PRD : un déplacement reste réversible, donc de classe `draft`, mais deux cents déplacements d'un coup méritent une question.
Le registre gagne donc un second chemin vers la confirmation, ouvert par l'outil et non par la politique, et fermé au même endroit quand le client ne sait pas éliciter.
