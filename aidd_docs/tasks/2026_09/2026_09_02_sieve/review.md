---
title: "Review : Sieve et réponse d'absence"
status: stable
updated: 2026-09-02
owner: bryan
---

# Review : Sieve et réponse d'absence

- **Verdict** : changes-requested
- **Diff** : `main...feat/sieve` (PR #9, 31 fichiers, +6074 / −52)
- **Axes run** : code, functional, relevancy
- **Date** : 2026_09_02
- **Findings** : 0 critical, 2 warning, 7 minor
- **Résolution** : 9 findings sur 9 corrigés et poussés — voir « Résolutions »

## ✅ Phases

### Phase 1 — Types, deux manifestes et lecture des scripts

- [x] Un filtre ou un tri hors des deux honorés est irreprésentable dans le type — `SieveScriptFilterCondition` clos sur `name` et `isActive`, `SieveScriptComparatorProperty` sur les deux mêmes — `src/jmap/types/sieve.ts:66`, `:72`
- [x] Une création ou une mise à jour portant `isActive` ne compile pas — `isActive?: never` sur les deux types, jamais une simple omission — `src/jmap/types/sieve.ts:105`, `:119`
- [x] Une session annonçant l'absence sans Sieve n'enregistre pas les outils de scripts — `tests/contract/sieve-read-only.test.ts:260`
- [x] Une session annonçant Sieve sans l'absence enregistre les outils de scripts — `tests/contract/sieve-read-only.test.ts:243`
- [x] Le script nommé `vacation` est rendu comme l'absence, avec le renvoi vers son outil — `src/domains/sieve/script.ts:63`, `tests/unit/sieve-scripts.test.ts:108`
- [x] Lister n'émet qu'un seul aller-retour, la lecture suivant la requête par back-reference — `#ids` sur `resultOf: "0"` — `src/domains/sieve/scripts.ts:138`, `:151`, `tests/unit/sieve-scripts.test.ts:75`
- [x] Sans script actif, la liste le dit explicitement au lieu de rester muette — `src/domains/sieve/scripts.ts:195`, `tests/unit/sieve-scripts.test.ts:100`
- [x] Un identifiant inconnu est rendu comme tel, aucun téléchargement n'étant tenté — le refus sort sur la lecture seule — `src/domains/sieve/scripts.ts:95`, `tests/unit/sieve-scripts.test.ts:150`
- [x] Une méthode hors des deux nommées fait tomber le contrat — assertion sur chaque branche et sur les arguments minimaux tirés du schéma — `tests/contract/sieve-read-only.test.ts:159`, `:181`
- [x] Le rapport de composition nomme `urn:ietf:params:jmap:sieve` quand elle manque — `tests/contract/sieve-read-only.test.ts:275`

### Phase 2 — `sieve_write`, valider puis stocker sans activer

- [x] Un serveur sans la capacité Sieve n'enregistre ni la lecture ni l'écriture, le rapport nommant les deux domaines — `tests/unit/sieve-write.test.ts:602`, `tests/contract/sieve-write-guard.test.ts:258`
- [x] Aucun `SieveScript/set` émis par le chemin du stockage ne porte d'argument d'activation — les deux sont écrits à `null`, jamais omis — `tests/contract/sieve-write-guard.test.ts:301`, `tests/unit/sieve-write.test.ts:93`
- [x] Aucune création ni mise à jour émise ne porte `isActive` — assertion sur les six chemins de la table `PATHS` — `tests/contract/sieve-write-guard.test.ts:275`
- [x] Une création sans nom explicite est impossible, le schéma l'exigeant — `tests/unit/sieve-write.test.ts:80`, `:545`
- [x] Un `alreadyExists` est rendu avec l'identifiant du script qui occupe le nom — `src/domains/sieve/edit.ts:143`, `tests/unit/sieve-write.test.ts:614`
- [x] Une validation en échec n'émet aucun `SieveScript/set` — assertion portée sur la liste des méthodes émises — `tests/unit/sieve-write.test.ts:172`
- [x] `blobNotFound` et `invalidScript` sont rendus par deux messages distincts — `tests/unit/sieve-write.test.ts:185`
- [x] Un nom valant `Vacation` ou `VACATION` est refusé avant toute méthode — refus dans `precheckStore`, avant le téléversement — `src/domains/sieve/write.ts:203`, `tests/unit/sieve-write.test.ts:202`
- [x] Écraser le script actif pose une question, alors même que l'appel est classé `draft` — `confirmWhen` consulté au seul niveau `allow` — `tests/unit/sieve-write.test.ts:250`
- [x] Le compte rendu d'un stockage réussi dit explicitement que rien n'est activé — `tests/unit/sieve-write.test.ts:158`

### Phase 3 — `sieve_write`, activer, couper, détruire

- [x] Un script portant `discard` et `fileinto` les annonce dans cet ordre — ordre de gravité fixe, jamais l'ordre d'apparition — `src/domains/sieve/radius.ts`, `tests/unit/sieve-radius.test.ts:35`
- [x] Le mot `discard` en commentaire est ignoré par la détection — les deux formes de commentaire, et la chaîne portant un `#` reste lue — `tests/unit/sieve-radius.test.ts:51`, `:59`, `:69`
- [x] Un texte de script illisible fait refuser l'activation avant toute question — `src/domains/sieve/write.ts:326`, `tests/unit/sieve-write.test.ts:349`
- [x] Remplacer le script `vacation` actif fait dire à la question que l'absence s'éteint — `src/domains/sieve/write.ts:375`, `tests/unit/sieve-write.test.ts:332`
- [x] Un appel d'activation n'émet ni création, ni mise à jour, ni destruction — `tests/contract/sieve-write-guard.test.ts:315`, `tests/unit/sieve-write.test.ts:297`
- [x] Sans script actif, couper le filtrage n'émet aucune écriture, la lecture qui l'établit exceptée — `precheck` refuse sur l'état qu'`allScripts` vient de lire, et `SieveScript/get` est la seule méthode émise — `tests/unit/sieve-write.test.ts:542`, `:552`
- [x] Cinquante et un identifiants sont refusés avant toute lecture — `tests/unit/sieve-write.test.ts:439`, `tests/contract/sieve-write-guard.test.ts:431`
- [x] L'identifiant du script actif fait refuser la destruction en nommant l'activation — `tests/unit/sieve-write.test.ts:458`
- [x] L'identifiant du script `vacation` fait refuser la destruction côté client — le seul refus que le serveur ne double pas — `tests/unit/sieve-write.test.ts:471`, `tests/contract/sieve-write-guard.test.ts:442`
- [x] Un `isActive` écrit dans une création ou une mise à jour fait tomber le contrat — `tests/contract/sieve-write-guard.test.ts:275`
- [x] Une confirmation refusée n'émet aucune méthode hors `/get` et `/query` — `tests/contract/sieve-write-guard.test.ts:400`
- [x] Un second module émettant un argument d'activation fait tomber le contrat — lecture des sources, un seul émetteur attendu — `tests/contract/sieve-write-guard.test.ts:467`

### Phase 4 — `vacation_manage`, poser et lever une absence

- [x] Une absence active dont la fenêtre est passée est rendue comme ne répondant pas — `src/domains/sieve/vacation.ts:230`, `tests/unit/sieve-vacation.test.ts:107`
- [x] Une absence sans borne est dite sans fin, jamais rendue avec deux champs vides — `src/domains/sieve/vacation.ts:256`, `tests/unit/sieve-vacation.test.ts:131`
- [x] Une propriété absente n'est pas écrite, une propriété nulle est effacée — `src/domains/sieve/vacation.ts:325`, `tests/unit/sieve-vacation.test.ts:218`
- [x] Un changement de sujet seul émet un update sans `isEnabled` — `tests/unit/sieve-vacation.test.ts:243`, `tests/contract/vacation-guard.test.ts:274`
- [x] Aucun `create` ni `destroy` n'est émis sur `VacationResponse` — les deux sont `never` dans le type des arguments — `src/jmap/types/sieve.ts`, `tests/unit/sieve-vacation.test.ts:232`
- [x] Nommer `isEnabled` classe l'appel `send`, l'omettre le classe `draft` — `src/domains/sieve/vacation.ts:161`, `tests/unit/sieve-vacation.test.ts:303`
- [x] Éteindre l'absence passe par la même confirmation que l'allumer — `tests/unit/sieve-vacation.test.ts:340`, `tests/contract/vacation-guard.test.ts:316`
- [x] La question d'allumage désigne sans le nommer le script de filtrage qui cesse d'être actif — l'écart tient à la capacité du manifeste, et il est porté par le plan comme par la mémoire projet — `src/domains/sieve/vacation.ts:433`, `:448`, `tests/contract/vacation-guard.test.ts:372`, `aidd_docs/memory/architecture.md:217`
- [x] Une méthode `SieveScript/*` émise par ce manifeste fait tomber le contrat — `tests/contract/vacation-guard.test.ts:301`
- [x] Une session annonçant l'absence sans Sieve enregistre tout de même l'outil — `tests/contract/vacation-guard.test.ts:212`

### Phase 5 — Budget d'outils, mémoire projet et deux corrections

- [x] Aucune affirmation disant que `isEnabled` retombe seul ne subsiste dans le dépôt — les trois occurrences disent désormais l'inverse, source à l'appui — `aidd_docs/ROADMAP.md:231`, `aidd_docs/memory/architecture.md:247`, `aidd_docs/memory/external/stalwart-jmap.md:288`
- [x] La ROADMAP ne présente plus trois outils comme un compte arrêté — module 10 marqué livré, outils nommés — `aidd_docs/ROADMAP.md:219`, `:223`
- [x] La mémoire nomme les trois chemins d'activation, pas deux — `aidd_docs/memory/external/stalwart-jmap.md:277`
- [x] La mémoire dit que filtrage et absence ne peuvent pas être actifs ensemble — `aidd_docs/memory/external/stalwart-jmap.md:282`
- [x] Les codes cités sont ceux du fil, et l'écart avec la RFC est nommé — table de correspondance — `aidd_docs/memory/external/stalwart-jmap.md:298`
- [x] Le chiffre de `tool-budget.md` correspond au rapport de composition — relevé cette session sur `dist/domains/index.js` : 28 outils sur 14 manifestes — `aidd_docs/memory/internal/tool-budget.md:18`
- [x] Les candidats à la fusion sont nommés sans être arbitrés — `mail_move` et `mail_flag`, la non-décision écrite — `aidd_docs/memory/internal/tool-budget.md:73`, `:75`
- [x] Le nombre d'outils de la carte du code est celui que la composition enregistre — 28, dont trois pour Sieve — `aidd_docs/memory/codebase-map.md:4`
- [x] Le nombre de tests de `testing.md` provient d'une exécution — relevé cette session : 1166 tests sur 67 fichiers — `aidd_docs/memory/testing.md:4`
- [x] `check-markdown.js` sort à zéro sur les six fichiers du dépôt de docs — relevé cette session : `0 erreur(s), 28 avertissement(s)`, `exit=0`
- [x] Les quatre portes câblées passent au vert après les modifications — relevé cette session sous Node 24.19.0 : `typecheck` et `build` silencieux, `lint` sur 148 fichiers sans correction, 1166 tests verts

## 🔍 Findings

| Sev · Kind | Phase | Location | Issue | Fix |
| ---------- | ----- | -------- | ----- | --- |
| 🟡 sv-1 · rot | 3 | `src/domains/sieve/write.ts:121` à `:122` | La description de l'outil affirme que le script `vacation` est « written, activated and switched off through vacation_manage, never here ». Le troisième verbe est faux : `deactivate` éteint ce qui est actif, `vacation` compris, et `summarizeDeactivate` rédige exactement cette phrase (`write.ts:394` à `:396`). Le contrat l'admet d'ailleurs en commentaire (`tests/contract/sieve-write-guard.test.ts:341` à `:346`) | Ne revendiquer que les deux gestes réellement interdits ici, l'écriture et l'activation, et dire que `deactivate` coupe ce qui filtre sans le nommer — sinon le modèle croit l'absence hors d'atteinte par ce chemin |
| 🟡 sv-2 · conform | 4 | `src/domains/sieve/vacation.ts:161` vs `src/domains/sieve/write.ts:128` | Allumer l'absence arrête tout filtrage Sieve (`vacation/set.rs:281-283`), l'effet même que `sieve_write deactivate` classe `destroy`. Classé `send`, il échappe à `destroy: deny` : une politique qui interdit d'arrêter le filtrage le laisse arrêter par l'autre porte. `architecture.md` décrit ce trou pour `calendar_delete` et le ferme en lisant `context.policy.send` dans le `precheck` (`src/domains/calendar/delete.ts:110`) ; `context.policy` (`src/registry/define-tool.ts:42`) n'est lu nulle part dans `src/domains/sieve/` | Lire `context.policy.destroy` dans le `precheck` de `vacation_manage` et refuser un `isEnabled: true` quand un script de filtrage est actif et que la classe est refusée, sur le patron déjà en place |
| 🟢 sv-3 · code | 3 | `src/domains/sieve/write.ts:390` à `:392` | Branche morte : `summarizeDeactivate` traite `active === undefined`, cas que `precheckDeactivate` (`:410` à `:417`) refuse déjà et que `compose.ts` fait passer en premier — `precheck` à `src/registry/compose.ts:154`, `summarize` à `:187` | Retirer la branche, ou expliquer en commentaire pourquoi elle survit à un refus qui la précède toujours |
| 🟢 sv-4 · code | 2 / 3 | `src/domains/sieve/scripts.ts:109`, `src/domains/sieve/write.ts:194`, `:318`, `:330`, `:355` | `describeScripts` est documenté pour compter un ensemble (`src/domains/sieve/script.ts:70` à `:75`) et sert à désigner un script unique : le compte est écrit devant, d'où « Refused: 1 script: newsletters (sc-1) carries no blobId » | Ajouter un rendu d'un script seul — nom et identifiant, sans compte — et ne garder `describeScripts` que là où un ensemble est en jeu |
| 🟢 sv-5 · rot | 2 / 4 | `src/domains/sieve/edit.ts:143` vs `src/domains/sieve/vacation.ts:37` | Deux rendus de refus serveur dans le même domaine : `explainSetError` traduit les codes du fil, `describeSetError` (`src/shared/render.ts:17`) n'en traduit aucun. Un `forbidden` sur l'absence sort donc brut là où le même code sort expliqué sur un script | Faire passer le refus de l'absence par `explainSetError`, ou écrire pourquoi ce chemin n'a pas de code à traduire |
| 🟢 sv-6 · code | 3 | `src/domains/sieve/write.ts:353` à `:364`, `:431` à `:437` | `runActivate` et `runDeactivate` annoncent le nouvel état actif sans rien lire de la réponse : un `SieveScript/set` d'activation ne porte ni `created`, ni `updated`, ni `destroyed`, donc le compte rendu affirme un résultat que rien n'établit. La même prudence est déjà écrite pour les agendas dans `aidd_docs/memory/architecture.md` | Formuler le compte rendu comme ce qui a été demandé au serveur, ou relire l'état actif après l'écriture quand la certitude vaut l'aller-retour |
| 🟢 sv-7 · rot | 2 | `src/domains/sieve/write.ts:238`, `:250` à `:256` | Le texte est téléversé avant la validation, et le refus qui suit ne dit pas que le blob est déjà parti. Le domaine des fichiers, corrigé une PR plus tôt, nomme les octets transférés dans son propre refus (`src/domains/files/write.ts:236`) | Nommer dans le refus le texte déjà téléversé, comme le fait `files_write` |
| 🟢 sv-8 · functional | 3 | `aidd_docs/tasks/2026_09/2026_09_02_sieve/phase-3.md`, critère 3.5 | « Sans script actif, couper le filtrage n'émet aucune méthode » : `precheckDeactivate` lit d'abord l'état actif, donc un `SieveScript/get` part toujours. Le test l'assume et réécrit le critère en commentaire (`tests/unit/sieve-write.test.ts:421` à `:430`) plutôt que dans le plan | Reformuler le critère en « n'émet aucune écriture, la lecture qui l'établit exceptée », la formule que le contrat tient déjà (`tests/contract/sieve-write-guard.test.ts:400`) |
| 🟢 sv-9 · functional | 4 | `aidd_docs/tasks/2026_09/2026_09_02_sieve/phase-4.md`, critère 3.4 | « La question d'allumage nomme le script de filtrage qui cesse d'être actif » : le code refuse délibérément de le nommer, un `SieveScript/get` étant hors de la capacité sur laquelle ce manifeste est enregistré (`src/domains/sieve/vacation.ts:383` à `:385`). L'arbitrage est juste, mais il vit dans un commentaire de fonction et nulle part dans le plan ni dans la mémoire projet | Reformuler le critère en « désigne sans le nommer », et porter la contrainte de capacité dans `aidd_docs/memory/architecture.md`, où les autres écarts de ce module sont écrits |

## 💬 Résolutions

Les neuf findings sont fondés, aucun n'est écarté.
Trois reçoivent un correctif différent de celui que la review proposait, tranché sur preuve et non par préférence : `sv-2`, `sv-3` et `sv-5`.
Un commit par finding, poussés sur `feat/sieve` dans `54137ab..744872e`.

| Finding | Verdict | Commit | Ce que le correctif touche |
| ------- | ------- | ------- | -------------------------- |
| `sv-1` | `valid` | `8a9b753` | Description de `sieve_write` |
| `sv-2` | `valid` | `f7922e6` | `precheck` de `vacation_manage`, unité et contrat |
| `sv-3` | `valid` | `205770c` | Commentaire sur la branche de rétrécissement |
| `sv-4` | `valid` | `273cee9` | `describeScript` et quatorze sites d'appel |
| `sv-5` | `valid` | `4a3d652` | Commentaire au-dessus du refus de `runSet` |
| `sv-6` | `valid` | `1990014` | Comptes rendus d'activation et de coupure |
| `sv-7` | `valid` | `cced1d4` | Quatre refus qui suivent le téléversement |
| `sv-8` | `valid` | `ba46665` | `phase-3.md`, tâche et critère 3.5 |
| `sv-9` | `valid` | `744872e` | `phase-4.md`, `plan.md`, mémoire projet |

### sv-1 — la description niait un geste que `deactivate` fait

<!-- resolve:thread=sv-1 -->

Confirmé, et sur deux chemins plutôt qu'un : `precheckDeactivate` (`write.ts:410` à `:417`) ne refuse que le cas « rien d'actif », et `describeReplaced` (`write.ts:379` à `:382`) annonce déjà qu'une activation éteint la réponse automatique.
La description ne revendique plus que l'écriture et l'activation comme réservées à `vacation_manage`, et dit que `deactivate` coupe le script actif quel qu'il soit.
Le contrat n'a jamais tenu la phrase retirée : `AT_THE_VACATION_SCRIPT` ne couvre que `store`, `activate` et `delete`.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-2 — l'absence contournait `destroy: deny`

<!-- resolve:thread=sv-2 -->

Le trou est réel et le `precheck` est le bon point d'accrochage : `context.policy` n'était lu que dans `src/domains/calendar/delete.ts:110`, nulle part sous `src/domains/sieve/`.
La condition proposée n'est en revanche pas atteignable : connaître le script actif exige un `SieveScript/get` que `tests/contract/vacation-guard.test.ts:301` à `:312` interdit et que le gating sur la seule capacité `vacationresponse` (`index.ts:44`) ne garantit pas.
Le refus retenu est donc inconditionnel sur `isEnabled: true` sous `destroy: deny` — il échoue fermé — et laisse l'extinction hors de sa portée ; `architecture.md` enregistre ce second lecteur de `context.policy`.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-3 — la branche survit au typage, pas au registre

<!-- resolve:thread=sv-3 -->

L'ordre annoncé est vérifié, et le cache `sieve:scripts` (`script.ts:103`) empêche les deux hooks de diverger sur l'état lu.
Retirer la branche ne compile pas : `active` est `SieveScript | undefined`, quand `isVacationScript` (`script.ts:48`) et `describeScripts` (`script.ts:75`) exigent un `SieveScript`.
C'est donc la seconde option qui est prise, le commentaire, doublé sur le motif identique de `runDeactivate`.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-4 — un compte écrit devant un script unique

<!-- resolve:thread=sv-4 -->

Le constat est plus large que les cinq sites cités : `describeScripts` compte quinze appels, dont quatorze sur un tableau d'un seul élément, et le besoin était déjà attesté par le rendu réécrit à la main en `scripts.ts:199`.
`describeScript` est exporté et alimente le `map` de `describeScripts`, pour que le rendu d'un script et celui d'un ensemble ne puissent pas diverger ; `describeScripts` ne subsiste qu'à `summarizeDelete` (`write.ts:447`).
`describeNodes` (`files/node.ts:92`) porte le même défaut sur deux sites : noté, hors périmètre de cette PR.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-5 — deux rendus de refus, une raison manquante

<!-- resolve:thread=sv-5 -->

Le constat de duplication tient, l'illustration non : `forbidden` n'est traduit nulle part, il tombe dans le `default` d'`explainSetError` et sort brut là aussi, ce que `tests/unit/sieve-write.test.ts:636` vérifie.
Aucun des six codes traduits n'est atteignable sur `VacationResponse/set`, `create` et `destroy` étant `never` (`types/sieve.ts:206` à `:207`), et les deux plausibles restants seraient mal rendus : `invalidProperties` parle d'un nom de script que l'absence n'a pas, `overQuota` renvoie à un outil que cette capacité n'expose pas.
C'est donc la seconde branche du fix qui est retenue, écrire pourquoi, sur le patron de `files/edit.ts:145` à `:152`.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-6 — un état affirmé que la réponse n'établit pas

<!-- resolve:thread=sv-6 -->

Vérifié : `sieveActivationArguments` n'émet ni création, ni mise à jour, ni destruction (`edit.ts:124` à `:133`), donc la réponse ne porte aucun identifiant qui établisse le nouvel état actif.
Les deux comptes rendus séparent désormais ce qui a été lu avant l'écriture de ce qui a seulement été demandé au serveur, sur le patron de `calendar/delete.ts:199` à `:206`.
La relecture est écartée : elle coûterait un aller-retour par activation pour une course que le `precheck` couvre déjà.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-7 — le texte téléversé passé sous silence

<!-- resolve:thread=sv-7 -->

Quatre refus étaient concernés et non un : absence de verdict, échec de compilation, création non confirmée, correction non confirmée.
La phrase est conditionnée au succès du stockage et jamais au code du refus, comme en `files/write.ts:232` ; `blobNotFound` en est exclu, son texte disant déjà que le téléversement a disparu.
Elle ne descend pas dans `explainSetError`, partagé avec la destruction qui ne téléverse rien.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-8 — un critère promettant zéro méthode

<!-- resolve:thread=sv-8 -->

La chaîne est vérifiée : `precheckDeactivate` passe par `activeScript` puis `allScripts`, qui émet toujours un `SieveScript/get` (`script.ts:96` à `:107`), ce que le test assert positivement plutôt que de le nier.
Deux lignes de `phase-3.md` portaient l'affirmation, la tâche 3.5 et le critère : les deux reprennent la formule que le contrat tient déjà.
Le critère de cette review est coché avec la preuve rafraîchie.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

### sv-9 — un nom promis que la capacité interdit de lire

<!-- resolve:thread=sv-9 -->

La promesse « nomme » figurait quatre fois et non une : `phase-4.md:116`, `:143`, `:157` et `plan.md:115`.
Les quatre disent désormais « désigne sans le nommer », avec la raison de capacité que le contrat fige déjà en n'admettant que `VacationResponse/get`.
`architecture.md` porte le sens absence vers filtrage et sa contrainte, ainsi que `vacation_manage` comme second lecteur de `context.policy`.

> _Réponse rédigée par un agent (Claude Code) et publiée par @BryanBerger98. Répondez ici, un humain vous lira._

## 📊 Verification

| Metric | Value |
| --- | --- |
| Verified | 100 % (53/53) |
| Files checked | `src/domains/sieve/{index,scripts,write,vacation,script,edit,radius}.ts`, `src/jmap/types/sieve.ts`, `src/registry/{compose,define-tool}.ts`, `src/shared/{render,batch}.ts`, `src/domains/calendar/delete.ts`, `src/domains/files/write.ts`, `tests/contract/{sieve-read-only,sieve-write-guard,vacation-guard}.test.ts`, `tests/unit/sieve-{scripts,write,vacation,radius}.test.ts`, `tests/fixtures/{sieve,client}.ts`, `README.md`, `aidd_docs/ROADMAP.md`, `aidd_docs/memory/{architecture,codebase-map,testing}.md`, `aidd_docs/memory/external/stalwart-jmap.md`, `aidd_docs/memory/internal/tool-budget.md` |
| Unchecked | aucun — les deux critères en attente sont levés, plan et mémoire projet reformulés |
| Unplanned | `aidd_docs/ROADMAP.md` — modules 8 et 9 marqués livrés et réécrits, alors que la phase 5 ne vise que la ligne 231 et le module 10 · `tests/fixtures/client.ts` — canal de blobs injectable, conséquence obligée d'une détection qui lit deux textes distincts, absente des trois projections d'architecture |
