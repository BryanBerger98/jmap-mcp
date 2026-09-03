---
objective: "Une personne qui découvre le paquet obtient un jeton sur son Stalwart, enregistre le serveur dans Claude Code, Claude Desktop ou Cursor, comprend ce que chaque outil fait et quand il demande confirmation, et trouve la cause d'un refus sans lire le code."
title: Plan — Documentation du MCP et de son usage
status: in-progress
updated: 2026-09-03
owner: bryan
---

# Plan — Documentation du MCP et de son usage

## 🎯 Overview

| Champ | Valeur |
| --- | --- |
| **But** | Un dossier `docs/` en anglais, le `README.md` réduit à une page d'accueil qui y renvoie |
| **Source** | Texte brut : « Ajouter de la documentation pour décrire le MCP et son utilisation », forme tranchée par question posée |
| **Surface** | 29 outils avant, 29 après, aucun code touché |
| **Version** | Aucune : `docs/` ne part pas dans le paquet, aucun changeset |

Le `README.md` actuel porte déjà une table des 29 outils, la politique d'écriture et la configuration par variables, mais il tait quatre choses.
La clé `policy` du fichier de configuration existe — `src/config/schema.ts` — et n'est écrite nulle part ; l'enregistrement n'est montré que pour Claude Code ; rien ne dit comment obtenir le jeton côté Stalwart ; aucun refus n'est expliqué à la personne qui le reçoit.

Un seul fait vérifié cette session déplace le contenu prévu : la doc officielle de Stalwart dit qu'une clé API ne sert que l'API de gestion, et son code dit l'inverse.
`crates/common/src/auth/authentication.rs:300-311` reconnaît un bearer préfixé `API_` et le valide comme une credential du compte, et `crates/common/src/auth/access_token.rs:146-172` lui donne les permissions du compte en mode `Inherit`, donc `jmap*` compris.
Ce fichier existe sur le tag `v0.16.19`, la version relevée dans `external/stalwart-jmap.md`.
La page sur le jeton est donc écrite sur ce que le code accepte, et sa phase exige un `curl` réel avant de l'affirmer.

## 🧭 Phases

| # | Phase | Fichier |
| --- | --- | --- |
| 1 | Le jeton et la mise en route par client | [`phase-1.md`](./phase-1.md) |
| 2 | La configuration, la politique d'écriture, les limites et le dépannage | [`phase-2.md`](./phase-2.md) |
| 3 | La référence des vingt-neuf outils, domaine par domaine | [`phase-3.md`](./phase-3.md) |
| 4 | Le README en page d'accueil, l'index et la mémoire | [`phase-4.md`](./phase-4.md) |

L'ordre suit le chemin d'une première utilisation : sans jeton rien ne démarre, sans client rien ne s'appelle, et la référence n'a de lecteur qu'une fois le serveur branché.
Le README est réduit en dernier, parce qu'il ne peut renvoyer que vers des pages qui existent.

## 📚 Resources

Chaque source a levé une inconnue que le README ne tranchait pas.

| Source | Point tranché |
| --- | --- |
| [`code.claude.com/docs/en/mcp`](https://code.claude.com/docs/en/mcp) | Syntaxe de `claude mcp add` avec `--env`, `--scope`, `--transport stdio`, et le `--` avant la commande ; élicitation prise en charge |
| [`stalw.art/docs/auth/authentication/api-key/`](https://stalw.art/docs/auth/authentication/api-key/) | Création depuis le portail en libre-service, menu « API Keys » ; trois modes de permissions `Inherit`, `Disable`, `Replace` ; la phrase qui exclut JMAP |
| [`stalw.art/docs/auth/authentication/app-password/`](https://stalw.art/docs/auth/authentication/app-password/) | Un mot de passe d'application voyage en Basic, jamais en Bearer |
| [`stalw.art/docs/auth/oauth/endpoints/`](https://stalw.art/docs/auth/oauth/endpoints/) | `/auth/device`, `/auth/token`, `/.well-known/oauth-authorization-server` |
| [`stalw.art/docs/auth/oauth/flows/`](https://stalw.art/docs/auth/oauth/flows/) | Le flux d'appareil est le seul praticable sans navigateur de rappel |
| [`authentication.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/common/src/auth/authentication.rs) | Un bearer `API_…` est validé comme credential avant tout OAuth, lignes 300-311 |
| [`access_token.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/main/crates/common/src/auth/access_token.rs) | Une clé API hérite des permissions du compte, lignes 146-172 |
| [`credential.rs`](https://raw.githubusercontent.com/stalwartlabs/stalwart/v0.16.19/crates/common/src/auth/credential.rs) | Le parseur existe sur le tag `v0.16.19` |

**🔍 Ce que la contradiction change**

Un jeton d'accès OAuth expire en une heure par défaut, ce qui ferait d'un serveur configuré le matin un serveur muet l'après-midi.
Une clé API n'expire que si son créateur le décide, et c'est le seul bearer durable que le code accepte.
La page du jeton documente donc la clé API comme chemin principal, l'OAuth comme repli avec la durée `accessTokenExpiry` à rallonger, et aucun des deux n'est affirmé avant le `curl` de la phase 1.

**🔍 Ce que les clients font d'une confirmation**

Claude Code déclare l'élicitation et pose la question ; Claude Desktop ne la déclare pas, ce que `aidd_docs/backlog/spikes/elicitation-claude-desktop.md` tient à confiance moyenne.
Le refus qu'il reçoit alors est celui de `src/registry/compose.ts`, et la page de Claude Desktop le cite tel quel, puis montre `policy.send: deny` et `policy.destroy: deny` comme réponse : un outil dont chaque classe est refusée disparaît de la liste plutôt que d'échouer à chaque appel.

## ⚖️ Decisions

| Décision | Pourquoi |
| --- | --- |
| Les pages sous `docs/` sont en anglais, sans front-matter ni emoji de H2, et le vérificateur y tourne avec `--ignore=FM001,EMO001` | C'est l'exemption déjà accordée au `README.md` pour la même raison : une vitrine publique sur GitHub n'a que faire d'un contrat français, et GitHub rend un front-matter comme une table en tête de page |
| `docs/` ne part pas sur npm, le `README.md` reste la seule vitrine du registre | `package.json` ne livre que `dist/`, et un lecteur npm a besoin d'un lien vers `docs/`, pas d'une copie |
| Aucun changeset | Ni la configuration attendue, ni un nom d'outil, ni une classe ne changent |
| Un dossier par type Diátaxis : `getting-started/`, `reference/`, `explanation/`, et `troubleshooting.md` seul | Une page qui mélange procédure et référence se relit mal, et le type se lit alors sur le chemin puisque le front-matter n'est pas là pour le porter |
| Les exemples d'invite de la référence des outils décrivent ce que le texte de description promet, jamais un comportement observé sur un serveur | Les descriptions sont ce que le modèle lit ; un exemple qui promet plus qu'elles ment au lecteur avant le premier appel |
| Le nombre de phases suit le chemin de première utilisation, pas la taille des pages | Le README ne peut renvoyer que vers ce qui existe, et la référence n'a de lecteur qu'une fois le serveur branché |
