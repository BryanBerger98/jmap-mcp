---
title: Tests
status: draft
updated: 2026-08-31
owner: bryan
---

# Tests

> [!NOTE]
> 345 tests passent sur 31 fichiers, dont 10 de contrat.
> Les fixtures couvrent la session, les messages, les dossiers, les identités, les carnets d'adresses et les fiches de contact.

## 🎯 Stratégie

Deux couches, séparées par leur objet.

| Couche | Couvre |
| --- | --- |
| `tests/unit/` | Rendu, pagination, mapping d'erreurs |
| `tests/contract/` | Garde sur `send` et `destroy`, pureté en lecture du mail et des contacts |

Les tests de contrat sont la couche qui compte : ils vérifient qu'aucun outil de classe `send` ou `destroy` ne s'exécute sans passer par la garde de politique.
Un module de domaine ne peut pas contourner le registre, et le test le prouve plutôt que la revue.

| Contrat | Invariant tenu |
| --- | --- |
| `policy-guard.test.ts` | Aucun `send` ni `destroy` sans garde |
| `read-only-surface.test.ts` | Aucun outil du manifeste mail ne déclare ni ne classe autre chose que `read` |
| `elicitation-required.test.ts` | Sans élicitation : refus, pas exécution |
| `send-never-destroys.test.ts` | Jamais d'`onSuccessDestroyEmail` à l'envoi |
| `recipient-scope.test.ts` | Hors périmètre : refus avant confirmation |
| `organizing-takes-ids.test.ts` | Aucun outil de rangement ne prend un critère de recherche |
| `bulk-confirmation.test.ts` | Au-delà du seuil : question avant écriture |
| `destroy-needs-confirmation.test.ts` | Destruction non confirmée : aucune méthode émise |
| `no-cascade-destroy.test.ts` | Tout `Mailbox/set` porte `onDestroyRemoveEmails` à faux |
| `contacts-read-only.test.ts` | Contacts : rien hors `get` et `query` |

Le contrat sur les contacts sépare deux affirmations : la classe déclarée d'une part, ce qui part réellement sur le fil d'autre part.
Il exécute chaque outil du manifeste sur des arguments minimaux tirés de son propre schéma, donc il tient un outil ajouté au domaine sans être réécrit.
Il tient aussi le gating : sans la capacité contacts, aucun outil n'est enregistré et le rapport de composition nomme la capacité manquante.

Le contrat sur le périmètre va plus loin que le refus : il assert aussi qu'aucune méthode JMAP n'a été émise, et que la question de confirmation n'a jamais été posée.

Un contrat se valide par mutation : retirer la ligne qu'il garde doit le faire tomber au rouge.
Sans cette vérification, un test de contrat peut passer pour de mauvaises raisons et ne rien tenir.

## 🧰 Outils

- Vitest comme lanceur et bibliothèque d'assertions.
- Aucun serveur Stalwart réel en test : les échanges JMAP passent par les fixtures.

## 📐 Conventions

- Les fixtures vivent sous `tests/fixtures/`, une par spécification JMAP.
- Un domaine ajouté sans test de contrat sur ses opérations irréversibles est incomplet.
