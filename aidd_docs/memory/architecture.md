---
title: Architecture
status: draft
updated: 2026-09-01
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

Le périmètre est désormais observable avant d'être subi : sous un scope autre que `anyone`, `contacts_search` et `contacts_read` marquent chaque adresse rendue comme dedans ou dehors.
Le marquage ne change rien à la règle, il la donne à lire ; la même fonction `isWithinScope` sert l'affichage et le refus, sans quoi les deux dériveraient.
Il rappelle aussi que le périmètre est figé au démarrage, une fiche créée depuis n'y entrant qu'après un redémarrage.

## 🔁 Le second chemin vers la confirmation

La classe dit ce que l'appel fait, jamais combien il en fait.
Déplacer deux cents messages reste un `draft` : le classer `destroy` pour forcer la question mentirait à l'utilisateur à l'instant précis où il arbitre.

Une définition d'outil porte donc un hook `confirmWhen` optionnel, qui rend la raison pour laquelle cet appel-là mérite une question que sa classe n'exige pas.
Cette raison s'affiche à la place de la classe, « ceci est une opération de brouillon » n'expliquant rien sur un volume.

L'ordre des hooks ne s'inverse jamais :

```txt
precheck → confirmWhen → élicitation → run
```

`confirmWhen` n'est consulté qu'au niveau `allow` : à `confirm` la question est déjà posée, à `deny` il n'y a rien à demander.
Il suit `precheck` pour la raison qui vaut déjà pour le périmètre des destinataires : un appel voué au refus ne se fait pas confirmer.

Le seuil est `bulkConfirmAbove`, porté par le contexte et non lu par le registre, car seul l'outil sait ce que ses arguments comptent.
Un plafond dur de cinquante identifiants par appel s'y ajoute, non réglable, et refuse avant toute question.

## ✍️ Ce qu'une correction touche

Une écriture de fiche part en `PatchObject` sur les seuls chemins que l'appel a nommés.
Envoyer l'objet complet effacerait ce que la lecture ne rend pas : `ContactCard/get` peut répondre partiellement, et une propriété absente d'un objet complet vaut suppression.
La création est le seul cas qui envoie un objet entier, puisqu'il n'y a rien à préserver.

Deux règles du patch se tiennent avant la requête, pas sur le fil.
Un patch préfixe d'un autre est invalide (RFC 8620 §5.3) : remplacer une famille de champs et l'amender dans le même appel est refusé ici plutôt que renvoyé en `invalidPatch`.
Les clés d'une entry-map sont opaques, donc une adresse se retire par sa valeur et jamais par sa clé, que le serveur choisit.

La non-cascade porte désormais deux drapeaux, `onDestroyRemoveEmails` sur un dossier et `onDestroyRemoveContents` sur un carnet.
Le second est obligatoire dans le type des arguments : une branche qui l'oublierait ne compile pas, et le contrat le vérifie quand même, pour le jour où le type serait assoupli.

Le périmètre des destinataires ne s'élargit pas en cours de session.
Créer une fiche avec `contacts_write` n'ouvre rien : le périmètre est résolu une fois au démarrage, et l'adresse n'y entre qu'au redémarrage suivant.

## 📅 Ce qu'une disponibilité traverse

`Principal/getAvailability` est le seul chemin propre vers une disponibilité, et Stalwart le referme par défaut : sans `allowDirectoryQueries`, la permission est retirée du jeton et la méthode répond `forbidden`.
La capacité est pourtant annoncée sans condition, donc le gating par capacité ne protège de rien ici : seul un repli tient la promesse de l'outil.

```txt
Principal/getAvailability
  → réponse           → plages fusionnées
  → forbidden         → repli : Calendar/get + CalendarEvent/query déplié
  → toute autre erreur → remontée telle quelle
```

Seul `forbidden` ouvre le repli. Une panne de transport ou une autre erreur de méthode voyage jusqu'à l'appelant : répondre depuis les agendas à la place d'une requête qui n'a jamais tourné rendrait une réponse sûre d'elle et sans fondement.

Le repli dit toujours ce qu'il ne voit pas : les agendas partagés par un tiers, et la nuance `includeInAvailability: "attending"` traitée comme `all` faute de pouvoir juger l'assistance sans lire la liste des participants.
Les deux écarts sous-déclarent le temps occupé, soit la direction qui trompe : un créneau annoncé libre peut ne pas l'être.

La fenêtre est refusée avant qu'aucune méthode ne parte, sur les bornes en heure locale et avant même que le fuseau soit résolu.
Ce contrôle n'existe que pour devancer un refus que le serveur prononcerait de toute façon, et une heure de décalage ne change aucun verdict qu'il rend.

## ✉️ Ce qu'une écriture d'agenda expédie

