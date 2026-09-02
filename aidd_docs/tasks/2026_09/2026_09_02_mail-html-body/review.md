---
title: Review — Corps HTML à l'envoi
status: resolved
updated: 2026-09-03
owner: bryan
---

# Review — Corps HTML à l'envoi

- **Verdict** : changes-requested — **levé**, les quatre findings sont corrigés et poussés
- **Diff** : `origin/main...feat/mail-html-body` (PR 11)
- **Axes run** : code, functional, relevancy
- **Date** : 2026_09_03
- **Findings** : 0 critical, 1 warning, 3 minor

## 🧭 Phases

### Phase 1 — Le corps HTML part, et l'absence de corps est refusée

- [x] 1.1 — `EmailCreate` porte `htmlBody`, aucun `bodyStructure` représentable — `src/jmap/types/mail.ts:271-275`, `pnpm typecheck` vert
- [x] 2.4 — Un appel sans corps est refusé, aucune requête ne part — `src/domains/mail/compose.ts:96-106`, `tests/unit/mail-compose.test.ts:632-641`
- [x] 3.2 — `htmlBody` seul n'émet aucun `textBody` — `src/domains/mail/compose.ts:358-363`, `tests/contract/html-body-untouched.test.ts:149-157`
- [x] 3.2 — `body` seul n'émet aucun `htmlBody` — `tests/unit/mail-compose.test.ts:97`
- [x] 3.3 — Aucune propriété de corps en tableau vide — `src/domains/mail/compose.ts:356-363`
- [x] 3.4 — La chaîne de `bodyValues` est celle reçue — `src/domains/mail/compose.ts:345`, `tests/contract/html-body-untouched.test.ts:134-147`
- [x] 4.4 — Le cas texte seul émet ce qu'il émettait avant — `tests/unit/mail-compose.test.ts:93-97`
- [x] 4.5 — Une réponse HTML garde `inReplyTo` et `references` — `tests/unit/mail-compose.test.ts:305-321`

### Phase 2 — La confirmation le nomme, un contrat le tient intact

- [x] 1.2 — Cible répétée listée une fois, dans l'ordre — `src/domains/mail/html.ts:45-55`, `tests/unit/mail-html.test.ts:29-36`
- [x] 1.3 — Un `src` d'image n'est listé nulle part — `tests/unit/mail-html.test.ts:38-42`
- [x] 1.5 — L'extrait tronqué dit combien d'octets manquent — `src/domains/mail/html.ts:74-80`
- [x] 2.2 — Le HTML sans partie texte est annoncé à part — `src/domains/mail/compose.ts:485-489`
- [x] 2.5 — Un brouillon ne rend aucune ligne de format — `tests/unit/mail-compose.test.ts:141-153`
- [x] 3.2 — Réécrire la chaîne fait tomber le contrat — mutation vérifiée cette session, 5 tests rouges
- [x] 3.3 — Ajouter `bodyStructure` fait tomber le contrat — mutation vérifiée cette session, 4 tests rouges
- [x] 3.5 — Dériver un `textBody` fait tomber le contrat — mutation vérifiée cette session, 4 tests rouges
- [x] 5.3 — Les compteurs de `testing.md` tiennent — `pnpm test` rend 1395 tests, 74 fichiers, `ls tests/contract` en compte 21
- [x] 5.5 — `pnpm changeset status` reconnaît un `minor` — sortie `@bryanberger/jmap-mcp` sous `minor`

## 🔍 Findings

| Sev | Kind | Phase | Location | Issue | Fix | Statut |
| --- | ---- | ----- | -------- | ----- | --- | ------ |
| 🟡 | code | 2 | `src/domains/mail/html.ts:83-88` | Le plafond porte sur le nombre de cibles, jamais sur leur longueur : une URL de suivi ou un `data:` entre entière dans la confirmation, et vingt d'entre elles enterrent ce que le bloc existe pour montrer | Passer chaque cible par `truncate` de `src/shared/render.ts`, déjà lue ailleurs, avant de la préfixer | ✅ `8a9b647` |
| 🟢 | code | 2 | `src/domains/mail/html.ts:78-79` | La coupe est en caractères, l'omission comptée en octets, et sur le texte dégradé et non sur le corps que la phrase nomme : « bytes of this body » désigne une taille que rien ne mesure | Nommer le texte plutôt que le corps, la formule venant de `sieve/script.ts:158-161` où les deux se confondent | ✅ `cbdd537` |
| 🟢 | code | 2 | `src/domains/mail/html.ts:64-71` | L'extrait entre sans clôture dans le message d'élicitation, dont il peut donc imiter la structure : un corps rédigé par un modèle sait écrire « The body is plain text. » sous la vraie ligne de format | Préfixer chaque ligne de l'extrait d'un `>`, la seule partie du message que son auteur ne peut alors plus mimer | ✅ `772f7ab` |
| 🟢 | rot | 2 | `aidd_docs/memory/codebase-map.md:77` | L'affirmation vaut pour l'envoi direct seul : un brouillon HTML expédié ensuite par `mail_send` ne montre aucun corps, sa confirmation ne nommant que sujet et destinataires — `src/domains/mail/send.ts:52-69` | Borner la phrase au chemin qui envoie, le PRD écartant `mail_send` explicitement — `2026_09_02-mail-html-body-prd.md:55` | ✅ `00115a5` |

