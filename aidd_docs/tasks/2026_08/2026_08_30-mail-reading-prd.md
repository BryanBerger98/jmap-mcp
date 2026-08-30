---
title: PRD — Lire son courrier depuis l'assistant
status: draft
updated: 2026-08-30
owner: bryan
---

# PRD — Lire son courrier depuis l'assistant

Première tranche utilisable de jmap-mcp : l'assistant se connecte à la boîte Stalwart de son utilisateur, y cherche des mails et en restitue le contenu.
Elle transforme un socle technique déjà écrit en un usage réel, sans jamais rien modifier côté serveur.

## 🔭 Vue d'ensemble

L'art antérieur couvre déjà la lecture du mail : ce qui manque, c'est la couverture des six domaines et une politique qui encadre chaque opération irréversible.
— `aidd_docs/memory/project-brief.md:20`

Le socle de connexion et la garde de politique existent déjà en dépôt, mais aucun outil n'est exposé au client MCP : les six manifestes de domaine portent `tools: []`.

Cette tranche livre la première valeur observable, en lecture seule.
Elle sert aussi de preuve d'usage pour les cinq domaines suivants : si chercher et lire un mail ne tient pas, rien d'autre ne tiendra.

## ❌ Problème

L'utilisateur veut demander « résume-moi ce que j'ai reçu sur cette adresse » et obtenir une réponse fondée sur ses vrais mails.
Aujourd'hui il ouvre son client mail, trie à la main, et copie-colle le contenu dans une conversation, ce qui expose plus de données que nécessaire et coûte plusieurs minutes par tri.

Le serveur n'expose rien, et son démarrage n'a jamais été observé en réel : la découverte de session précède la construction du serveur, et le jeton bearer n'existe pas encore.
— `src/server.ts:18`, `aidd_docs/memory/external/stalwart-jmap.md:16`

## 🎯 Objectifs

| Objectif | Mesure |
| --- | --- |
| Connaître le contexte | Compte et domaines connus dès l'ouverture |
| Retrouver des mails | Recherche par expéditeur, destinataire ou date |
| Lire un message | Corps en texte lisible, taille bornée |
| Situer les messages | Liste des dossiers consultable |
| Échouer clairement | Le démarrage échoué nomme sa cause |

Le scénario d'acceptation existant couvre le résumé puis la purge, et valide les modules 1 à 4.
Cette tranche n'en atteint que la première moitié : « résume-moi mes newsletters » aboutit, « supprime-les » relève du module 4.
— `aidd_docs/tasks/2026_08/2026_08_29_newsletters-slice-1/brainstorm.md:13`

## 🚫 Hors périmètre

- Toute écriture : envoyer, supprimer, déplacer, étiqueter.
- Les cinq autres domaines : agendas, contacts, fichiers, partages, Sieve.
- Le multi-compte : un serveur, un compte.
- Le téléchargement des pièces jointes.
- Tout outil de diagnostic de session : le contexte est fourni au démarrage, pas sur demande.
- L'élicitation et la confirmation utilisateur, la classe `read` valant `allow` dans la politique par défaut (`src/config/policy.ts:20`).

> [!WARNING]
> Cette exclusion contredit la feuille de route, dont le module 1 prévoit `jmap_session_info` en classe `read`.
> L'arbitrage reste à faire.

— `aidd_docs/ROADMAP.md:57`

## 👤 User stories

- En tant qu'utilisateur, je veux que l'assistant sache d'emblée à quelle boîte il est connecté, afin de savoir que je pilote la bonne.
- En tant qu'utilisateur, je veux retrouver les mails reçus sur une de mes adresses, afin d'en faire le tri sans ouvrir mon client mail.
- En tant qu'utilisateur, je veux que l'assistant lise le contenu d'un message, afin d'en obtenir un résumé fidèle.
- En tant qu'utilisateur, je veux connaître mes dossiers, afin de cibler une recherche sur l'un d'eux.
- En tant qu'utilisateur, je veux savoir qu'une liste de résultats est incomplète, afin de ne pas conclure sur une liste tronquée.
- En tant qu'utilisateur, je veux un message explicite quand la connexion échoue, afin de corriger mon jeton ou mon URL sans lire de trace technique.

## ✅ Critères d'acceptation

- Une demande de résumé sur une adresse donnée produit un résumé fondé sur des mails réellement présents dans la boîte.
- Dès l'initialisation, l'assistant nomme le compte connecté et les domaines annoncés, sans avoir appelé d'outil.
- La liste des outils exposés au client ne contient que des opérations de lecture.
- Une recherche qui dépasse le budget de résultats le signale et permet de demander la suite.
- Le contenu rendu est du texte lisible, jamais une réponse brute du serveur.
- Un domaine que le serveur n'annonce pas ne produit aucun outil exposé. Le manifeste mail exige aujourd'hui `mail` et `submission` alors que la tranche n'envoie rien (`src/domains/mail/index.ts:7`).
- Un jeton invalide ou une URL injoignable arrête le démarrage avec une cause nommée.
- Un message sans corps texte reste lisible plutôt que vide.

## 🔗 Dépendances

| Dépendance | Nature |
| --- | --- |
| Instance Stalwart joignable | Déjà satisfaite |
| Jeton bearer d'`alfred@bryanberger.dev` | Prérequis manuel, à créer |
| Alias `newsletters@bryanberger.dev` | Donnée de validation réelle |
| Client MCP hôte | Claude Code ou Claude Desktop |

Sans jeton, la tranche ne se vérifie que sur fixtures.
L'alimentation de l'alias n'est vérifiée nulle part : elle se constate au premier appel réel.

## ❓ Questions ouvertes

| Question | Ce qu'elle déplace |
| --- | --- |
| Budget de tokens d'une lecture | `maxBodyValueBytes`, puis `isTruncated` |
| Nombre d'outils de lecture | Consommation du budget de vingt-six |
| Réécriture de `To:` par l'alias | Repli sur le filtre `header` |

Le critère `to` est une condition de filtre exécutée par Stalwart : ce qui reste ouvert est le comportement de l'alias, tranchable sur instance réelle seulement.
Les en-têtes réellement indexés décident de la fiabilité du repli.
— `aidd_docs/memory/external/stalwart-jmap.md:97`, `:283`

La feuille de route fixe déjà trois outils pour ce module : `mail_search`, `mail_read`, `mail_folders`.
— `aidd_docs/ROADMAP.md:71`
