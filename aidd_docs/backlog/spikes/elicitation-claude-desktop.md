---
title: "Spike : élicitation dans les clients MCP cibles"
type: spike
status: resolved
updated: 2026-08-30
owner: bryan
source: aidd_docs/tasks/2026_08/2026_08_30-mail-sending-prd.md
parents:
  - aidd_docs/tasks/2026_08/2026_08_30-mail-sending-prd.md
---

# Spike : élicitation dans les clients MCP cibles

## ❓ Question

Quels clients MCP visés par le projet savent aujourd'hui répondre à une demande d'élicitation, et lesquels condamnent donc toute opération de classe `send` ?

## 🎯 Décision

Valider ou corriger l'affirmation portée par la mémoire projet, qui tient Claude Desktop pour incapable d'élicitation (`aidd_docs/memory/architecture.md:55`).

Cette affirmation n'a jamais été observée en session (`aidd_docs/tasks/2026_08/2026_08_30-mail-sending-prd.md:104`).
Elle décide sur quel client la tranche d'envoi peut être validée en réel, et ce que le message de refus doit dire à l'utilisateur.

## 📐 Bornes

| Preuve attendue | Où la chercher |
| --- | --- |
| Capacité déclarée par le client | Handshake `initialize` observé en session |
| Support annoncé par l'éditeur | Documentation officielle du protocole MCP |
| Comportement réel face au refus | Appel d'élicitation sur un serveur d'essai |

**Arrêt** : quand chaque client visé est classé « élicite » ou « n'élicite pas » sur preuve datée, la capacité annoncée au handshake faisant foi devant la documentation.

Hors bornes : la rédaction du message de refus, et le contournement de l'absence d'élicitation par un autre mécanisme de confirmation.

## 🔬 Investigation

| Tentative | Preuve | Résultat |
| --- | --- | --- |
| Handshake Claude Code | Serveur d'essai stdio, 2026-08-30 | ✅ `elicitation: {}` déclarée |
| Élicitation réelle Claude Code | `elicitation/create` mode formulaire | ✅ Répond, ici `action: cancel` |
| Provenance de la ligne Claude Code | PR `modelcontextprotocol#2398`, 2026-03-14 | ✅ Ajoute `Elicitation` à ses capacités |
| Matrice officielle MCP | `docs/clients.mdx`, révision `87993a68` | ⚠️ Desktop sans `Elicitation` |
| Fraîcheur de la matrice | `git log` du même fichier | ⚠️ Page supprimée le 2026-05-27 |
| Matrice tierce `canimcp.dev` | Consultée le 2026-08-30 | ❌ Desktop absent, source écartée |
| Comportement terrain Desktop | Issue `anthropics/claude-code#56243` | ⚠️ `action: cancel` immédiat |
| Demande de fonctionnalité Desktop | Issue `anthropics/claude-code#41110` | ❌ Close par automate, sans preuve |
| Handshake Claude Desktop | `claude_desktop_config.json` à modifier | ⏳ Écriture non autorisée |

**🔬 Détail des captures**

Le handshake de Claude Code annonce `protocolVersion: 2025-11-25`, `clientInfo.name: claude-code`, version `2.1.251`, et les capacités `roots` et `elicitation`.
La réponse à `elicitation/create` est arrivée en trois millisecondes : le mode `--print` n'offre aucune interface, donc le client annule sans demander.

La matrice officielle date du 2026-05-26 et la page a disparu le lendemain, sous le commit « Remove Example Clients overview page ».
Claude Code y liste `Elicitation`, Claude Desktop App liste `Resources, Prompts, Tools, Roots, Apps, DCR`.

L'issue `#56243` décrit un `elicitation/create` annulé sans dialogue sur la surface Cowork de Claude Desktop, le même serveur fonctionnant sous Claude Code.
L'issue `#41110`, qui demandait la fonctionnalité pour Desktop, a été close `COMPLETED` en un jour par un automate, sans commentaire humain ni version citée.

La matrice tierce `canimcp.dev`, datée du 2026-07-28, ne liste pas Claude Desktop comme client distinct et crédite Claude Code du mode `url`, que la capture du handshake et l'issue `#48164` démentent.
Elle n'apporte donc rien sur la question posée.

**🔍 Ce que la capture change**

Un `{ "action": "cancel" }` ne signale pas l'absence d'élicitation.
Claude Code, qui la déclare, répond exactement cela dès qu'aucune interface humaine n'est disponible.
Seule l'absence de la clé `elicitation` dans les capacités du `initialize` distingue « ne sait pas éliciter » de « a refusé ».

Claude Code annonce `elicitation: {}`, soit le mode formulaire seul au sens de la spécification `2025-11-25`.
C'est le mode dont la classe `send` a besoin ; le mode `url` reste cassé côté Claude Code (issue `#48164`, ouverte), mais il est hors sujet ici.

## 📊 Résultat

| Client | Verdict | Preuve | Confiance |
| --- | --- | --- | --- |
| Claude Code | Élicite | Handshake du 2026-08-30 | Élevée |
| Claude Desktop | N'élicite pas | Documentation et terrain | Moyenne |
| Claude.ai | N'élicite pas | Documentation seule | Moyenne |

**✅ Claude Code**

Preuve directe : la version 2.1.251 déclare `elicitation` au `initialize`, en mode formulaire.
La tranche d'envoi y est validable en réel, de bout en bout.

**❌ Claude Desktop**

Verdict prononcé sur faisceau, la mesure du handshake ayant été écartée par décision de l'utilisateur.
Deux sources convergent : la dernière matrice officielle MCP, et un rapport terrain décrivant une annulation immédiate sans dialogue.
L'affirmation de `aidd_docs/memory/architecture.md:55` est donc corroborée, pas démontrée.

**⚠️ Incertitude restante**

- La capacité déclarée par Claude Desktop n'a jamais été observée. Aucune source ne dépasse le 2026-05-27, date de suppression de la page officielle.
- Le comportement de Claude Code en mode interactif reste non mesuré : seul le mode `--print` a été capturé, où l'annulation est automatique.
- L'issue `#41110` close `COMPLETED` laisse une chance non nulle qu'une version récente de Desktop ait acquis la capacité sans que la documentation suive.

## 🔁 Suite

**⚡ Acquis pour la tranche d'envoi**

- Claude Code suffit à valider la tranche de bout en bout. La dépendance « client MCP sachant confirmer » du PRD cesse d'être bloquante.
- Le refus doit se décider sur l'absence de la clé `elicitation` au handshake, jamais sur un `action: cancel` reçu en réponse. Confondre les deux ferait passer une annulation volontaire pour une incapacité du client.
- Le message de refus vise Claude Desktop et Claude.ai, et sa rédaction reste hors bornes de ce Spike.

**🔧 Reprise possible**

Déclarer le serveur d'essai dans `claude_desktop_config.json`, relancer Claude Desktop, capturer son `initialize`.
Cette mesure lèverait l'incertitude restante ; elle touche la configuration personnelle de l'utilisateur et lui revient.
