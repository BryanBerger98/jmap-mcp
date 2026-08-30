---
title: Carte du code
status: draft
updated: 2026-08-29
owner: bryan
---

# Carte du code

> [!NOTE]
> L'arbre existe et compile. Le socle est écrit : configuration, client JMAP, session, registre, pagination, rendu.
> Les six domaines sont des manifestes à `tools: []` — aucun outil métier n'est encore implémenté.

## 🗺️ Découpe

Le diagramme montre les zones de `src/` et leur dépendance.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
flowchart TD
    A([index.ts]) --> B[server.ts]
    B --> C[registry]
    D[config] --> C
    E[jmap] --> C
    C --> F[domains]
    F --> G[shared]
    F --> E

    classDef neutre fill:#f8fafc,stroke:#94a3b8,color:#334155
    classDef bleu fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a

    class A,B neutre
    class C,D,E,F,G bleu
```

## 📂 Zones

| Zone | Responsabilité |
| --- | --- |
| `src/config/` | Schéma, chargement, politique d'écriture |
| `src/jmap/` | Session, client, erreurs, blobs, types |
| `src/registry/` | Définition d'outil, manifeste, composition |
| `src/domains/` | Les six domaines métier |
| `src/shared/` | Pagination et rendu compact |
| `tests/` | Unitaires, contrat, fixtures |

Les types JMAP vivent sous `src/jmap/types/`, un fichier par spécification.
Chaque domaine sous `src/domains/` regroupe ses outils par verbe métier, jamais par méthode JMAP.

## 🚪 Points d'entrée

- `src/index.ts` : exécutable déclaré par `bin.jmap-mcp`.
- `src/server.ts` : construit le `McpServer` et branche le transport stdio.
