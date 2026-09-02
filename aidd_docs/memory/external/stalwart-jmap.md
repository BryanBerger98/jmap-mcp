---
title: Surface JMAP de Stalwart
status: draft
updated: 2026-09-02
owner: bryan
---

# Surface JMAP de Stalwart

## 🎯 Portée et méthode

Recensement des méthodes JMAP que Stalwart expose, domaine par domaine, pour décider lesquelles deviennent un outil MCP.

Sources par ordre de préséance : documentation Stalwart, README et CHANGELOG du dépôt, spécification IETF, code source en arbitre.
Dépôt inspecté : branche `main` au 2026-08-29, dernière release `v0.16.19` du 2026-08-24.
Aucune vérification sur instance réelle : le jeton bearer n'existe pas encore.

Le total dépasse quatre-vingts méthodes pour un budget de vingt-six outils.
Un outil MCP regroupe donc plusieurs méthodes sous un verbe métier, jamais une méthode par outil.

## 🔑 Capacités annoncées

Stalwart annonce les six domaines du projet, plus les extensions ci-dessous.

| URN | Domaine |
| --- | --- |
| `urn:ietf:params:jmap:core` | Noyau, RFC 8620 |
| `urn:ietf:params:jmap:blob` | Blobs, RFC 9404 |
| `urn:ietf:params:jmap:mail` | Mail, RFC 8621 |
| `urn:ietf:params:jmap:submission` | Envoi |
| `urn:ietf:params:jmap:vacationresponse` | Absence |
| `urn:ietf:params:jmap:contacts` | Contacts, RFC 9610 |
| `urn:ietf:params:jmap:contacts:parse` | Extension Stalwart |
| `urn:ietf:params:jmap:calendars` | Agendas, draft `-28` |
| `urn:ietf:params:jmap:calendars:parse` | Extension |
| `urn:ietf:params:jmap:filenode` | Fichiers, draft `-14` |
| `urn:ietf:params:jmap:sieve` | Sieve, RFC 9661 |
| `urn:ietf:params:jmap:principals` | Partages, RFC 9670 |
| `urn:ietf:params:jmap:principals:owner` | Principal propriétaire |
| `urn:ietf:params:jmap:principals:availability` | Disponibilité |
| `urn:ietf:params:jmap:mail:share` | Partage de boîte |
| `urn:ietf:params:jmap:quota` | Quotas |
| `urn:ietf:params:jmap:websocket` | WebSocket, RFC 8887 |
| `urn:stalwart:jmap` | Configuration propriétaire |

> [!WARNING]
> `principals:owner` est reconnu en entrée mais absent de `all_capabilities()`.
> Le gating par capacité ne doit pas s'appuyer dessus.

## 🧱 Noyau, RFC 8620

`Core/echo` et `Blob/copy` sont les seules méthodes concrètes de la RFC.
Le reste est un patron nommé, décliné par domaine.

| Élément | État chez Stalwart |
| --- | --- |
| Patron `get`, `changes`, `set`, `query` | Décliné, mais pas uniformément |
| `queryChanges`, `copy` | Absents sur plusieurs objets |
| Back-references, ids de création | Complets, testés |
| RFC 9404, gestion de blobs | Complète |
| Push : abonnement, SSE, WebSocket | Les trois canaux |

Le patron n'est pas garanti : `Thread` n'a que `get` et `changes`, `VacationResponse` que `get` et `set`, `Calendar`, `AddressBook` et `SieveScript` n'ont pas de `queryChanges`.

**Limites serveur, valeurs par défaut**

| Clé Stalwart | Défaut | Champ RFC |
| --- | --- | --- |
| `maxMethodCalls` | 16 | `maxCallsInRequest` |
| `getMaxResults` | 500 | `maxObjectsInGet` |
| `setMaxObjects` | 500 | `maxObjectsInSet` |
| `maxRequestSize` | 10 Mo | `maxSizeRequest` |
| `maxUploadSize` | 50 Mo | `maxSizeUpload` |
| `queryMaxResults` | 5000 | hors RFC |
| `changesMaxResults` | 5000 | hors RFC |

Les deux dernières ne sont annoncées nulle part dans la session.
`serverFail` est absent du mapping d'erreurs : Stalwart replie sur `serverUnavailable`.

## 📬 Mail, RFC 8621

