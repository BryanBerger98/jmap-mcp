---
objective: "L'assistant crée, corrige, range et supprime une fiche de contact et gère les carnets qui les portent, sans jamais réécrire un champ qu'on ne lui a pas nommé ni vider un carnet en le supprimant."
status: in-progress
---

# Plan: Écrire dans ses carnets d'adresses

## Overview

| Field      | Value                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| **Goal**   | Trois outils d'écriture de contacts, première écriture hors du mail             |
| **Source** | [`2026_09_01-contacts-writing-prd.md`](../2026_09_01-contacts-writing-prd.md)   |

## Phases

| #   | Phase                                                    | File                         |
| --- | -------------------------------------------------------- | ---------------------------- |
| 1   | Types d'écriture, plafond partagé, constructeur de patch  | [`phase-1.md`](./phase-1.md) |
| 2   | `contacts_write`                                          | [`phase-2.md`](./phase-2.md) |
| 3   | `contacts_delete`                                         | [`phase-3.md`](./phase-3.md) |
| 4   | `contacts_book_manage`                                    | [`phase-4.md`](./phase-4.md) |
| 5   | Contrats d'écriture et non-cascade                        | [`phase-5.md`](./phase-5.md) |
| 6   | Documentation et mémoire projet                           | [`phase-6.md`](./phase-6.md) |

L'ordre suit le risque autant que la dépendance.
La phase 1 sort le constructeur de patch avant tout outil parce que c'est lui qui tient l'objectif le plus exigeant du PRD : une fonction pure d'une fiche lue et d'une demande vers un `PatchObject`, testable sans serveur, exactement comme le périmètre des destinataires l'est déjà.

Les trois outils viennent ensuite du moins destructeur au plus.
`contacts_write` est réversible, `contacts_delete` ne l'est pas, et `contacts_book_manage` touche le contenant : chacun s'enregistre dans le manifeste d'écriture à la fin de sa phase, donc la surface grandit d'un outil utilisable à la fois.

La phase 5 vient après les trois parce que ses deux contrats portent sur la surface entière.
Un contrat de non-cascade écrit sur un seul émetteur de `AddressBook/set` ne tiendrait rien le jour où un second apparaît, et c'est précisément ce que le contrat existant sur `Mailbox/set` vérifie déjà pour le mail.

## Resources

