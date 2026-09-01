---
title: Budget d'outils
status: draft
updated: 2026-09-01
owner: bryan
---

# Budget d'outils

## 📊 Le compte

Le chiffre vient du rapport de composition, capacités toutes présentes, jamais d'un décompte à la main dans les sources.

| Moment | Outils enregistrés |
| --- | --- |
| Avant le stockage de fichiers | 21 |
| Après | 25 |
| Cible que le projet s'est donnée | 26 |

Il reste donc une place, et deux modules pour la prendre.

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

Deux modules, et une seule place. Le choix n'est pas fait ici : ce document laisse la règle et le compte, pas la décision.

| Module | Surface plausible | Coût |
| --- | --- | --- |
| Partages | Principals, droits, `shareWith` | 1 à 2 outils |
| Sieve | Scripts, validation, absence | 1 à 3 outils |

Les deux dépassent la place restante s'ils la prennent séparément.

> [!NOTE]
> Les deux capacités peuvent manquer : `urn:ietf:params:jmap:principals` et `urn:ietf:params:jmap:sieve` sont annoncées par le serveur, et le critère 1 les met devant un domaine que tout le monde voit.

## 🚧 Si la place manque

Rien n'oblige à trancher au-delà de vingt-six par un refus.
Trois issues restent ouvertes, et la première est la moins coûteuse.

- Fondre deux verbes voisins sous un discriminant, tant qu'ils gardent la même classe d'opération.
- Laisser le gating faire le travail : un domaine derrière une capacité absente ne pèse que sur les serveurs qui l'annoncent.
- Assumer vingt-sept en le mesurant, car le seuil est une marge et non une falaise.

Ce qui n'est pas une issue : retirer un outil déjà publié.
C'est une rupture semver, et le nom d'un outil est le contrat public du paquet.