Les vingt-six méthodes de la RFC sont implémentées.

| Objet | Méthodes |
| --- | --- |
| `Mailbox` | `get`, `changes`, `query`, `queryChanges`, `set` |
| `Thread` | `get`, `changes` |
| `Email` lecture | `get`, `changes`, `query`, `queryChanges` |
| `Email` écriture | `set`, `copy`, `import`, `parse` |
| `SearchSnippet` | `get` |
| `Identity` | `get`, `changes`, `set` |
| `EmailSubmission` | `get`, `changes`, `query`, `queryChanges`, `set` |
| `VacationResponse` | `get`, `set` |

**Filtres de `Email/query`**

Les vingt conditions de la RFC sont exécutées, dont `to`, `from`, `cc`, `bcc`, `subject`, `body`, `text`, `header`, `inMailbox`, `before`, `after`, `hasKeyword`.
Le filtre `header` prend un tableau de un ou deux éléments : nom, puis valeur optionnelle.
Extensions hors RFC : `sentBefore`, `sentAfter`, `inThread`, `id`.

Tri supporté : `receivedAt`, `size`, `from`, `to`, `subject`, `sentAt`, les trois variantes `keyword`, et `cc`.
`threadId` est rejeté en `UnsupportedSort`.

**Lire un corps sans tout tirer**

Omettre `properties` sur `Email/get` tire par défaut `bodyValues`, `textBody`, `htmlBody` et `bodyStructure`, que la RFC range parmi les propriétés lentes.
Expliciter `properties`, puis `fetchTextBodyValues` avec `maxBodyValueBytes`, et vérifier `isTruncated`.

**Opérations irréversibles**

| Appel | Effet |
| --- | --- |
| `Email/set` destroy | Retire de tous les dossiers, définitif |
| `Email/set` update sur `mailboxIds` | Déplacement, réversible |
| `EmailSubmission/set` create | Envoie réellement |
| `EmailSubmission/set` + `onSuccessDestroyEmail` | Envoie et détruit la source |
| `Mailbox/set` destroy + `onDestroyRemoveEmails` | Détruit les messages en cascade |
| `Email/copy` + `onSuccessDestroyOriginal` | Copie puis détruit |

Mettre à la corbeille n'est pas détruire : c'est un patch de `mailboxIds` vers le dossier de rôle `trash`.

## 📅 Agendas, draft `-28`

Les vingt méthodes du draft sont implémentées, plus `Calendar/query`, que le draft cite sans la définir.

| Objet | Méthodes |
| --- | --- |
| `Calendar` | `get`, `changes`, `set`, `query` |
| `CalendarEvent` | `get`, `changes`, `set`, `copy`, `query`, `queryChanges`, `parse` |
| `ParticipantIdentity` | `get`, `changes`, `set` |
| `CalendarEventNotification` | `get`, `changes`, `set`, `query`, `queryChanges` |
| `Principal` | `getAvailability`, `query` |

`Principal/getAvailability` est le seul point d'entrée pour la disponibilité.
Aucun objet `FreeBusy` n'existe.
Le RSVP est un `update` ordinaire sur `participants[id].participationStatus`.

Filtres de `CalendarEvent/query` : `after`, `before`, `inCalendar`, `text`, `title`, `description`, `location`, `owner`, `attendee`, `uid`.
Les bornes sont des `LocalDateTime`, interprétées dans l'argument `timeZone`.

**Le basculement de classe**

`sendSchedulingMessages`, à `false` par défaut, fait émettre un iTIP `REQUEST`, `REPLY` ou `CANCEL` par iMIP.
C'est un mail réellement expédié : le même `CalendarEvent/set` passe de `draft` à `send` selon ce booléen.

Le pire cas cumule les deux risques : `Calendar/set` destroy, `onDestroyRemoveEvents` vrai, `sendSchedulingMessages` vrai.

**Une création récurrente refusée, cause non établie**

Le serveur de test rend `invalidProperties` sur `recurrenceRules` à chaque création tentée, sur quatre formes : `@type` avec `count`, `frequency` nue, avec `until`, et en majuscules.
Le constat est celui d'un déploiement et d'un jour, jamais celui de l'implémentation : rien n'a été lu dans le code du serveur pour l'expliquer, donc il ne vaut pas règle.
Ce qu'il coûte est borné : créer une série passe par un autre client, lire et déplier une série existante n'est pas touché.

