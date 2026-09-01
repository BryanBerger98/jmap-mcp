---
objective: "L'assistant retrouve une fiche de contact par nom, adresse ou organisation, en lit le détail, voit où elle est rangée et si son adresse est dans le périmètre d'envoi, sans qu'aucune requête d'écriture ne quitte le module."
status: implemented
---

# Plan: Consulter ses carnets d'adresses

## Overview

| Field      | Value                                                                              |
| ---------- | ---------------------------------------------------------------------------------- |
| **Goal**   | Deux outils de contacts exposés, première sortie du mail depuis le bootstrap        |
| **Source** | [`2026_08_31-contacts-reading-prd.md`](../2026_08_31-contacts-reading-prd.md)       |

## Phases

| #   | Phase                                             | File                         |
| --- | ------------------------------------------------- | ---------------------------- |
| 1   | Types JSContact, rendu de fiche, périmètre lisible | [`phase-1.md`](./phase-1.md) |
| 2   | `contacts_search`                                 | [`phase-2.md`](./phase-2.md) |
| 3   | `contacts_read`                                   | [`phase-3.md`](./phase-3.md) |
| 4   | Contrat de lecture seule et gating de capacité    | [`phase-4.md`](./phase-4.md) |
| 5   | Documentation et mémoire projet                   | [`phase-5.md`](./phase-5.md) |

L'ordre suit la dépendance, pas le risque : rien de ce module n'écrit, donc aucune phase n'a besoin de précéder une autre pour protéger l'utilisateur.
La phase 1 sort les types et le rendu avant tout outil, parce que les deux outils partagent la fiche, la légende des carnets et la marque de périmètre : les écrire deux fois les ferait diverger.
La phase 4 vient après les deux outils parce que le contrat porte sur la surface entière, et un contrat écrit sur la moitié d'une surface ne tient rien.

## Resources

| Source                                                          | Verified                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [RFC 9610 §2](https://www.rfc-editor.org/rfc/rfc9610.txt)        | `AddressBook` : `id`, `name`, `description`, `sortOrder`, `isDefault`, `isSubscribed`, `shareWith`, `myRights` |
| [RFC 9610 §3](https://www.rfc-editor.org/rfc/rfc9610.txt)        | `ContactCard` = objet JSContact plus `id`, `addressBookIds`, `blobId`                                          |
| [RFC 9610 §3.3](https://www.rfc-editor.org/rfc/rfc9610.txt)      | Vingt conditions de filtre, dont `inAddressBook`, `uid`, `kind`, `text`, `name`, `name/given`, `email`, `phone`, `organization`, `note` |
| [RFC 9610 §3.3](https://www.rfc-editor.org/rfc/rfc9610.txt)      | Tri : `created` et `updated` obligatoires, les trois `name/*` seulement recommandés                            |
| [RFC 9610](https://www.rfc-editor.org/rfc/rfc9610.txt)           | Aucun `AddressBook/query` dans la RFC : lister un carnet passe par `AddressBook/get`                           |
| [RFC 9553](https://www.rfc-editor.org/rfc/rfc9553.txt)           | Chemins de rendu : `name.full`, `organizations{}.name`, `titles{}.name`, `phones{}.number`, `notes{}.note`, `addresses{}.full`, `members` clés d'uid |
| [`stalwart-jmap.md`](../../../memory/external/stalwart-jmap.md)  | Tri par nom rendu en `UnsupportedSort` ; `name`, `name/given` et `name/surname` retombent sur le même index    |
| [`ROADMAP.md`](../../../ROADMAP.md)                             | Module 5 : `contacts_search`, `contacts_read`, classe `read`, deux écarts à documenter dans la description     |

> [!NOTE]
> `AddressBook/query` existe chez Stalwart mais hors RFC.
> Aucun outil ne s'en sert : un compte a quelques carnets, `AddressBook/get` avec `ids: null` les rend tous en un appel.

## Decisions

| Decision                                                                        | Why                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Deux outils, la liste des carnets tenant dans un en-tête de `contacts_search`     | Une ligne de légende coûte moins qu'une entrée sur vingt-six, et elle répond à « où est rangée cette fiche » à chaque recherche |
| Une recherche sans critère parcourt le carnet entier, page par page               | Un carnet se consulte en entier bien plus souvent qu'une boîte mail ; exiger un critère comme `mail_search` forcerait à en inventer un fourre-tout |
| Tri sur `created` croissant, annoncé dans chaque réponse                          | Le serveur refuse le tri par nom, et `created` ne bouge pas sous nos pieds : pager par `position` sans ordre stable saute des fiches |
| Chaque adresse rendue porte son appartenance au périmètre des destinataires       | C'est le manque le plus coûteux du PRD, et `RecipientScope` est déjà sur le contexte d'outil : la marque ne coûte aucun aller-retour |
| `isWithinScope` extrait de `checkRecipients` et exporté                           | Une seule règle d'appartenance : une comparaison recopiée pour l'affichage divergerait un jour du refus qu'elle prétend expliquer |
| La marque de périmètre annonce qu'elle est figée au démarrage                     | Une fiche créée en cours de session est trouvée par la recherche sans être encore dans le périmètre, et l'écart doit se lire sur place |
| Une fiche de groupe est rendue telle quelle, ses membres listés en uid            | Déplier un groupe en ses fiches appartient au module 6, qui saura les manipuler ; ici cela n'ajouterait qu'un aller-retour |
| Un fichier de contrat dédié, qui assert sur les méthodes JMAP réellement émises   | Déclarer la classe `read` ne prouve pas qu'aucune écriture ne part ; le contrat mail existant ne regarde que les classes déclarées |

Le premier arbitrage tranche la question ouverte du PRD.
La liste des carnets ne devient pas un troisième outil parce qu'elle n'est jamais une fin en soi : on veut savoir où une fiche est rangée, ou dans quel carnet chercher, et les deux questions se posent au moment de la recherche.

Le quatrième arbitrage va au-delà du PRD sans le contredire : le PRD demande que le périmètre soit observable, il ne dit pas comment.
Le rendre par adresse plutôt que par un outil dédié évite une septième entrée au budget et place la réponse là où la question se pose.
