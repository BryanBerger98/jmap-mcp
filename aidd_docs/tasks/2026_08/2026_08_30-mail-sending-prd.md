---
title: PRD — Rédiger et envoyer un mail depuis l'assistant
status: draft
updated: 2026-08-30
owner: bryan
---

# PRD — Rédiger et envoyer un mail depuis l'assistant

Deuxième tranche de jmap-mcp : l'assistant rédige un message dans la boîte Stalwart de son utilisateur, puis l'expédie après confirmation explicite.
Elle fait franchir au projet le pas de la lecture à l'action irréversible.

## 🔭 Vue d'ensemble

La tranche précédente a livré une surface strictement en lecture : `mail_search`, `mail_read`, `mail_folders` (`src/domains/mail/index.ts:16`).
L'utilisateur peut demander un résumé, il ne peut pas répondre.

La garde de politique existe et sait demander une confirmation, mais aucun outil ne l'a jamais déclenchée : la classe `read` vaut `allow`, donc le chemin `confirm` n'a jamais été parcouru en réel (`src/config/policy.ts:21`, `src/registry/compose.ts:120`).

Cette tranche est donc autant une preuve d'architecture qu'une fonction : elle est la première à traverser la garde, et ce qu'elle établit sert ensuite aux six domaines.

## ❌ Problème

L'utilisateur veut dicter « réponds-lui que je décale à jeudi » et que le message parte, sans rouvrir son client mail ni recopier une adresse.
Aujourd'hui la conversation s'arrête au résumé : l'assistant sait tout du message reçu et ne peut rien en faire.

Trois manques rendent l'envoi impossible ou imprudent aujourd'hui.
Le serveur ne connaît ni les identités d'expédition ni la soumission : `src/jmap/types/mail.ts` s'arrête aux objets de lecture.
Le refus attendu quand le client MCP ne sait pas demander confirmation n'est écrit nulle part, aucune détection des capacités du client n'existant dans `src/`.
Et rien ne protégerait d'une adresse mal dictée : une lettre fausse envoie chez un inconnu, sans retour possible.

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Connaître ses expéditeurs | Les identités du compte sont listables |
| Rédiger sans envoyer | Un brouillon paraît dans `drafts` |
| Envoyer un brouillon relu | Il passe des brouillons aux envoyés |
| Rédiger et envoyer d'un trait | Un geste, une confirmation |
| Répondre dans un fil | La réponse rejoint le fil d'origine |
| Envoyer sur décision | Aucun envoi sans confirmation explicite |
| Échouer plutôt qu'envoyer | Un client sans confirmation obtient un refus |
| Borner les destinataires | Le périmètre autorisé est réglable |
| Annoncer la perte d'innocuité | Le contexte d'ouverture cesse de promettre la lecture seule |

Rédiger et envoyer sont deux gestes distincts, et leur enchaînement en est un troisième.
Le dernier objectif est déjà outillé : `scopeSentence` bascule dès qu'une classe autre que `read` devient joignable (`src/registry/instructions.ts:60`).

## 🚫 Hors périmètre

- Détruire, déplacer, étiqueter : le module 4 les porte.
- Détruire le brouillon après envoi : il est déplacé, pas supprimé, et `onSuccessDestroyEmail` reste interdit (`aidd_docs/ROADMAP.md:89`).
- L'envoi planifié : la tranche n'envoie qu'immédiatement, l'investigation est ouverte plus bas.
- Les pièces jointes, en lecture comme en ajout : le téléversement relève du module 9.
- Le suivi des envois passés et leur annulation : ni liste, ni `undoStatus`.
- La modification des identités et des carnets : ils se lisent, ils ne s'écrivent pas.
- Les cinq autres domaines, et le multi-compte.

## 👤 User stories

- En tant qu'utilisateur, je veux savoir depuis quelles adresses l'assistant peut écrire, afin de choisir celle qui convient à mon destinataire.
- En tant qu'utilisateur, je veux faire rédiger un brouillon sans qu'il parte, afin de le relire plus tard depuis mon client mail habituel.
- En tant qu'utilisateur, je veux envoyer un brouillon que j'ai relu, afin de valider un texte avant qu'il n'engage mon nom.
- En tant qu'utilisateur, je veux dicter et envoyer d'un seul geste, afin de ne pas subir deux échanges pour un message d'une ligne.
- En tant qu'utilisateur, je veux répondre à un message que l'assistant vient de me résumer, afin d'enchaîner sans changer d'outil.
- En tant qu'utilisateur, je veux que tout envoi me soit soumis, afin qu'aucun message ne parte à mon insu.
- En tant qu'utilisateur, je veux que l'assistant refuse d'envoyer plutôt que d'essayer, quand mon client ne sait pas me demander confirmation.
- En tant qu'utilisateur, je veux restreindre à qui l'assistant peut écrire, afin qu'une adresse mal comprise ne sorte pas de mon cercle connu.
- En tant qu'utilisateur, je veux être averti quand ma restriction rend l'envoi impossible, afin de ne pas la découvrir en essayant d'écrire.
- En tant qu'utilisateur, je veux retrouver dans mes envoyés ce qui est parti, afin de garder une trace de ce que l'assistant a écrit en mon nom.

