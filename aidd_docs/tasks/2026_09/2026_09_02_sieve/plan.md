---
objective: "L'assistant lit les scripts Sieve du compte, en stocke un validé sans jamais l'activer, active ou détruit sur confirmation nommant ce qui change, et règle la réponse d'absence sans jamais l'éteindre à l'insu de l'utilisateur."
title: Plan — Sieve et réponse d'absence
status: in-progress
updated: 2026-09-02
owner: bryan
---

# Plan — Sieve et réponse d'absence

## 🎯 Overview

| Champ | Valeur |
| --- | --- |
| **But** | Trois outils sur le filtrage entrant et l'absence |
| **Source** | [`2026_09_02-sieve-prd.md`](../2026_09_02-sieve-prd.md) |
| **Surface** | 25 outils aujourd'hui, 28 après, pour une cible de 26 |
| **Socle** | Module 1 seul, aucune branche métier |

C'est le premier module dont l'écriture ne touche aucune donnée existante et change pourtant le sort de tout le courrier à venir.
Deux points gouvernent le plan : stocker un script ne l'active jamais, et l'état actif de l'absence ne bouge que quand l'appel le nomme.

## 🧭 Phases

| # | Phase | Fichier |
| --- | --- | --- |
| 1 | Types, deux manifestes et lecture des scripts | [`phase-1.md`](./phase-1.md) |
| 2 | `sieve_write` — valider puis stocker, sans activer | [`phase-2.md`](./phase-2.md) |
| 3 | `sieve_write` — activer, couper, détruire | [`phase-3.md`](./phase-3.md) |
| 4 | `vacation_manage` — poser et lever une absence | [`phase-4.md`](./phase-4.md) |
| 5 | Budget d'outils, mémoire projet et deux corrections | [`phase-5.md`](./phase-5.md) |

## 📚 Resources

Sept sources lues cette session, chacune ayant tranché un point du plan.