## 👤 Contacts, RFC 9610

Les neuf méthodes de la RFC sont implémentées, plus deux extensions.

| Objet | Méthodes |
| --- | --- |
| `AddressBook` | `get`, `changes`, `set`, `query` |
| `ContactCard` | `get`, `changes`, `query`, `queryChanges`, `set`, `copy`, `parse` |

`AddressBook/query` et `ContactCard/parse` sortent de la RFC.
Un `ContactCard` est un objet JSContact, RFC 9553, plus `id` et `addressBookIds`.

Vingt conditions de filtre sont câblées, dont `inAddressBook`, `uid`, `kind`, `text`, `name`, `email`, `phone`, `organization`, `note`, et les quatre bornes de date.

**Deux écarts mesurés**

Le tri par nom renvoie `UnsupportedSort` : seuls `created` et `updated` sont triables.
`name`, `name/given` et `name/surname` retombent sur le même index, donc filtrer sur le prénom seul est impossible.

**Opérations irréversibles**

`AddressBook/set` destroy avec `onDestroyRemoveContents` vrai vide le carnet entier.
Aucune corbeille n'existe pour les contacts.

## 📁 Fichiers, draft `-14`

Le draft ne définit que six méthodes, toutes implémentées.

| Objet | Méthodes |
| --- | --- |
| `FileNode` | `get`, `changes`, `set`, `query`, `queryChanges`, `copy` |

Les octets transitent par les URL d'upload et de download du noyau, ou par `Blob/upload`.
L'écriture HTTP directe est indisponible : Stalwart pose `webWriteUrlTemplate` à `null`.

Lister un répertoire se fait par `FileNode/query` filtré sur `parentId`, puis `FileNode/get`.
Aucune méthode de listage n'existe.
Un dossier se distingue par `nodeType`, avec `blobId`, `size` et `type` à `null`.

**Contraintes servies par la capacité**

| Propriété | Valeur |
| --- | --- |
| `maxSizeFileNodeName` | 255 |
| `forbiddenNameChars` | `/<>:"\|?*` |
| `fileNodeQuerySortOptions` | `Name`, `Size`, `NodeType` |
| `caseInsensitiveNames` | `false` |
| `webTrashUrl` | `null` |

Le tri par date est impossible, et il échoue en silence plutôt qu'en erreur.
Un comparateur non supporté n'est pas rejeté en `UnsupportedSort` : il est retiré de la liste à `query.rs:213-226`, et une liste entièrement vidée retombe en ordre de document.
Une pagination qui croit trier par date paginera donc un ordre qu'elle n'a pas demandé.

Un seul plafond de taille est lisible : `maxSizeUpload`, publié par la capacité noyau depuis `upload_max_size` (`jmap.rs`) et appliqué au point de téléversement.
Le `FileStorage.maxSize` de 25 Mo qu'affirmait cette mémoire n'apparaît nulle part dans `file/set.rs`, pas plus qu'un refus de taille tombant au `FileNode/set`.

**Le filtre qui ment**

Vingt-deux conditions sont parsées, neuf sont exécutées : `parentId`, `ancestorId`, `descendantId`, `isTopLevel`, `nodeType`, `name`, `nameMatch`, `minSize`, `maxSize`.
Les treize autres — `text`, `body`, `type`, `typeMatch`, `role`, `hasAnyRole`, `blobId`, `isExecutable` et les six bornes de date — tombent dans une branche vide de `query.rs:159-177`, sans erreur ni avertissement.
Une requête qui en porte une rend donc plus de résultats que demandé, et rien dans la réponse ne le signale.

**Opérations irréversibles**

`onDestroyRemoveChildren` vrai détruit tout le sous-arbre.
`onExists` a quatre valeurs, pas deux (`file_node.rs:320-336`).

| Valeur | Effet sur l'existant |
| --- | --- |
| `null` et `""` | Reject, défaut serveur : rien n'est détruit |
| `"replace"` | Détruit l'existant, sans condition |
| `"newest"` | Détruit si l'entrant est plus récent |
| `"rename"` | Ne détruit rien, renomme l'entrant |

Ni corbeille ni versioning dans la spécification.

## 🔗 Partages, RFC 9670

