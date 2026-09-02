---
objective: "`mail_compose` fait partir un corps HTML fourni tel quel, seul ou aux côtés d'un corps texte, refuse un appel sans aucun corps, et nomme le format à la confirmation en montrant le texte et les liens que le HTML porte."
title: Plan — Corps HTML à l'envoi
status: implemented
updated: 2026-09-03
owner: bryan
---

# Plan — Corps HTML à l'envoi

## 🎯 Overview

| Champ | Valeur |
| --- | --- |
| **But** | Un argument de plus sur `mail_compose`, aucun outil de plus |
| **Source** | [`2026_09_02-mail-html-body-prd.md`](../2026_09_02-mail-html-body-prd.md) |
| **Surface** | 29 outils avant, 29 après |
| **Version** | Mineure, avec son changeset |

C'est la première tranche du projet qui n'ajoute aucun outil et n'ouvre aucune capacité.
Elle tient à un fait vérifié cette session : Stalwart accepte `htmlBody` à la création d'un message, et le seul obstacle est que le type du projet ne le déclare pas.

## 🧭 Phases

| # | Phase | Fichier |
| --- | --- | --- |
| 1 | Le corps HTML part, et l'absence de corps est refusée | [`phase-1.md`](./phase-1.md) |
| 2 | La confirmation le nomme, un contrat le tient intact | [`phase-2.md`](./phase-2.md) |

## 📚 Resources

Trois sources lues cette session, chacune ayant levé une inconnue du PRD.

| Source | Point tranché |
| --- | --- |
| [`email/set.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/jmap/src/email/set.rs) | `htmlBody` accepté, une partie au plus, type exact |
| [`mail-builder/src/lib.rs`](https://raw.githubusercontent.com/stalwartlabs/mail-builder/main/src/lib.rs) | Deux corps donnent un `multipart/alternative` |
| [`mail-builder/src/mime.rs`](https://raw.githubusercontent.com/stalwartlabs/mail-builder/main/src/mime.rs) | L'encodage de transfert est détecté, jamais imposé |

**✅ La dépendance que le PRD disait « jamais éprouvée »**

`email/set.rs:253-285` accepte `textBody` et `htmlBody` à la création, à trois conditions.
La requête ne doit porter aucun `bodyStructure` — `email/set.rs:128-129` — chaque propriété ne doit nommer qu'une partie, et le `type` de cette partie doit valoir exactement `text/html`, sinon le serveur refuse en nommant le type attendu — `email/set.rs:453-467`.
Les deux corps atterrissent ensuite dans deux champs distincts du constructeur — `email/set.rs:651-657` — et l'assemblage MIME leur donne un `multipart/alternative`, le texte d'abord, le HTML ensuite — `mail-builder/src/lib.rs:249-251`.
Un corps HTML seul reste une partie `text/html` unique — `mail-builder/src/lib.rs:265`.

**🔍 Ce que « intact à l'octet » veut dire exactement**

L'encodage de transfert est choisi par détection, pas par le projet — `mime.rs:393-404`.
`quoted-printable` et `base64` restituent l'entrée à l'identique après décodage par le client.
La branche `7bit` fait une seule normalisation : un saut de ligne nu devient `\r\n` — `mime.rs:405-410`.
C'est la borne honnête du critère 5 du PRD, et elle ne touche que les fins de ligne d'un HTML déjà en pur ASCII.

**🚫 Pourquoi le refus d'un message sans corps doit venir du client**

Le serveur a bien un garde-fou contre le message vide, mais il ne sert à rien ici.
`email/set.rs:728-740` n'entre dans le refus que si le message n'a ni en-tête, ni corps, ni pièce jointe.
Or `buildDraft` écrit toujours `from`, `to` et `subject`, donc un brouillon sans aucun corps passerait et arriverait vide chez le destinataire.
Le refus tombe donc dans le schéma d'entrée, sur le patron du `refine` qui exige déjà `to` ou `replyToEmailId` — `src/domains/mail/compose.ts:68-72`.

## ⚖️ Decisions

| Décision | Pourquoi en une ligne |
| --- | --- |
| `htmlBody` ajouté, `body` conservé | Renommer `body` casserait tout appel écrit jusqu'ici |
| `body` devient optionnel, un `refine` exige un corps | La contrainte porte sur la paire, pas sur un champ |
| Deux `partId` distincts, `body` et `html` | `bodyValues` est une carte, deux corps sont deux entrées |
| Aucun `bodyStructure`, aucun `attachments` émis | Leur seule présence ferait refuser `htmlBody` |
| Aucun repli texte dérivé du HTML | Le PRD l'exclut, et une dérivation signerait un texte que personne n'a relu |
| La confirmation montre le HTML dégradé et ses liens | C'est le seul garde-fou avant un envoi non filtré |
| Un module `mail/html.ts` pur, hors de `shared/` | Un seul domaine le lit, comme `sieve/radius.ts` |
| Un contrat dédié à l'intégrité du corps | Aucun nom d'argument ne trahit une réécriture silencieuse |

**👁️ Ce que la confirmation montre, et ce qu'elle ne peut pas montrer**

La question tranchée par l'utilisateur cette session : format, extrait dégradé, puis liens.
L'extrait passe par `htmlToText` — `src/shared/render.ts:61-83` — la fonction qui sert déjà à `mail_read`, donc les deux bouts du projet dégradent le HTML de la même façon.
Cette dégradation efface exactement une chose qui compte, la cible d'un lien, et c'est pourquoi les `href` sont listés à part.
Les `src` d'images n'y figurent pas : une image incorporée est hors périmètre de la tranche d'envoi depuis son PRD d'origine.

Un point de portée mérite d'être su avant d'écrire la phase 2.
`summarize` n'est appelé que sur le chemin de l'élicitation — `src/registry/compose.ts:187` — donc la ligne de format n'apparaît que sur un appel qui envoie.
Un `mail_compose` qui écrit un brouillon ne pose aucune question et ne rend aucune ligne de plus, ce qui satisfait le critère de non-régression sans effort.

> [!WARNING]
> `mail_read` continue de dégrader le HTML qu'il lit — `src/domains/mail/read.ts:161-165`.
> Relire par cet outil un brouillon écrit en HTML rend donc du texte et jamais le balisage, ce que le PRD exclut sans que cela cesse d'être le premier rapport de bogue attendu.

**⚠️ Le refus serveur que la tranche n'a pas à coder**

Un corps HTML compte dans le plafond de taille des parties — `email/set.rs:616-632` — qui rend un `invalidProperties` nommant la taille maximale.
`describeNotCreated` cite déjà les mots du serveur — `src/domains/mail/submission.ts:168-184` — donc le critère 9 du PRD est tenu sans une ligne de plus.
Rien n'est écrit dans le compte quand la création échoue, la soumission étant enchaînée sur l'identifiant de création.