| Source | Point tranché |
| --- | --- |
| [RFC 9661](https://www.rfc-editor.org/rfc/rfc9661.html) | Objet `SieveScript`, quatre méthodes, champs de capacité |
| [`sieve/get.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/sieve/get.rs) | Quatre propriétés seulement : le texte est un blob |
| [`sieve/set.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/sieve/set.rs) | Trois chemins d'activation, `vacation` doublement réservé |
| [`sieve/query.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/sieve/query.rs) | Deux filtres, deux tris, erreur réelle au-delà |
| [`sieve/validate.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/sieve/validate.rs) | Validation par blob, message compilateur rendu tel quel |
| [`vacation/set.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/vacation/set.rs) | Singleton strict, et l'état actif ne s'éteint pas seul |
| [`api/session.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/api/session.rs) | Les deux capacités tiennent à deux permissions distinctes |

**📄 Le texte qui n'est pas dans l'objet**

`SieveScript/get` ne rend que `id`, `name`, `blobId` et `isActive` — `sieve/get.rs:40-44`.
Le corps du script voyage donc en blob, comme un fichier, et l'objet JMAP n'en porte que la référence.
La section du `BlobId` rendu est bornée à `sieve.size` — `sieve/get.rs:117-121` — donc le téléchargement rend la source seule, sans l'archive compilée que le serveur y accole.

**⚡ Les trois chemins d'activation**

Deux sont attendus, `onSuccessActivateScript` et `onSuccessDeactivateScript`.
Le troisième ne l'est pas : écrire la propriété `isActive` est capté en `set_item` — `sieve/set.rs:482-484` — poussé dans les activations, puis retraduit par le serveur en l'un des deux arguments — `sieve/set.rs:358-368`.
Un outil d'écriture qui émettrait `isActive` activerait donc un script en croyant le nommer.

**🚫 Le nom `vacation`, réservé deux fois et détruit sans garde**

Mettre à jour un script nommé `vacation` est refusé en `forbidden` — `sieve/set.rs:416-424` — et nommer un script `vacation` l'est aussi — `sieve/set.rs:443-448`.
Le détruire ne l'est pas : `sieve/set.rs:329-351` ne contrôle que la condition du script actif.
C'est précisément le trou que le critère 6 du PRD demande de fermer côté client.

> [!CAUTION]
> `aidd_docs/memory/external/stalwart-jmap.md:265` et `aidd_docs/ROADMAP.md:231` affirment que `isEnabled` retombe à faux dès qu'une propriété de l'absence change.
> C'est faux : `vacation/set.rs:144` initialise l'état depuis le script actif courant, seule une propriété `isEnabled` explicite le change — `vacation/set.rs:186-191` — donc le critère 10 du PRD est reformulé et les deux lignes corrigées en phase 5.

## ⚖️ Decisions

| Décision | Pourquoi en une ligne |
| --- | --- |
| Trois outils, non deux | Deux manifestes et deux outils ne peuvent pas coexister |
| Trois manifestes sur deux capacités | Deux permissions Stalwart distinctes, plus la lecture séparée de l'écriture |
| Le texte du script traverse la conversation | C'est ce que l'utilisateur lit et rédige, pas un octet opaque |
| `isActive` jamais écrit en propriété | Le serveur le retraduit en activation |
| Validation avant tout stockage | Même compilateur que `set`, sur le blob déjà téléversé |
| Activation classée `destroy` | Un `discard` activé perd du courrier sans trace |
| Écraser le script actif se fait confirmer | Sa classe `draft` n'annonce pas un courrier qui change tout de suite |
| Bascule de l'absence classée `send` | Elle fait partir des messages, elle n'efface rien |
| `isEnabled` écrit seulement s'il est nommé | Le serveur le préserve, le réécrire fondrait les deux gestes |
| Refus client sur script actif et sur `vacation` | Le serveur ne garde que le premier des deux |

**🔢 Pourquoi trois outils là où le PRD en recommandait deux**

Les trois réponses du PRD ne tiennent pas ensemble : deux outils, deux manifestes, et le gating par capacité du critère 7.
Le registre enregistre des outils entiers par manifeste, donc deux manifestes non vides pour deux outils forcent la partition un plus un.
Côté scripts, cet outil unique fondrait la lecture et la destruction sous un nom, ce que `internal/tool-budget.md` interdit explicitement.

L'arbitrage suit la hiérarchie du PRD lui-même : le nombre d'outils vit dans ses questions ouvertes, le gating est un critère d'acceptation.
Le scénario perdu par un manifeste unique n'est d'ailleurs pas théorique : un administrateur qui retire `JmapSieveScriptGet` en gardant `JmapVacationResponseGet` — deux permissions indépendantes, `api/session.rs:113` et `:118` — est le cas plausible, et un manifeste unique lui ferait perdre l'absence en même temps que les scripts.

La surface passe donc à vingt-huit pour une cible de vingt-six, sous le seuil de trente où la dégradation s'observe.
La place du module 11 se rouvrira par fusion de deux verbes voisins de même classe, arbitrage porté en phase 5 et non ici.

**📢 Deux classes pour deux natures d'engagement**

Activer un script est classé `destroy` : une règle `discard` jette un message sans stockage ni corbeille, et c'est la seule perte que le module rend possible.
La justification du PRD — « la seule classe dont la confirmation est déjà obligatoire » — est inexacte, `send` l'étant aussi par défaut ; le choix tient par la perte, pas par la politique.

Régler l'absence ne perd rien mais fait partir des messages vers des tiers, donc `vacation_manage` classe `send` dès que `isEnabled` est écrit, dans un sens comme dans l'autre, et `draft` quand seuls le texte ou les dates changent.
Une politique `send: deny` coupe alors l'absence sans toucher aux scripts, ce qui est lisible.

**🔒 Ce que le client refuse avant le serveur**

Deux refus tombent côté client parce que le serveur ne les prononce pas.
Un script actif détruit est bien refusé par Stalwart en `scriptIsActive`, mais après la question de confirmation : le refus remonte donc au `precheck`, qui nomme l'activation qui bloque.
Le script `vacation` détruit par le chemin des scripts n'est refusé par personne, et c'est le seul endroit du module où le client est la seule garde.

**🔁 Filtrer et s'absenter s'excluent**

Un compte n'a qu'un script actif — `sieve/set.rs:328` n'en résout qu'un — et l'absence est active exactement quand son script l'est — `vacation/set.rs:144`.
Activer un filtre éteint donc l'absence, et allumer l'absence désactive le filtre — `vacation/set.rs:281-283`, commentée « Deactivate other sieve scripts ».

Les deux confirmations le disent, chacune de son côté : celle de l'activation nomme le script remplacé, celle de l'absence nomme le filtre qui cesse.
Sans cela, un utilisateur poserait son absence et perdrait son rangement automatique sans qu'aucune ligne ne le lui ait dit.

> [!WARNING]
> Les codes d'erreur de la RFC ne sont pas ceux du fil : RFC 9661 nomme `invalidSieve` et `sieveIsActive`, Stalwart sérialise `invalidScript` et `scriptIsActive`.
> Une traduction écrite sur les noms de la RFC ne matcherait jamais.