| Objet | Méthodes | État |
| --- | --- | --- |
| `Principal` | `get`, `query` | Implémentées |
| `Principal` | `set`, `changes`, `queryChanges` | Reconnues, sans implémentation |
| `Principal` | `getAvailability` | Implémentée, vient du draft Calendars |
| `ShareNotification` | `get`, `changes`, `query`, `queryChanges`, `set` | Implémentées |

`ShareNotification/set` n'accepte que `destroy`.
Le partage lui-même passe par la propriété `shareWith`, portée par `Mailbox`, `Calendar`, `AddressBook` et `FileNode`.

Les droits diffèrent par type d'objet — dix pour une boîte, huit pour un agenda, six pour un nœud de fichier, quatre pour un carnet — et les quatre jeux ont `mayShare` et `mayDelete` en commun.
Deux droits qui retombent sur la même permission interne ne se distinguent pas à la lecture : `api/acl.rs:196` rend un droit vrai si toutes ses ACL sont détenues, donc `maySetSeen` et `maySetKeywords` d'une boîte bougent ensemble, comme `mayWriteAll` et `mayDelete` d'un agenda.

`allowDirectoryQueries` désactivé ne ferme pas `Principal/query` à lui seul.
Le refus demande aussi que le jeton n'ait pas `JmapPrincipalQuery` — `principal/query.rs:44-45` — or le rôle utilisateur par défaut reçoit toute permission dont le nom commence par `jmap` — `common/src/auth/permissions.rs:263-274`.
Le même ET gouverne `Principal/get` et `Principal/getAvailability`.

Le nombre de bénéficiaires par objet est plafonné, à dix par défaut : `max_shares_per_item`, posé en `crates/registry/src/schema/structs_impl.rs:36076-36083` et appliqué en `crates/jmap/src/api/acl.rs:242-245`.

**Asymétrie à connaître**

Aucune méthode de révocation n'existe : révoquer, c'est retirer une clé de la map `shareWith`.
Une écriture qui remplace la map au lieu de la patcher révoque silencieusement tous les autres partages.
La carte des droits est dépliée en ne gardant que les entrées valant `true` — `jmap-tools/src/json/value.rs:236-242` — donc un nom de droit que le type ne connaît pas, écrit à `false`, ne produit aucune erreur : une révocation mal orthographiée réussit sans rien révoquer.

## ⚙️ Sieve, RFC 9661

Les quatre méthodes de la RFC sont implémentées : `SieveScript/get`, `set`, `query`, `validate`.
Le support est actif par défaut, désactivable par les permissions utilisateur.

L'absence est un objet `VacationResponse` matérialisé en script Sieve nommé `vacation`.
Ce script est lisible par `SieveScript/get`, mais son écriture et sa création sont refusées — `sieve/set.rs:416-424` et `:443-448` — donc `VacationResponse/set` est le seul chemin.
Sa destruction, elle, n'est gardée par rien : `sieve/set.rs:329-351` ne contrôle que la condition du script actif, ce qui laisse le client seul garde sur ce chemin.

**Ce que `get` et `query` rendent**

`SieveScript/get` ne rend que quatre propriétés — `id`, `name`, `blobId`, `isActive` — et jamais le texte : `sieve/get.rs:40-44`.
Le corps voyage en blob, comme un fichier, la section du `BlobId` étant bornée à `sieve.size` pour que le téléchargement rende la source sans l'archive compilée stockée à côté — `sieve/get.rs:117-121`.

`SieveScript/query` n'honore que deux conditions, `name` en sous-chaîne et `isActive`, et ne trie que sur ces deux propriétés.
Au-delà, Stalwart lève une vraie erreur `UnsupportedFilter` ou `UnsupportedSort`, contrairement au domaine des fichiers qui abandonne la condition en silence.

**Gravité par argument**

| Opération | Rayon |
| --- | --- |
| `validate` | Nul, aucun stockage |
| `create` ou `update` d'un script inactif | Nul |
| Propriété `isActive` écrite | Active le script, troisième chemin |
| `onSuccessActivateScript` | Réécrit le traitement du courrier entrant |
| `onSuccessDeactivateScript` | Coupe le filtrage et l'absence |
| `destroy` d'un script | Contenu perdu, actif refusé |

Un `discard` dans un script activé jette le mail sans stockage ni corbeille.
Stalwart refuse de détruire un script actif, ce qui interdit le double effet en un appel.

