---
title: Budget d'outils
status: draft
updated: 2026-09-02
owner: bryan
---

# Budget d'outils

## 📊 Le compte

Le chiffre vient du rapport de composition, capacités toutes présentes, jamais d'un décompte à la main dans les sources.

| Moment | Outils enregistrés |
| --- | --- |
| Avant le stockage de fichiers | 21 |
| Après | 25 |
| Après Sieve et l'absence | 28 |
| Après les partages | 30 |
| Après la fusion du rangement | 29 |
| Cible que le projet s'est donnée | 26 |

La cible est dépassée de trois, et c'est écrit ici tel quel plutôt qu'arrondi.
Les deux dernières lignes sont dans l'ordre où elles se sont produites : les partages ont porté le compte à trente, la fusion l'a ramené à vingt-neuf.

**🔒 Pourquoi la place n'a pas suffi**

Le module 10 porte deux manifestes de plus qu'une seule capacité ne le laisse croire, et trois outils là où le PRD en recommandait deux.
Fondre `vacation_manage` dans `sieve_write` aurait mis une lecture et une destruction sous un nom, ce que le troisième critère d'arbitrage interdit explicitement ci-dessous.
Le second obstacle est le gating : l'absence est portée par `urn:ietf:params:jmap:vacationresponse`, une capacité que Stalwart accorde par une permission distincte de celle des scripts, donc un outil unique aurait retiré l'absence aux comptes qui n'ont que celle-là.

Le module 11 a rencontré la même interdiction, et c'est ce qui l'a coûté deux places au lieu d'une.
La ROADMAP prévoyait une découpe par objet — les droits d'un côté, les notifications de l'autre — et cette découpe met une lecture et une destruction sous un même nom.
La découpe par classe la remplace : `sharing_access` lit, `sharing_manage` écrit, et la surface de lecture devient prouvable par contrat comme dans les cinq domaines précédents.

**⚡ Ce que le dépassement coûte réellement**

Le seuil de dégradation observé est trente, pas vingt-six : la cible était une marge, et vingt-neuf reste sous le seuil, d'une place.
Ce qu'un client donné voit est de surcroît borné par le gating — un serveur sans Sieve ni partages n'expose aucun des cinq outils des modules 10 et 11, et son compte reste à vingt-quatre.

## 🎯 D'où vient la cible

La dégradation de sélection se voit dès trente outils exposés : au-delà, le client choisit moins bien, et un outil de plus rend les vingt-neuf autres un peu moins fiables.
Vingt-six est la marge que le projet a prise sous ce seuil, pas une limite du protocole.

Ce qui compte est le nombre d'outils qu'un client donné voit, pas le total du dépôt.
Le gating par capacité en fait deux chiffres distincts : un serveur sans Sieve ni partages n'expose rien de ces deux domaines, et leur coût y est nul.

## ⚖️ La règle d'arbitrage

Trois critères, dans cet ordre. Le premier qui tranche arrête la lecture.

| Ordre | Critère | Ce qu'il tranche |
| --- | --- | --- |
| 1 | Une capacité qui peut manquer ne coûte rien | La capacité rare passe devant |
| 2 | Le verbe métier prime sur la méthode JMAP | Six méthodes font un outil |
| 3 | Un schéma discriminé fond deux outils en un | Un champ `action` remplace la paire |

Le troisième critère a déjà sa jurisprudence : `mail_folder_manage`, `contacts_book_manage`, `files_write` et `mail_organize` portent chacun plusieurs actions sous un discriminant.
Ce que le critère ne permet pas est de fondre une lecture et une destruction sous le même nom : la classe d'opération se lit sur l'appel, et un outil qui change de classe selon son `action` rend la politique illisible.
Le module 11 l'a confirmé plutôt qu'assoupli : c'est cette interdiction, et rien d'autre, qui a fait des partages deux outils au lieu d'un.
`sharing_manage` classe pourtant ses trois actions en `send` et `destroy`, ce qui n'est pas le mélange interdit : les deux passent par une confirmation, et aucune ne se fait passer pour une lecture.

## 🧭 Le dernier module, placé

Il ne reste rien à placer : les onze modules de la roadmap sont livrés, et le compte ci-dessus est définitif tant qu'aucun outil ne s'ajoute.

| Module | Surface retenue | Coût réel |
| --- | --- | --- |
| Partages | Droits sur `shareWith`, notifications | 2 outils |

> [!NOTE]
> La capacité peut manquer : `urn:ietf:params:jmap:principals` est annoncée par le serveur, et le critère 1 l'a mise devant un domaine que tout le monde voit.
> Aucun outil dédié aux principals n'a été retenu : une surface qui rend zéro par configuration coûterait une place sans rien montrer.

**📌 La fusion, faite plutôt qu'annoncée**

Le seul couple qui tenait les quatre conditions du critère 3 est fondu.

| Paire | Devenue | Ce que la fusion a coûté |
| --- | --- | --- |
| `mail_move` et `mail_flag` | `mail_organize` | Un schéma discriminé, et un `confirmWhen` qui branche sur l'action |

La nuance que ce document craignait de perdre est celle qui a survécu : marquer ne demande jamais confirmation, quel que soit le volume, et déplacer la demande au-delà du seuil.
Elle tient parce que `confirmWhen` lit l'action et non le seul compte d'identifiants — le premier du dépôt à le faire — et parce qu'un contrat l'éprouve sur le même volume dans les deux sens.

Deux autres paires reviennent naturellement — `contacts_search` avec `contacts_read`, `calendar_search` avec `calendar_read` — et aucune ne tient le critère : une recherche prend un filtre, pas des identifiants.

## 🚧 Si la place manque

Rien n'oblige à trancher au-delà de vingt-six par un refus.
Trois issues restent ouvertes, et les trois ont servi : le module 10 a pris la troisième, le module 11 les deux premières.

- Fondre deux verbes voisins sous un discriminant, tant qu'ils gardent la même classe d'opération.
- Laisser le gating faire le travail : un domaine derrière une capacité absente ne pèse que sur les serveurs qui l'annoncent.
- Assumer le dépassement en le mesurant, car le seuil est une marge et non une falaise.

Ce qui n'est pas une issue : retirer un outil déjà publié.
C'est une rupture semver, et le nom d'un outil est le contrat public du paquet.
Une fusion se décide donc avant la publication du paquet, ou pas du tout : les vingt-neuf outils actuels ne sont fusionnables que tant que rien ne les a exposés sous ces noms-là.
C'est la fenêtre que la fusion du rangement a utilisée, et elle se referme à la première publication.