| Source                                                                          | Verified                                                                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 8620 §5.3](https://www.rfc-editor.org/rfc/rfc8620.txt)                       | `update` prend un `PatchObject` : clés en pointeur JSON, jamais d'index de tableau, tout le chemin sauf le dernier segment doit déjà exister |
| [RFC 8620 §5.3](https://www.rfc-editor.org/rfc/rfc8620.txt)                       | Valeur `null` : retire la propriété, ou remet le défaut ; clé absente du parent, l'opération ne fait rien                            |
| [RFC 8620 §5.3](https://www.rfc-editor.org/rfc/rfc8620.txt)                       | Deux patchs dont l'un préfixe l'autre sont interdits ; un patch invalide rend `invalidPatch`                                        |
| [RFC 8620 §5.3](https://www.rfc-editor.org/rfc/rfc8620.txt)                       | `create` prend une carte d'identifiants de création vers objets, le serveur rendant l'identifiant réel dans `created`                |
| [RFC 9610 §2.5](https://www.rfc-editor.org/rfc/rfc9610.txt)                       | `AddressBook/set` porte `onDestroyRemoveContents`, faux par défaut ; à faux, détruire un carnet peuplé rend `addressBookHasContents` |
| [RFC 9610 §2](https://www.rfc-editor.org/rfc/rfc9610.txt)                         | `isDefault` vaut vrai pour au plus un carnet du compte, et devrait valoir vrai pour exactement un                                    |
| [RFC 9610 §3](https://www.rfc-editor.org/rfc/rfc9610.txt)                         | Une fiche appartient à au moins un carnet tant qu'elle existe ; aucun carnet n'est attribué d'office                                 |
| [RFC 9553 §2.1.9](https://www.rfc-editor.org/rfc/rfc9553.txt)                     | Les clés de `members` sont des `uid` de fiches, jamais des identifiants JMAP                                                        |
| [`stalwart-jmap.md`](../../../memory/external/stalwart-jmap.md)                   | `ContactCard/set`, `ContactCard/copy`, `AddressBook/set` implémentées ; `onDestroyRemoveContents` vrai vide le carnet ; aucune corbeille de contacts |
| [`ROADMAP.md`](../../../ROADMAP.md)                                              | Module 6 : classes `draft` et `destroy`, même traitement de la cascade qu'au module 4                                                |

> [!WARNING]
> Une question reste ouverte et le PRD le dit : rien ne prouve, hors instance réelle, que Stalwart accepte un `PatchObject` sur un chemin JSContact imbriqué.
> Elle ne bloque pas la construction, parce que l'échec est fermé : un serveur qui refuse le patch rend `invalidPatch` et n'écrit rien, là où un objet complet aurait écrasé les champs absents.

## Decisions

| Decision                                                                        | Why                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Trois outils : `contacts_write`, `contacts_delete`, `contacts_book_manage`        | Un discriminant `card` ou `book` laisserait la moitié du schéma inerte à chaque appel ; `mail_folder_manage` a tranché la même question au module 4 |
| Toute écriture de fiche part en `PatchObject`, jamais en objet complet            | Seuls les chemins nommés sont touchés : c'est la seule façon de tenir « les champs que la lecture ne rend pas restent intacts »        |
| La fiche visée est relue avant d'être patchée                                     | Un pointeur JSON exige que tout le chemin sauf le dernier segment existe : sans la lecture, ajouter un téléphone à une fiche qui n'en a aucun rend `invalidPatch` |
| Les coordonnées s'écrivent en `add` et `remove`, jamais en liste de remplacement  | Une entrée JSContact porte `contexts` et `pref` que le rendu ne montre pas ; remplacer la carte des adresses pour en corriger une effacerait ce qui n'a pas été lu |
| Les membres d'un groupe se donnent par identifiant de fiche, résolus en `uid`     | La RFC 9610 clé `members` par `uid` et `contacts_search` rend des identifiants : exiger un `uid` obligerait à lire chaque membre d'abord |
| `contacts_write` prend un lot d'identifiants, le contenu étant refusé au-delà d'un | Ranger trente fiches dans un carnet est le geste de lot du module ; écrire la même adresse sur trente fiches n'en est pas un           |
| Le plafond de lot et son refus montent dans `src/shared/batch.ts`                 | Sans cela, les contacts importeraient une constante du mail ou en redéclareraient une seconde, qui dériverait au premier ajustement    |
| Un second manifeste `contactsWritingDomain`, séparé de la lecture                 | Même raison qu'au mail : `contactsDomain` reste prouvablement en lecture seule, et le contrat qui l'affirme vaut mieux qu'un fichier de moins |
| Le contrat de non-cascade s'étend à `AddressBook/set` dans le fichier existant    | L'invariant est le même — un contenant supprimé ne prend jamais son contenu — et deux fichiers pour un invariant en laissent un vieillir |
| Le doublon d'adresse est cherché dans la requête qui écrit                        | Une `ContactCard/query` placée avant le `/set` dans la même requête voit l'état d'avant l'écriture, et ne coûte aucun aller-retour     |
| `contacts_write` reste de classe `draft`, l'élargissement du périmètre étant dit  | Le périmètre est figé au démarrage : l'utilisateur a une session entière pour s'apercevoir qu'une adresse écrite aujourd'hui n'ouvre rien avant le redémarrage |

Le premier arbitrage tranche la question ouverte du PRD, et il coûte une entrée : la tranche contacts passe de quatre outils à cinq, le cumul de quatorze à quinze sur les vingt-six visés.
Le dépassement se traite au module 9, comme la feuille de route l'a fixé, et pas ici.

Le deuxième et le troisième forment une paire : le patch protège les champs qu'on ne nomme pas, la lecture préalable rend le patch émissible.
Aucun des deux ne suffit seul, et c'est pourquoi la phase 1 les livre ensemble avant tout outil.
