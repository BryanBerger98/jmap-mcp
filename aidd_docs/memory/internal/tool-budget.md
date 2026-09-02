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
| Cible que le projet s'est donnée | 26 |

La cible est dépassée de deux, et c'est écrit ici tel quel plutôt qu'arrondi.

**🔒 Pourquoi la place n'a pas suffi**

Le module 10 porte deux manifestes de plus qu'une seule capacité ne le laisse croire, et trois outils là où le PRD en recommandait deux.
Fondre `vacation_manage` dans `sieve_write` aurait mis une lecture et une destruction sous un nom, ce que le troisième critère d'arbitrage interdit explicitement ci-dessous.
Le second obstacle est le gating : l'absence est portée par `urn:ietf:params:jmap:vacationresponse`, une capacité que Stalwart accorde par une permission distincte de celle des scripts, donc un outil unique aurait retiré l'absence aux comptes qui n'ont que celle-là.

**⚡ Ce que le dépassement coûte réellement**

Le seuil de dégradation observé est trente, pas vingt-six : la cible était une marge, et vingt-huit reste sous le seuil.
Ce qu'un client donné voit est de surcroît borné par le gating — un serveur sans Sieve ni partages n'expose aucun des trois outils du module 10, et son compte reste à vingt-cinq.

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

Le troisième critère a déjà sa jurisprudence : `mail_folder_manage`, `contacts_book_manage` et `files_write` portent chacun trois actions sous un discriminant.
Ce que le critère ne permet pas est de fondre une lecture et une destruction sous le même nom : la classe d'opération se lit sur l'appel, et un outil qui change de classe selon son `action` rend la politique illisible.

## 🧭 Ce qui reste à placer

Un module, et une place déjà dépassée. Le choix n'est pas fait ici : ce document laisse la règle et le compte, pas la décision.

| Module | Surface plausible | Coût |
| --- | --- | --- |
| Partages | Principals, droits, `shareWith` | 1 à 2 outils |

> [!NOTE]
> La capacité peut manquer : `urn:ietf:params:jmap:principals` est annoncée par le serveur, et le critère 1 la met devant un domaine que tout le monde voit.

**📌 Les candidats à la fusion, nommés sans être arbitrés**

Le module 11 hérite d'une règle, pas d'une place.
Un seul couple tient les quatre conditions du critère 3 — deux verbes voisins, de même classe, prenant des identifiants, dans un domaine déjà livré.

| Paire | Classe commune | Ce qui les rapproche |
| --- | --- | --- |
| `mail_move` et `mail_flag` | `draft` | Un lot d'identifiants, un rangement, rien d'irréversible |

Ce document ne tranche pas : la fusion coûterait un schéma discriminé de plus, et `mail_flag` est le seul outil de rangement qui ne demande jamais confirmation quel que soit le volume, nuance qu'un nom commun rendrait moins lisible.

Deux autres paires reviennent naturellement — `contacts_search` avec `contacts_read`, `calendar_search` avec `calendar_read` — et aucune ne tient le critère : une recherche prend un filtre, pas des identifiants.

## 🚧 Si la place manque

Rien n'oblige à trancher au-delà de vingt-six par un refus.
Trois issues restent ouvertes, et la troisième est celle que le module 10 a prise.

- Fondre deux verbes voisins sous un discriminant, tant qu'ils gardent la même classe d'opération.
- Laisser le gating faire le travail : un domaine derrière une capacité absente ne pèse que sur les serveurs qui l'annoncent.
- Assumer le dépassement en le mesurant, car le seuil est une marge et non une falaise.

Ce qui n'est pas une issue : retirer un outil déjà publié.
C'est une rupture semver, et le nom d'un outil est le contrat public du paquet.
Une fusion se décide donc avant la publication du paquet, ou pas du tout : les vingt-huit outils actuels ne sont fusionnables que tant que rien ne les a exposés sous ces noms-là.