## ✅ Critères d'acceptation

- Un message rédigé sans demande d'envoi est visible comme brouillon dans le client mail de l'utilisateur, et rien ne part.
- Un brouillon envoyé disparaît des brouillons et reste consultable dans les envoyés.
- Rédiger et envoyer d'un trait ne demande qu'une confirmation, et produit le même résultat que les deux gestes enchaînés.
- Aucun envoi n'aboutit sans que l'utilisateur ait vu, en une phrase, qui reçoit quoi.
- Un refus de confirmation laisse la boîte inchangée : le brouillon reste, rien ne part.
- Sur un client qui ne sait pas demander de confirmation, la demande d'envoi échoue avec une cause nommée, et aucune requête d'envoi n'est émise (`aidd_docs/memory/architecture.md:54`).
- Le message envoyé porte une adresse d'expédition que le serveur reconnaît comme appartenant au compte ; une autre est refusée avant émission.
- Une adresse absente du périmètre autorisé fait échouer l'envoi en la nommant, avant toute émission. Il n'existe aucun moyen de passer outre.
- Quand le périmètre est restreint et que les carnets sont illisibles, l'envoi est refusé, jamais autorisé par défaut.
- Un périmètre restreint dont les carnets sont vides est signalé comme tel, sans attendre une tentative d'envoi.
- Une réponse est rattachée au fil d'origine dans le client mail de l'utilisateur.
- Un serveur qui n'annonce pas l'envoi conserve les trois outils de lecture et n'expose aucun outil d'envoi.
- Dès l'ouverture, le contexte annonce que la session n'est plus en lecture seule.
- Le message d'origine reste intact après l'envoi de sa réponse.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Capacité `submission` annoncée | À constater sur l'instance |
| Au moins une identité sur le compte d'Alfred | Prérequis, à vérifier |
| Capacité `contacts` annoncée | Requise si le périmètre est restreint |
| Lecture des carnets d'adresses | Module 5 tiré en avance |
| Client MCP sachant confirmer | Levé, Claude Code élicite |
| Jeton bearer d'`alfred@bryanberger.dev` | Hérité du module 2, toujours requis |

Le garde-fou par carnet a un coût de périmètre assumé : il exige de lire les carnets, donc `AddressBook` et `ContactCard`, que la feuille de route range au module 5 (`aidd_docs/ROADMAP.md:112`).
La tranche en tire la seule lecture, sans rien exposer du domaine contacts.

La dépendance au client est levée : Claude Code déclare la capacité `elicitation` à son handshake, observée le 2026-08-30, donc la validation réelle de la tranche y est possible.
Claude Desktop et Claude.ai ne l'élicitent pas, sur faisceau documentaire, ce qui y condamne par conception toute opération `send` (`aidd_docs/backlog/spikes/elicitation-claude-desktop.md`).

Une adresse de destination sûre pour l'essai réel reste à choisir : un envoi validé sort de la machine et n'est pas rattrapable.

## ❓ Questions ouvertes

| Question | Ce qu'elle déplace |
| --- | --- |
| L'envoi planifié, et si Stalwart le fait | Un spike avant toute promesse |
| Le réglage par défaut du périmètre | L'expérience à l'installation |

L'envoi planifié se creuse en trois questions imbriquées, et la première mesure est gratuite : la capacité `submission` porte `maxDelayedSend`, dont la valeur `0` signifie que le serveur ne sait pas différer (RFC 8621 §1.3.2).
Reste à établir comment un client demande la planification, la RFC ayant donné trois lectures contradictoires, et si Stalwart l'implémente, le recensement n'en disant rien.

La feuille de route fixe trois outils pour ce module : `mail_compose`, `mail_send`, `mail_identities` (`aidd_docs/ROADMAP.md:84`).
Le troisième geste n'en ajoute pas un quatrième : rédiger et envoyer d'un trait est un argument qui fait basculer la rédaction en envoi, conforme au principe de classification par argument.
Le budget passe donc de trois outils exposés à six, sur une cible de vingt-six (`aidd_docs/ROADMAP.md:205`).
