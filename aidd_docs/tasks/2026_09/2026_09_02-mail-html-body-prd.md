---
title: PRD — Envoyer un message en HTML
status: draft
updated: 2026-09-02
owner: bryan
---

# PRD — Envoyer un message en HTML

`mail_compose` n'écrit qu'un corps `text/plain` : tout message rédigé par l'assistant arrive sans mise en forme.
Cette tranche ouvre le corps HTML, fourni tel quel par l'appelant, sans conversion ni réécriture.

## 🔭 Vue d'ensemble

La tranche d'envoi a livré `mail_identities`, `mail_compose` et `mail_send`, avec sa garde de politique et son périmètre de destinataires.
Un seul de ces trois outils écrit un corps : `mail_send` soumet un brouillon existant par id et ne compose rien (`src/domains/mail/send.ts:41-49`).

Le corps est verrouillé sur une unique partie texte, décidée à la construction du brouillon (`src/domains/mail/compose.ts:306-307`).
La description de l'argument le dit à l'appelant : « Markdown is not rendered by mail clients » (`src/domains/mail/compose.ts:46-48`).

Le projet sait déjà manipuler du HTML des deux côtés : la lecture le dégrade en texte (`src/domains/mail/read.ts:161`), et la réponse d'absence accepte un corps HTML depuis la tranche Sieve (`src/domains/sieve/vacation.ts:89`).
L'envoi est le seul chemin resté en texte seul.

## ❌ Problème

L'utilisateur dicte une relance commerciale, une invitation, un compte rendu à puces.
Ce qui part est un bloc de texte brut : ni lien cliquable, ni gras, ni liste, ni séparation visible entre deux idées.

Le contournement n'existe pas côté appelant.
`EmailCreate` ne déclare aucune propriété de corps HTML (`src/jmap/types/mail.ts:252-264`), donc aucune forme d'appel ne peut en faire partir un — l'argument `body` étant par ailleurs obligatoire.

Le coût est une rupture d'usage : pour un message qui doit être présentable, l'utilisateur rouvre son client mail et recopie.
La tranche d'envoi perd alors exactement ce qu'elle promettait, écrire sans changer d'outil.

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Rédiger en HTML | Un corps HTML part et s'affiche mis en forme |
| Fournir le HTML directement | Un argument dédié, aucune conversion intermédiaire |
| Envoyer le HTML intact | Ce qui arrive est ce qui a été fourni, à l'octet |
| Laisser le texte seul possible | Un appel sans HTML produit le message d'aujourd'hui |
| Nommer le format avant l'envoi | La confirmation dit en quoi le message part |
| Refuser un message sans corps | Aucun brouillon vide écrit par omission |

Le quatrième objectif est une contrainte de non-régression : la tranche ajoute une possibilité, elle n'en retire aucune.
Le cinquième est la conséquence directe du choix de ne rien filtrer, énoncé plus bas.

## 🚫 Hors périmètre

- **La conversion Markdown.** L'appelant écrit du HTML, l'outil n'en produit aucun.
- **L'assainissement.** Aucune balise n'est retirée, réécrite ni refusée : le corps voyage tel quel.
- **Le repli texte automatique.** Rien n'est dérivé d'un corps HTML pour en tirer une partie texte.
- **La réécriture d'un brouillon.** Corriger un corps déjà écrit reste hors d'atteinte ; on recompose.
- **`mail_send`.** Il ne touche à aucun corps, et cette tranche ne lui en donne pas la charge.
- **Les signatures d'identité.** `htmlSignature` n'est pas lue aujourd'hui (`src/domains/mail/submission.ts:40`) et ne le devient pas.
- **Les pièces jointes et les images incorporées.** Déjà hors périmètre de la tranche d'envoi, elles le restent.
- **La lecture.** `mail_read` continue de dégrader le HTML reçu, sans changement.

## 👤 User stories

