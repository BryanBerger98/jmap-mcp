---
title: PRD — Classer, marquer et supprimer ses mails
status: draft
updated: 2026-08-31
owner: bryan
---

# PRD — Classer, marquer et supprimer ses mails

Troisième tranche de jmap-mcp : l'assistant range la boîte de son utilisateur, en déplaçant, marquant, mettant à la corbeille, détruisant, et en gérant l'arborescence des dossiers.
Elle est la première à emprunter la classe `destroy`, la seule des quatre encore jamais parcourue.

## 🔭 Vue d'ensemble

L'assistant sait lire (`mail_search`, `mail_read`, `mail_folders`) et écrire (`mail_compose`, `mail_send`, `mail_identities`), soit six outils sur les vingt-six visés.
Il ne sait rien ranger : `mail_search` rend une colonne `id` (`src/domains/mail/search.ts:155`) qu'aucun outil ne consomme pour agir.

Le scénario qui pilote le projet depuis l'origine s'arrête à mi-parcours.
« Résume-moi mes newsletters » aboutit, « supprime-les » n'a pas d'outil, et le brainstorm désigne la suppression comme « le geste qui compte » (`aidd_docs/tasks/2026_08/2026_08_29_newsletters-slice-1/brainstorm.md:14`).

Cette tranche est donc celle qui rend le projet utilisable au quotidien : sans elle, l'assistant produit du texte et n'allège jamais la boîte.

## ❌ Problème

L'utilisateur veut dire « archive tout ça » ou « supprime-les » après un résumé, et voir sa boîte allégée sans rouvrir son client mail.
Aujourd'hui la conversation s'arrête au constat : l'assistant sait exactement quels messages sont concernés, et ne peut pas y toucher.

Trois manques rendent le rangement impossible ou imprudent.
Aucun outil ne patche `mailboxIds` ni `keywords` : `src/domains/mail/` ne contient que de la lecture et de la rédaction.
La classe `destroy` n'a jamais été exercée alors qu'elle vaut `confirm` par défaut (`src/config/policy.ts:24`), donc le refus attendu et le libellé de sa confirmation restent à écrire.
Et rien ne protège de l'ampleur : une destruction sur critère, ou un dossier supprimé avec ses messages, efface plus que ce que l'utilisateur a vu.

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Classer un message | Il change de dossier |
| Marquer lu, non lu, suivi | Le compteur de `mail_folders` bouge |
| Mettre à la corbeille | Le message reste retrouvable |
| Détruire définitivement | Aucune destruction sans confirmation explicite |
| Gérer l'arborescence | Créer, renommer, déplacer, supprimer un dossier |
| Agir sur un lot | Une confirmation pour un lot nommé |
| Soumettre un rangement massif | Passé vingt messages, il se confirme |
| Ne jamais agir sur un critère | Les outils d'écriture prennent des identifiants |
| Ne jamais détruire en cascade | Supprimer un dossier n'emporte aucun message |
| Rendre l'échec partiel lisible | Le traité se distingue du refusé |

Ranger et détruire sont deux gestes de nature différente, et la corbeille est le premier, pas le second.
Le volume est la seule exception : au-delà du seuil, l'ampleur d'un geste réversible justifie une question, faute de quoi deux cents messages changent de dossier sans que rien ne le signale.

Le seuil ne couvre que ce dont l'état antérieur est coûteux à retrouver, donc le déplacement et la corbeille.
Marquer ne perd rien et se défait d'un geste inverse : le volume n'y change pas la nature de l'opération.

## 🚫 Hors périmètre

- L'annulation d'une destruction : rien ne rattrape un `Email/set` destroy.
- Un geste dédié pour vider la corbeille : chercher dans `trash` puis passer les identifiants au lot le couvre déjà.
- Une confirmation sur le marquage, quel qu'en soit le volume.
- Les règles de tri automatiques : elles relèvent de Sieve, module 10.
- Le partage d'un dossier, porté par `shareWith`, module 11.
- L'import de messages (`Email/import`) et les pièces jointes, module 9.
- Les mots-clés personnalisés : seuls les mots-clés standards sont exposés.
- Le déplacement entre comptes : `Email/copy` ne sert qu'au multi-compte, hors périmètre.
- La création automatique d'un dossier manquant : l'outil n'écrit jamais dans l'arborescence sans demande.
- Les cinq autres domaines.

## 👤 User stories

