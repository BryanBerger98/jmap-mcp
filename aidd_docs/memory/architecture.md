---
title: Architecture
status: draft
updated: 2026-08-31
owner: bryan
---

# Architecture

## 🧱 Stack

- Node et TypeScript, transport stdio, SDK MCP officiel.
- `zod` pour les schémas d'entrée des outils.
- Monolithe modulaire : la politique d'écriture s'applique en un point unique.
- Aucune base de données ni front-end. Stalwart est la source de vérité, le client MCP est l'interface.

## 🔗 Comment les pièces s'assemblent

Le diagramme suit un appel d'outil, du client MCP jusqu'à Stalwart.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
flowchart LR
    A([Client MCP]) -->|stdio| B[[Serveur MCP]]
    B --> C[Registre de composition]
    D[/Configuration/] --> C
    E[Session JMAP] --> C
    C --> F[[Modules de domaine]]
    F --> G[Garde de politique]
    G --> H[Client JMAP typé]
    H --> I([Stalwart])
    E --> H

    classDef violet fill:#f5f3ff,stroke:#8b5cf6,color:#4c1d95
    classDef bleu fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a
    classDef ambre fill:#fffbeb,stroke:#f59e0b,color:#78350f

    class A,I violet
    class B,C,D,E,F,H bleu
    class G ambre
```

## ⚖️ Décisions structurantes

- Le registre est le seul point qui croise les capacités de la session JMAP avec la politique configurée, et le seul qui décide quels outils sont enregistrés.
- La composition est statique : elle tourne une fois avant `connect()`, car la spécification interdit une liste d'outils qui varie en cours de session.
- Un module de domaine fournit une fonction qui classe l'appel d'après ses arguments, puis rend son résultat. Il ignore qu'il peut être désactivé ou soumis à confirmation.
- Quatre classes d'opération, trois niveaux chacune : `read` et `draft` en `allow`, `send` et `destroy` en `confirm`.
- Le client JMAP est écrit à la main : aucune bibliothèque TypeScript ne couvre Calendars, Contacts ni File Storage.
- Un fichier de types par spécification, les drafts Calendars et Filenode bougeant encore.
- Le périmètre des destinataires est une fonction pure d'un ensemble résolu et d'une liste d'adresses : la règle qui empêche un message de quitter le compte se teste sans serveur.

## 🛡️ Ce que traverse un envoi

Quatre filtres, dans cet ordre, tous dans le registre avant que l'outil ne tourne.

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'ui-sans-serif, system-ui, sans-serif','lineColor':'#94a3b8','primaryTextColor':'#334155'}}}%%
flowchart LR
    A([📥 Appel]) --> B{🚫 Politique}
    B -->|deny| R([❌ Refus])
    B -->|allow, confirm| C{📮 Périmètre}
    C -->|hors périmètre| R
    C -->|dedans| D{🙋 Élicitation}
    D -->|client sans MRTR| R
    D -->|confirmé| E([✅ run])

    classDef violet fill:#f5f3ff,stroke:#8b5cf6,color:#4c1d95
    classDef ambre fill:#fffbeb,stroke:#f59e0b,color:#78350f
    classDef bleu fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a

    class A,E violet
    class B,C,D ambre
    class R bleu
```

Le périmètre passe avant l'élicitation, par un hook `precheck` optionnel porté par la définition d'outil.
Un appel voué au refus quelle que soit la réponse ne doit pas être posé en question à l'utilisateur.

Le périmètre est résolu une seule fois, au démarrage, en lisant les fiches de contact du compte.
Il échoue fermé : capacité contacts absente, requête en erreur ou carnet trop volumineux rendent un périmètre `unreadable`, qui refuse tout, y compris une adresse que la liste `allow` nomme.

Quand une réponse ne nomme aucune adresse, le `precheck` lit lui-même le message source pour connaître son destinataire.
Lire coûte un aller-retour, mais l'alternative est de faire confirmer un envoi que `run` refusera de toute façon : le périmètre tranche avant l'élicitation, sans exception.

`mail_compose` et `mail_send` refont ensuite le contrôle dans `run`, sur les adresses réellement écrites.
La redondance est voulue : le `precheck` avale une lecture en échec plutôt que de transformer une erreur de transport en refus, donc le dernier mot sur les destinataires lui échappe.

## ⚠️ Pièges

- Le niveau `confirm` s'appuie sur MRTR. Quand le client ne l'expose pas, l'outil refuse : jamais d'exécution silencieuse.
- Claude Desktop ne supporte pas l'élicitation. Toute opération `send` ou `destroy` y échoue par conception.
- Les annotations MCP, `destructiveHint` en tête, sont déclarées non fiables. Elles documentent, elles ne gardent rien.
- La dégradation se voit dès trente outils exposés. Le gating par capacité vise vingt-six.
- La classe d'opération ne se lit pas sur le nom de la méthode. Un argument suffit à faire basculer une écriture en destruction ou en envoi, dans les six domaines.
- Une opération destructrice ne prend jamais un filtre en entrée. Stalwart abandonne silencieusement une condition `header` mal formée, et la requête rend alors plus de résultats que demandé.
- Le README de Stalwart n'est pas fiable sur les révisions de draft : Filenode y est resté à `-03` alors que le code est à `-14`. Le CHANGELOG et le code arbitrent.
