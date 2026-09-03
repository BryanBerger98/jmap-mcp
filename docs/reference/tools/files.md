# Files tools

Both manifests require the `urn:ietf:params:jmap:filenode` capability, and a server that does not advertise it drops all four tools at startup.
The two tools that move bytes, `files_fetch` and `files_write`, also need `files.localRoot` in the configuration file, as described in [configuration](../configuration.md); there is no environment variable for it.
Without that key both refuse by naming it, and browsing, creating a folder, organizing and deleting keep working without it.

Three things this server never does, whatever the arguments.
It never overwrites a local file: a fetch whose destination already exists is refused.
It never replaces an existing node: `onExists` is written `null` on every `FileNode/set`, so a name already taken is refused, and replacing a file is a destruction that goes through `files_delete`.
It never recovers a destroyed node: the file storage has no trash, and a deletion is final.

Every ceiling named below is listed in [limits](../limits.md).

## Reading

Manifest `files`, on the `urn:ietf:params:jmap:filenode` capability.

### files_browse

Lists and searches the file storage of the account, one line per node: file or folder, name, size, MIME type, and the id the other three tools take.
With no criterion the top level is listed; with `parentId` the direct children of one folder; with `ancestorId` a whole subtree; with a name, a type or a size alone, the search spans the account.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `parentId` | string | no | Direct children of this folder |
| `ancestorId` | string | no | Whole subtree under this folder |
| `name` | string | no | Exact name, matched in full |
| `nameMatch` | string | no | Substring matched against the name |
| `nodeType` | enum: file, directory | no | Restrict to files or to folders |
| `minSize` | integer | no | Smallest size in bytes, folders excluded |
| `maxSize` | integer | no | Largest size in bytes, folders excluded |
| `sort` | enum: name, size, nodeType | no | Result order, name by default |
| `descending` | boolean | no | Reverse the order, ascending by default |
| `limit` | integer | no | Nodes per page, 1 to 100, default 25 |
| `cursor` | string | no | Previous page cursor, same criteria |

Stalwart honours only nine filter conditions on `FileNode/query`, and this tool sends nothing outside them: the seven arguments above plus the top-level test it uses when no criterion is given.
Three things the server cannot do, whatever the arguments: it cannot sort by date, it cannot search inside the content of a file, and it cannot filter on a MIME type.
An unsupported sort is not refused by the server but silently dropped, which falls back to document order, so the schema only admits the three properties Stalwart sorts on.
Folders are listed before files inside each page.

**Refuses or asks.**
A cursor that cannot be decoded is refused with `Refused: that cursor is unreadable. Run the search again from the start.`
A cursor issued for other criteria, or a cursor whose result set changed on the server since it was issued, is refused before any node is shown.
Nothing else asks: a read poses no question.

Pagination: a page holds up to `limit` nodes, 25 by default, and is cut at about 3000 rendered characters; a cut page ends with `[more results — cursor: …]`, and the cursor is passed back with the same criteria.

Example prompts:

> List what is at the top level of my file storage.

> Find every PDF larger than 5 MB anywhere under my Invoices folder.

### files_fetch

Downloads one file from the account and writes it to the local directory this server was configured with, then answers with the path it wrote, the size and the MIME type.
The bytes never travel through the conversation: there is no excerpt, no preview and no base64 in the answer, and the content is read by opening the path.

Class: `read`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | File node id from `files_browse` |
| `saveAs` | string | no | Name or path under the local directory |

**Refuses or asks.**
The `precheck` refuses before any request when `files.localRoot` is unset, with `Refused: this server moves file bytes only inside a directory you have named, and files.localRoot is not set.`, and when the configured directory is missing, unreadable or a file.
The run then refuses an id that names nothing, a folder (`a folder holds no bytes to fetch`), a node without a `blobId`, a node larger than `files.maxDownloadSize` (100 MB by default, refused before any byte moves and naming the key to raise), a destination that resolves outside the root once every symlink is followed, and a destination that already exists.
A node whose size the server does not state is downloaded anyway.
Nothing asks: a read poses no question.

Example prompts:

> Download the contract Marie shared last week into my working folder.

> Save the file called budget.xlsx as budget-2026.xlsx on my machine.

## Writing

Manifest `files-writing`, on the same `urn:ietf:params:jmap:filenode` capability.

### files_write

Writes to the file storage of the account: deposits a local file, creates a folder, or renames and moves nodes that are already there.
Nothing here replaces or removes anything, and a deposit reads the local file only from inside the configured directory, the bytes travelling from that file and never through the conversation.

Class: `draft` on all three actions.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | enum: upload, create-folder, organize | yes | Deposit, create a folder, or organize |
| `path` | string | no | Local file to deposit, under the configured directory |
| `ids` | string[] | no | Nodes to rename or move |
| `name` | string | no | The name to give |
| `parentId` | string or null | no | Target folder, `null` for the top level |

| Action | Needs | Uses |
| --- | --- | --- |
| `upload` | `path` | `name` defaults to the local file name, `parentId` |
| `create-folder` | `name` | `parentId` |
| `organize` | `ids`, and `name` or `parentId` | `name` renames one node only |

**Refuses or asks.**
A name is checked before any request: empty, above 255 bytes, holding one of `/ < > : " \ | ? *`, or reserved (`.`, `..`, `CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9`) is refused.
An `organize` call is refused with no id, with more than 50 ids, with one `name` for several nodes, or with neither `name` nor `parentId`.
An `upload` is refused when `files.localRoot` is unset or unusable, when `path` resolves outside it with every symlink followed, when there is no file there, when it is a directory, and when it is larger than the `maxSizeUpload` the session advertises, all before any byte moves.

A `parentId` that names nothing, or names a file rather than a folder, is refused.
The server refuses a name already taken in the target folder, and this tool reports it rather than replacing the node.
`organize` asks a confirmation its class does not require above `bulkConfirmAbove` nodes, 20 by default.

Confirmation: the message names the count and the action, `This moves 30 file nodes at once, past the 20 this server writes without asking.`, and the summary names the nodes and the target folder; see the [write policy](../../explanation/write-policy.md).

Example prompts:

> Upload the report.pdf from my working folder into the Reports folder.

> Move these three files into the Archive folder.

### files_delete

Destroys the named files and folders, permanently: nothing holds a destroyed node and no later call brings it back.
It acts on ids only, taken from `files_browse`, because a search rerun here could match nodes you never saw.

Class: `destroy`.

| Argument | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ids` | string[] | yes | Node ids to destroy, from `files_browse` |
| `withChildren` | boolean | no | Take the whole subtree, false by default |

**Refuses or asks.**
More than 50 ids are refused before the tree is read.
The subtree of every folder named is counted first, and a count that cannot be established is refused with `Refused: what these ids hold could not be counted, so a confirmation would understate what disappears.`
A folder that still holds something is refused unless `withChildren` is set: `Destroying a folder never destroys what is inside it, so this call would fail on the server.`
The class always asks, and the confirmation is the only thing between the call and the loss.

Confirmation: the message names the nodes, then counts what hangs under them, `Permanently destroy 2 file nodes: Drafts (fn-3), notes.txt (fn-4), and everything under them: 4 files and 1 folder.`, and reminds that the storage has no trash; see the [write policy](../../explanation/write-policy.md).

Example prompts:

> Delete the two draft files I no longer need.

> Remove the old Projects folder together with everything inside it.
