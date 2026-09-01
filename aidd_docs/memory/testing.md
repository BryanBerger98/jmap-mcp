---
title: Tests
status: draft
updated: 2026-09-01
owner: bryan
---

# Tests

> [!NOTE]
> 940 tests passent sur 59 fichiers, dont 15 de contrat, chiffres relevés sur une exécution de `pnpm test`.
> Les fixtures couvrent la session, les messages, les dossiers, les identités, les carnets d'adresses, les fiches de contact, les agendas et les nœuds de fichier, en lecture comme en écriture.

## 🎯 Stratégie

Deux couches, séparées par leur objet.

| Couche | Couvre |
| --- | --- |
| `tests/unit/` | Rendu, pagination, mapping d'erreurs |
| `tests/contract/` | Garde sur `send` et `destroy`, pureté des surfaces de lecture |

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
| `no-cascade-destroy.test.ts` | Les trois drapeaux de cascade sont toujours écrits, et seul celui des fichiers peut valoir vrai |
| `contacts-read-only.test.ts` | Contacts en lecture : rien hors `get` et `query` |
| `contacts-write-guard.test.ts` | Écriture des contacts : confirmation, identifiants, lot, création sans destruction |
| `calendar-read-only.test.ts` | Agendas : rien hors les lectures nommées |
| `calendar-write-guard.test.ts` | Écriture des agendas : `sendSchedulingMessages` toujours écrit, patch borné au participant du compte, destruction confirmée |
| `files-read-only.test.ts` | Fichiers en lecture : rien hors `get` et `query`, et aucune condition hors des neuf honorées |
| `files-write-guard.test.ts` | Écriture des fichiers : `onExists` toujours `null`, cascade demandée seule, lot et frontière du disque |

Le contrat sur la lecture des contacts sépare deux affirmations : la classe déclarée d'une part, ce qui part réellement sur le fil d'autre part.
Il exécute chaque outil du manifeste sur des arguments minimaux tirés de son propre schéma, donc il tient un outil ajouté au domaine sans être réécrit.
Il tient aussi le gating : sans la capacité contacts, aucun des deux manifestes n'enregistre d'outil, et le rapport de composition nomme la capacité manquante pour chacun.

Le contrat sur l'écriture parcourt lui aussi le manifeste, avec une exception assumée : les arguments qui atteignent la branche destructrice de chaque outil sont écrits à la main, une dérivation générique ne pouvant pas produire un appel qui franchisse le `precheck`.
Un test d'exhaustivité tient cette table honnête : un outil qui déclare `destroy` sans y figurer fait tomber le contrat.
La non-cascade porte désormais trois drapeaux : `onDestroyRemoveEmails` sur un dossier, `onDestroyRemoveContents` sur un carnet, `onDestroyRemoveChildren` sur un nœud de fichier.
Les deux premiers sont écrits à faux sans exception ; le troisième répond à une règle plus étroite, énoncée plus bas.

Le contrat sur les agendas reprend ce patron et durcit un point : sa liste blanche nomme des méthodes entières, jamais des suffixes.
`Principal/getAvailability` ne finit pas par `/get`, et une règle assez lâche pour l'admettre admettrait aussi `CalendarEvent/set`.
Il vérifie en outre qu'aucun des trois outils ne porte de `precheck` ni de `confirmWhen` : une lecture ne pose pas de question.

Le contrat sur l'écriture des agendas parcourt le même manifeste et tient trois choses de plus.
Tout `CalendarEvent/set` émis porte `sendSchedulingMessages`, sur chacun des chemins qui y mènent : une création, une création qui invite, une correction, une correction qui notifie, une réponse, une suppression.
Tout patch de `calendar_respond` pointe sous `participants/{clé du compte}/` et nulle part ailleurs, la carte entière n'étant jamais écrite.
Aucun outil du module n'émet `Calendar/set` : gérer les agendas eux-mêmes est hors périmètre, et rien ne doit y toucher par accident.

Le contrat sur la lecture des fichiers reprend le patron des contacts et y ajoute deux assertions que ce domaine seul réclame.
La première tient le filtre : tout `FileNode/query` émis ne porte que des conditions de la liste des neuf honorées, quels que soient les arguments d'entrée, parce que les treize autres sont parsées puis abandonnées sans erreur.
La seconde tient les octets : `files_fetch` ne fait passer aucun contenu par le point JMAP, le canal de blobs étant le seul chemin.

Le contrat sur l'écriture des fichiers pose la règle que les deux autres cascades n'ont pas.
Tout `FileNode/set` émis porte `onExists` à `null` sur les cinq chemins qui y mènent, et `onDestroyRemoveChildren` ne vaut vrai que là où l'appel l'a demandé.
Un test lit les sources pour vérifier qu'un seul module écrit ce drapeau à vrai et qu'un seul remplit `destroy` : un second émetteur passerait hors du comptage et hors de la confirmation.

Une nuance y est assumée plutôt que masquée : une destruction non confirmée n'émet aucune écriture, mais une lecture peut la précéder.
`precheck` et `summarize` tournent avant l'élicitation par construction, l'un pour qu'un appel voué au refus ne soit pas posé en question, l'autre pour que la question nomme ce sur quoi elle porte.
L'assertion tenue porte donc sur toutes les méthodes émises, et pas seulement sur le `/set` : rien hors des `/get`.

Le contrat sur le périmètre va plus loin que le refus : il assert aussi qu'aucune méthode JMAP n'a été émise, et que la question de confirmation n'a jamais été posée.

Un contrat se valide par mutation : retirer la ligne qu'il garde doit le faire tomber au rouge.
Sans cette vérification, un test de contrat peut passer pour de mauvaises raisons et ne rien tenir.

## 🧰 Outils

- Vitest comme lanceur et bibliothèque d'assertions.
- Aucun serveur Stalwart réel en test : les échanges JMAP passent par les fixtures.

## 📐 Conventions

- Les fixtures vivent sous `tests/fixtures/`, une par spécification JMAP.
- Un domaine ajouté sans test de contrat sur ses opérations irréversibles est incomplet.