- En tant qu'utilisateur, je veux faire classer un message dans un dossier, afin de vider ma boîte de réception sans changer d'outil.
- En tant qu'utilisateur, je veux marquer des messages comme lus sans qu'on me le fasse confirmer, afin de faire retomber un compteur d'un seul geste.
- En tant qu'utilisateur, je veux mettre à la corbeille ce dont je doute, afin de pouvoir revenir en arrière depuis mon client mail.
- En tant qu'utilisateur, je veux supprimer définitivement ce que j'ai vu listé, afin de ne pas accumuler ce que je ne relirai jamais.
- En tant qu'utilisateur, je veux qu'une destruction me soit soumise en nommant ce qui part, afin de mesurer ce que j'autorise.
- En tant qu'utilisateur, je veux être consulté quand un rangement déplace beaucoup de messages, afin qu'aucun geste massif ne me surprenne.
- En tant qu'utilisateur, je veux régler le volume à partir duquel on me consulte, afin que la prudence du serveur corresponde à ma façon de travailler.
- En tant qu'utilisateur, je veux que l'assistant refuse de détruire sur un critère de recherche, afin qu'aucun message que je n'ai pas vu ne disparaisse.
- En tant qu'utilisateur, je veux agir sur les résultats d'une recherche en un geste, afin de ne pas confirmer quarante fois la même intention.
- En tant qu'utilisateur, je veux créer et renommer mes dossiers, afin d'installer un classement que l'assistant peut ensuite suivre.
- En tant qu'utilisateur, je veux que supprimer un dossier n'emporte jamais son contenu, afin qu'un rangement ne devienne pas une perte.
- En tant qu'utilisateur, je veux savoir ce qui a échoué dans un lot, afin de ne pas croire terminé un rangement à moitié fait.

## ✅ Critères d'acceptation

- Un message classé est visible dans le dossier cible depuis le client mail, et absent de l'ancien.
- Marquer lu fait baisser le compteur de non-lus rendu par `mail_folders`, sans toucher au contenu du message, et sans jamais demander de confirmation.
- Un message mis à la corbeille reste consultable dans le dossier de rôle `trash`.
- Un déplacement ou une mise à la corbeille portant sur plus de vingt messages est soumis à confirmation, qui annonce leur nombre et le dossier cible. La valeur du seuil est réglable dans la configuration.
- Une destruction définitive n'aboutit qu'après une confirmation qui nomme le nombre de messages et leur objet.
- Un refus de confirmation laisse la boîte strictement inchangée, et aucune requête d'écriture n'est émise.
- Sur un client qui ne sait pas demander de confirmation, la destruction échoue avec une cause nommée, et rien n'est émis.
- Aucun outil d'écriture n'accepte de critère de recherche : une intention formulée sans identifiants est refusée en le disant.
- Un appel portant plus de cinquante identifiants est refusé avant toute écriture, en indiquant comment découper le lot.
- Sur un compte dépourvu de dossier de rôle `trash`, la mise à la corbeille échoue en nommant cette cause, sans rien détruire ni créer.
- Supprimer un dossier non vide échoue en nommant le nombre de messages qu'il contient, et n'en détruit aucun.
- Un dossier portant un rôle (`inbox`, `drafts`, `sent`, `trash`) ne peut être ni supprimé ni renommé, l'outil le refusant lui-même.
- Créer un dossier dont le nom existe déjà sous le même parent échoue en le nommant.
- Un lot dont une partie échoue distingue les messages traités des autres, sans annoncer un succès global, y compris si le serveur les rejette tous.
- Un serveur annonçant `mail` sans `submission` expose les outils de rangement au même titre que ceux de lecture.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Capacité `mail` seule | Acquise, aucune nouvelle capacité |
| Dossier de rôle `trash` sur le compte | Constaté à l'usage, son absence refuse |
| Client MCP sachant confirmer | Levé, Claude Code élicite |
| Jeton bearer d'`alfred@bryanberger.dev` | Hérité du module 2 |
| Alias `newsletters@bryanberger.dev` peuplé | Donnée de validation du scénario d'acceptation |

Le module ne dépend pas de la tranche d'envoi : il aurait pu la précéder.
Les deux tranches ne se croisent qu'au moment de la validation réelle, le scénario newsletters exigeant les modules 1, 2 et 4.

## ❓ Questions ouvertes

Aucune décision produit ne reste en suspens.
Deux faits restent à constater sur l'instance, sans bloquer la construction : la présence d'un dossier de rôle `trash` sur le compte d'Alfred, et le comportement de Stalwart sur un lot dont une partie échoue.

Le second est neutralisé par choix : l'outil rend toujours le détail de ce qui a bougé, que le serveur applique le tout-ou-rien ou non.
JMAP n'offre aucune transaction, donc défaire un lot à moitié appliqué serait une seconde écriture susceptible d'échouer à son tour.

La feuille de route fixe quatre outils : `mail_move`, `mail_flag`, `mail_delete`, `mailbox_manage`.
Le budget passerait de six à dix outils exposés sur vingt-six, et non onze, la table du budget comptant encore `jmap_session_info`, retiré depuis (`aidd_docs/ROADMAP.md:203`, `:209`).

> [!NOTE]
> `mailbox_manage` a été renommé `mail_folder_manage` pendant cette même tranche (`aidd_docs/tasks/2026_08/2026_08_31_mail-organizing/plan.md:51`, `aidd_docs/ROADMAP.md:105`).
