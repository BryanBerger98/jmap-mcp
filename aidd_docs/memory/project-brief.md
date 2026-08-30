---
title: Brief projet
status: draft
updated: 2026-08-29
owner: bryan
---

# Brief projet

## 🎯 Ce que c'est

Serveur MCP local qui expose la surface JMAP d'un serveur Stalwart à un assistant IA.
Il couvre six domaines : mail, calendrier, contacts, fichiers, partages, Sieve.

## 💡 Pourquoi il existe

Les personnes qui auto-hébergent Stalwart veulent qu'un assistant lise, cherche et rédige dans leur messagerie sans intermédiaire tiers.
Aucune donnée ne quitte la machine en dehors de l'échange avec le serveur de l'utilisateur.

Deux différenciateurs face à l'art antérieur, qui s'arrête au mail : la couverture des six domaines, et une politique d'écriture qui encadre chaque opération irréversible.

## 📖 Vocabulaire du domaine

| Terme | Sens |
| --- | --- |
| JMAP | Protocole JSON successeur d'IMAP |
| Stalwart | Le serveur de messagerie ciblé |
| Session JMAP | Découverte des capacités et du compte |
| Capability | Domaine annoncé par le serveur |
| MRTR | Entrée requise de la spécification MCP |
| Élicitation | Demande de confirmation au client MCP |
| Classe d'opération | `read`, `draft`, `send`, `destroy` |
| Back-reference | Renvoi vers un résultat antérieur |

## 🧩 Fonctions principales

- Lecture, recherche et rédaction de mail.
- Consultation d'agenda, disponibilités, participants.
- Carnets de contacts et fiches.
- Stockage de fichiers et téléversement.
- Principals et droits de partage.
- Scripts Sieve et réponse d'absence.
- Politique d'écriture configurable par classe d'opération.