- En tant qu'utilisateur, je veux faire rédiger un message mis en forme, afin qu'un destinataire professionnel reçoive autre chose qu'un bloc de texte.
- En tant qu'utilisateur, je veux fournir le HTML exact que je souhaite voir partir, afin qu'aucune conversion ne décide de mon rendu à ma place.
- En tant qu'utilisateur, je veux que rien ne soit retiré de mon HTML, afin que le message reçu soit celui que j'ai relu.
- En tant qu'utilisateur, je veux continuer à dicter un message simple sans penser au format, afin que la mise en forme reste une option et jamais une obligation.
- En tant qu'utilisateur, je veux savoir, au moment de confirmer, si le message part en HTML, afin de ne pas découvrir le format une fois le message chez le destinataire.
- En tant qu'utilisateur, je veux relire un brouillon HTML dans mon client mail habituel, afin de juger le rendu avant l'envoi.
- En tant qu'utilisateur, je veux répondre en HTML dans un fil existant, afin que la mise en forme ne me coûte pas le rattachement au fil.
- En tant qu'utilisateur, je veux qu'un appel sans aucun corps échoue, afin qu'aucun message vide ne parte en mon nom.

## ✅ Critères d'acceptation

- Un appel qui ne donne pas de corps HTML produit exactement le message d'aujourd'hui : une seule partie texte, rien d'autre de changé.
- Un appel qui donne un corps HTML seul produit un message que le client mail de l'utilisateur affiche mis en forme.
- Un appel qui donne les deux corps produit un message dont chaque client affiche la partie qu'il sait lire.
- Un appel qui ne donne ni l'un ni l'autre est refusé en le disant, et rien n'est écrit dans le compte.
- Le HTML reçu par le destinataire est celui qui a été fourni : aucune balise retirée, aucune ajoutée, aucun attribut réécrit.
- La confirmation d'envoi nomme le format du corps avant que le message ne parte.
- Un brouillon HTML est visible et lisible dans le client mail de l'utilisateur, et `mail_send` l'expédie sans le modifier.
- Une réponse en HTML reste rattachée à son fil d'origine, et le message d'origine reste intact.
- Un serveur qui refuse un corps HTML fait échouer l'appel avec une cause nommée, sans laisser de brouillon derrière lui.
- La surface d'outils exposés reste inchangée : aucun outil ajouté, aucun retiré.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Stalwart accepte un corps HTML à la création d'un message | À constater sur l'instance, jamais éprouvé ici |
| Capacités `mail` et `submission` | Inchangées, déjà requises par la tranche d'envoi |
| Client MCP sachant confirmer | Inchangée : seul l'envoi la réclame, la rédaction non |
| Un destinataire d'essai sûr | Un envoi validé sort de la machine et ne se rattrape pas |

La première dépendance est la seule inconnue technique de la tranche, et elle se lève par un essai unique contre le serveur.
Elle n'est pas supposée acquise : rien dans le projet n'a jamais écrit de corps HTML sur un message.

L'ajout d'un argument optionnel n'est pas une rupture au sens du versionnage du paquet, la surface publique étant le nom des outils et la sémantique des classes (`aidd_docs/memory/package.md`).
La tranche part donc en version mineure, avec son changeset.

## ❓ Questions ouvertes

| Question | Ce qu'elle déplace |
| --- | --- |
| Un message HTML sans partie texte | Ce que voient les clients qui n'affichent que du texte |
| Ce que la confirmation montre du corps | Le seul garde-fou restant avant un envoi non filtré |
| La signature HTML de l'identité | Une tranche ultérieure, ou jamais |

La première question est une contrepartie assumée, pas un oubli : un destinataire en client texte reçoit un message dégradé par son propre client, ou rien de lisible selon celui-ci.
L'appelant garde la main — il peut fournir les deux corps — mais rien ne l'y oblige, et c'est le choix qui a été fait.

La deuxième est ouverte parce que le HTML ne passe par aucun filtre : la phrase de confirmation est ce qui reste entre un corps rédigé par un modèle et un message signé par l'utilisateur.
Nommer le format est acquis ; montrer le corps, ou une part du corps, reste à trancher.
