---
objective: "Un assistant branché sur jmap-mcp cherche, lit et situe les mails d'un compte Stalwart, sans qu'aucun outil d'écriture ne soit exposé."
status: implemented
---

# Plan: Lire son courrier depuis l'assistant

## Overview

| Field      | Value                                                                 |
| ---------- | --------------------------------------------------------------------- |
| **Goal**   | Trois outils de lecture mail exposés, contexte annoncé au démarrage    |
| **Source** | [`2026_08_30-mail-reading-prd.md`](../2026_08_30-mail-reading-prd.md) |

## Phases

| #   | Phase                            | File                         |
| --- | -------------------------------- | ---------------------------- |
| 1   | Contexte au démarrage            | [`phase-1.md`](./phase-1.md) |
| 2   | Types mail et `mail_folders`     | [`phase-2.md`](./phase-2.md) |
| 3   | `mail_search`                    | [`phase-3.md`](./phase-3.md) |
| 4   | `mail_read`                      | [`phase-4.md`](./phase-4.md) |

Chaque phase livre et se vérifie seule.
La phase 1 ne touche à aucun domaine : elle rend le démarrage observable avant tout outil, ce qui met le prérequis manuel du jeton bearer à l'épreuve dès la première passe.

## Resources

| Source                                                             | Verified                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `@modelcontextprotocol/server@2.0.0`, `ServerOptions.instructions`  | Le champ existe et le constructeur `McpServer` l'accepte                          |
| `@modelcontextprotocol/server@2.0.0`, signature de `registerTool`   | `annotations` est optionnel, aucun outil n'en dépend                              |
| [`stalwart-jmap.md`](../../../memory/external/stalwart-jmap.md)     | Filtres `Email/query`, propriétés lentes d'`Email/get`, plafonds serveur          |
| [`brainstorm.md`](../2026_08_29_newsletters-slice-1/brainstorm.md)  | Le repli d'alias est un filtre `header` sur `Delivered-To`                        |

## Decisions

| Decision                                                       | Why                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Contexte par `instructions`, pas par `jmap_session_info`        | Le client le reçoit à l'initialisation, sans appel, et le budget de vingt-six outils est préservé |
| Manifeste mail réduit à `urn:ietf:params:jmap:mail`             | Exiger `submission` ferait taire trois outils de lecture sur un serveur qui n'envoie pas      |
| Corps borné à 8 000 octets, cinq messages par lecture           | Plafonne une lecture à environ dix mille tokens, mesurable et ajustable par argument          |
| `deliveredTo` est un argument distinct, jamais déduit de `to`   | Stalwart abandonne une condition `header` mal formée sans erreur, le repli doit être explicite |

Le premier arbitrage tranche la contradiction que le PRD signale : la feuille de route prévoit `jmap_session_info` en classe `read`, le PRD exclut tout outil de diagnostic.
Les deux tiennent, parce que le besoin est de connaître le contexte, pas de le demander.