Trois outils écrivent dans un agenda, et chacun peut faire partir un mail sans qu'une méthode le dise : `sendSchedulingMessages` en décide, sur le `CalendarEvent/set` qui écrit l'événement.
L'argument est donc écrit sur chaque appel émis, y compris ceux où il vaut faux : un défaut serveur n'est pas une garantie, et son absence ne se voit sur aucun test unitaire.

La classe se lit sur `notify`, jamais sur le nom de l'outil.
`calendar_write` et `calendar_respond` passent de `draft` à `send` selon lui ; `calendar_delete` reste `destroy` dans les deux cas, prévenir élargissant qui l'apprend sans adoucir ce que l'appel fait.

C'est ce dernier qui ouvre un trou que le registre ne peut pas voir : il classe l'appel une fois, donc une politique `send: deny` laisserait passer une annulation expédiée sous couvert de destruction.
`calendar_delete` lit donc `context.policy.send` lui-même et refuse avant toute question — c'est la raison d'être de `policy` dans le contexte d'outil.

Un `CalendarEvent/set` réussi ne prouve jamais qu'un mail est parti.
Stalwart avale l'envoi sans erreur quand iTIP est éteint, quand le compte n'a pas la permission de planification, ou quand l'événement est entièrement passé : les réponses disent ce qui a été demandé au serveur, jamais ce qu'il en a fait.

## ⚠️ Pièges

- Le niveau `confirm` s'appuie sur MRTR. Quand le client ne l'expose pas, l'outil refuse : jamais d'exécution silencieuse.
- Claude Desktop ne supporte pas l'élicitation. Toute opération `send` ou `destroy` y échoue par conception.
- Les annotations MCP, `destructiveHint` en tête, sont déclarées non fiables. Elles documentent, elles ne gardent rien.
- La dégradation se voit dès trente outils exposés. Le gating par capacité vise vingt-six.
- La classe d'opération ne se lit pas sur le nom de la méthode. Un argument suffit à faire basculer une écriture en destruction ou en envoi, dans les six domaines.
- Une opération destructrice ne prend jamais un filtre en entrée. Stalwart abandonne silencieusement une condition `header` mal formée, et la requête rend alors plus de résultats que demandé.
- Supprimer un dossier ne supprime jamais son contenu. `onDestroyRemoveEmails` est écrit à faux sur chaque `Mailbox/set` émis, y compris ceux qui ne détruisent rien : un défaut serveur n'est pas une garantie, et l'absence de l'argument ne se voit sur aucun test unitaire.
- Le README de Stalwart n'est pas fiable sur les révisions de draft : Filenode y est resté à `-03` alors que le code est à `-14`. Le CHANGELOG et le code arbitrent.
- Les fiches de contact ne se trient pas par nom. Stalwart rend `UnsupportedSort` sur `name`, seuls `created` et `updated` étant indexés pour l'ordre : une pagination stable n'a d'autre choix que la date de création.
- Les clés de `members` sont des `uid` de fiche, jamais des identifiants JMAP. Un outil qui reçoit des identifiants doit les traduire par une lecture, sans quoi le groupe pointe sur des membres inexistants et le serveur l'accepte sans broncher.
- Supprimer un carnet ne supprime jamais ses fiches, et rien ne les rattrape : les contacts n'ont pas de corbeille. Un carnet encore peuplé, le carnet par défaut et le dernier carnet restant sont refusés avant la requête.
- `expandRecurrences` exige les deux bornes. Sans fenêtre complète, Stalwart refuse le dépliage : une recherche sans dates rend des événements de base, et l'en-tête doit le dire plutôt que laisser croire à des occurrences.
- Le tri des événements ne connaît qu'un ordre stable. `created` et `updated` sont refusés hors dépliage, donc `start` ascendant est le seul tri que les deux modes acceptent.
- `recurrenceOverrides` ne se demande jamais avec `utcStart` ou `utcEnd`. Le draft interdit la combinaison, et le dépliage rend la question sans objet.
- `until` d'une règle de récurrence est une heure locale, pas un instant. La lire dans le fuseau de la réponse déplacerait une borne qui n'a pas de décalage à subir : seule sa date est affichée.
- `Temporal` est absent de Node 24. Toute conversion local vers UTC passe par `Intl.DateTimeFormat` et `formatToParts`, en deux passes pour tenir un changement d'heure.
- Une occurrence isolée ne s'écrit pas. Stalwart accepte un identifiant synthétique et transforme silencieusement l'écriture en plan d'instance, donc les trois outils d'écriture le refusent côté client sur `baseEventId` : corriger un mardi n'est pas corriger la série, et la réponse ne dirait pas lequel a eu lieu.
- La clé du participant que le compte occupe ne se devine pas. Zéro correspondance comme deux font refuser : prendre la première clé répondrait à la place de l'organisateur, et une réponse partie ne se rappelle pas.
- Les trois champs de nom retombent sur le même index. Filtrer sur `name`, `name/given` ou `name/surname` rend le même résultat, donc chercher un prénom seul est hors de portée du serveur et la description de l'outil doit le dire.