**Trois chemins d'activation, pas deux**

Les deux arguments `onSuccess…` sont ceux que tout le monde attend. Le troisième est la propriété `isActive` elle-même : écrite dans une création ou une mise à jour, Stalwart la capture — `sieve/set.rs:482-484` — la pousse dans les activations en attente et la retraduit en l'un des deux arguments — `sieve/set.rs:358-368`.
Un appel qui l'émet active donc un script en croyant seulement le nommer.

**Exclusivité du filtrage et de l'absence**

Un seul script est actif à la fois — `sieve/set.rs:328`.
L'absence étant matérialisée par un script, activer un filtre éteint l'absence, et allumer l'absence désactive le filtre — `vacation/set.rs:281-283`.
`isEnabled` n'est pas un drapeau à part : `vacation/set.rs:144` l'initialise depuis le script actif courant.

**Ce que `VacationResponse/set` préserve**

`isEnabled` ne retombe pas seul : seule une propriété `isEnabled` explicite le change — `vacation/set.rs:186-191`.
Une clé absente et une valeur nulle sont deux choses distinctes, la première ne touchant à rien et la seconde effaçant — `vacation/set.rs:214-218`.

Conséquence pratique : réécrire `isEnabled` à chaque changement de texte fondrait deux gestes qu'il faut séparer, reformuler le message d'absence d'une part, décider qu'il répond d'autre part.
Les bornes vivent dans le script généré — `vacation/set.rs:330` — donc une absence allumée hors de sa fenêtre ne répond à personne.

**Les codes du fil ne sont pas ceux de la RFC**

| Sur le fil | RFC 9661 |
| --- | --- |
| `invalidScript` | `invalidSieve` |
| `scriptIsActive` | `sieveIsActive` |

Un mapping écrit sur les noms de la RFC ne reconnaîtrait aucun des deux refus.

## ⚠️ Le motif transverse

La classe d'opération ne se déduit pas du nom de la méthode.
Six domaines exposent le même mécanisme sous six noms différents : un argument transforme une écriture bornée en destruction ou en envoi.

| Domaine | Argument | Bascule |
| --- | --- | --- |
| `mail` | `onDestroyRemoveEmails` | Destruction en cascade |
| `mail` | `onSuccessDestroyEmail` | Envoi plus destruction |
| `calendar` | `sendSchedulingMessages` | `draft` devient `send` |
| `calendar` | `onDestroyRemoveEvents` | Destruction en cascade |
| `contacts` | `onDestroyRemoveContents` | Carnet vidé |
| `files` | `onDestroyRemoveChildren` | Sous-arbre détruit |
| `files` | `onExists` | Création qui détruit |
| `sieve` | `onSuccessActivateScript` | Courrier entrant réécrit |
| `sharing` | `shareWith` | Octroi ou révocation |

La garde de politique doit donc classer l'appel sur ses arguments.
Un `Email/set` unique peut par ailleurs mélanger `create`, `update` et `destroy`.

**Le filtre silencieux**

Un nom d'en-tête mal formé dans un filtre `header` fait abandonner la condition sans erreur.
La requête renvoie plus de résultats que demandé, et rien ne le signale.

> [!CAUTION]
> Une opération destructrice ne prend jamais un filtre en entrée.
> Elle prend des identifiants, résolus par une recherche dont le résultat a été vu.

## ⏳ À vérifier sur instance réelle

| Point | Ce qui trancherait |
| --- | --- |
| Contenu de `emailQuerySortOptions` | Un `GET` sur l'URL de session |
| En-têtes réellement indexés | Un filtre `header` de test |
| Réécriture de `To:` par un alias | Un mail envoyé sur l'alias |
| Sémantique de `mayShare` en cascade | Un partage sur compte tiers |
| Comportement du rôle `trash` de `FileNode` | Un `destroy` observé |
| Version installée face à `main` | Le tag de la release |

## 📌 Écarts documentaires de Stalwart

| Sujet | README | Réalité |
| --- | --- | --- |
| Filenode | `-03` | `-14` au code et au CHANGELOG |
| Calendars | `-24` | Draft courant `-28`, delta additif |
| Sieve | `draft-ietf-jmap-sieve-22` | RFC 9661 |

Le README n'est pas une source fiable sur les révisions.
Le CHANGELOG et le code le sont.