## 🔧 Résolution

Les quatre findings ont été soumis à un challenger indépendant lisant le code de la branche : les quatre reviennent fondés, aucun conflit, aucune contradiction de fait. Rapport de run : `.claude/docs/resolve/mail-html-body-review.md`.

**✅ md-1 — le plafond des cibles — `8a9b647`**
Constat exact : `linkList` bornait le nombre de cibles, jamais leur longueur, et `htmlLinks` rendait la valeur brute. Le fix suit une convention déjà en place — `truncate` borne les chaînes de confirmation dans quatre domaines, dont `mail/delete.ts:154` sur le chemin `summarize`. `MAX_LINK_CHARS` vaut 120 et la coupe prend la queue, ce qui laisse schéma, hôte et début de chemin, soit le point d'arbitrage que `html.ts:41-43` nomme lui-même. Aucun test existant n'a changé.
<!-- resolve:thread:md-1 -->

**✅ md-2 — le compte qui ne mesurait rien — `cbdd537`**
Confirmé : la coupe portait sur `text.length` au-dessus de la sortie de `htmlToText`, l'omission était le `byteLength` de la tranche abandonnée de ce même texte dégradé, et seule la phrase disait « body ». Le précédent Sieve est bien le cas propre, la chaîne coupée et le nom employé y désignant le même objet. La phrase nomme désormais le texte, un commentaire dit pourquoi, et l'assertion de chaîne exacte a suivi.
<!-- resolve:thread:md-2 -->

**✅ md-3 — l'extrait qui pouvait se faire passer pour la confirmation — `772f7ab`**
Confirmé, et plus large que le finding : la liste de liens était forgeable au même titre que l'extrait, ses lignes `-` étant elles aussi une structure imitable. Un helper `quoteLines` préfixe donc les deux blocs. Une ligne non préfixée sous ces intitulés ne peut plus venir que de la confirmation elle-même. Test de régression sur un corps dont le texte est exactement `The body is plain text.`, plus un balayage vérifiant que toute ligne hors intitulés porte le marqueur.
<!-- resolve:thread:md-3 -->

**✅ md-4 — la phrase de mémoire sans borne — `00115a5`**
Constat retenu, et le trou est plus large que le finding ne le disait : le chemin brouillon de `mail_compose` ne montre rien non plus, `draft` valant `allow` par défaut — `src/config/policy.ts:22` — et `summarize` n'étant lu qu'au niveau `confirm` ou sous `confirmWhen` — `src/registry/compose.ts:163` — que l'outil ne porte pas. La phrase est bornée à l'envoi direct, et une ligne nomme ce qu'un brouillon repris par `mail_send` n'obtient pas. Le PRD écartant `mail_send` explicitement, la borne est un constat de périmètre et non une régression.
<!-- resolve:thread:md-4 -->

**📊 Portes après correction**
`pnpm typecheck` sans erreur, `pnpm lint` sur 163 fichiers, `pnpm test` rend 1397 tests sur 74 fichiers — deux de plus qu'à la revue, ajoutés par md-1 et md-3.

> _Réponses rédigées par un agent (Claude Code) et publiées par @BryanBerger98. Répondez ici, un humain vous lira._

## ✅ Verification

| Metric | Value |
| --- | --- |
| Verified | 100 % (18/18) |
| Files checked | `compose.ts`, `html.ts`, `mail.ts`, `html-body-untouched.test.ts`, `mail-compose.test.ts`, `mail-html.test.ts`, `README.md`, `.changeset/`, `aidd_docs/memory/` |
| Unchecked | none |
| Unplanned | Une assertion ajoutée au test texte seul que la tâche 4.4 disait conserver tel quel — `tests/unit/mail-compose.test.ts:97` |
