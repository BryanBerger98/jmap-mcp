---
title: Tests
status: draft
updated: 2026-08-31
owner: bryan
---

# Tests

> [!NOTE]
> 181 tests passent sur 16 fichiers, dont 5 de contrat.
> Les fixtures couvrent la session, les messages, les identités et les fiches de contact.

## 🎯 Stratégie

Deux couches, séparées par leur objet.

| Couche | Couvre |
| --- | --- |
| `tests/unit/` | Rendu, pagination, mapping d'erreurs |
| `tests/contract/` | Invariant de garde sur `send` et `destroy` |

Les tests de contrat sont la couche qui compte : ils vérifient qu'aucun outil de classe `send` ou `destroy` ne s'exécute sans passer par la garde de politique.
Un module de domaine ne peut pas contourner le registre, et le test le prouve plutôt que la revue.

| Contrat | Invariant tenu |
| --- | --- |
| `policy-guard.test.ts` | Aucun `send` ni `destroy` sans garde |
| `read-only-surface.test.ts` | La lecture n'émet aucun `/set` |
| `elicitation-required.test.ts` | Sans élicitation : refus, pas exécution |
| `send-never-destroys.test.ts` | Jamais d'`onSuccessDestroyEmail` à l'envoi |
| `recipient-scope.test.ts` | Hors périmètre : refus avant confirmation |

Le contrat sur le périmètre va plus loin que le refus : il assert aussi qu'aucune méthode JMAP n'a été émise, et que la question de confirmation n'a jamais été posée.

Un contrat se valide par mutation : retirer la ligne qu'il garde doit le faire tomber au rouge.
Sans cette vérification, un test de contrat peut passer pour de mauvaises raisons et ne rien tenir.

## 🧰 Outils

- Vitest comme lanceur et bibliothèque d'assertions.
- Aucun serveur Stalwart réel en test : les échanges JMAP passent par les fixtures.

## 📐 Conventions

- Les fixtures vivent sous `tests/fixtures/`, une par spécification JMAP.
- Un domaine ajouté sans test de contrat sur ses opérations irréversibles est incomplet.
