import { CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { mailCompose } from "./compose.js";
import { mailDelete } from "./delete.js";
import { mailFolderManage } from "./folder-manage.js";
import { mailFolders } from "./folders.js";
import { mailIdentities } from "./identities.js";
import { mailOrganize } from "./organize.js";
import { mailRead } from "./read.js";
import { mailSearch } from "./search.js";
import { mailSend } from "./send.js";

/**
 * search, read, locate.
 *
 * The manifest asks only for what its tools call. Requiring `submission` here
 * would silence three read tools on a server that does not send.
 */
export const mailDomain = defineDomain({
  name: "mail",
  requires: [CAPABILITY_MAIL],
  tools: [mailSearch, mailRead, mailFolders],
});

/**
 * organize, delete, and the folder tree itself.
 *
 * A third manifest on the `mail` capability alone, kept apart from the reading
 * one so `mailDomain` stays provably read-only: the contract that says no tool
 * of that manifest writes is worth more than one fewer file here. Filing has
 * nothing to do with sending, so a server that cannot send still files.
 */
export const mailOrganizingDomain = defineDomain({
  name: "mail",
  requires: [CAPABILITY_MAIL],
  tools: [mailOrganize, mailDelete, mailFolderManage],
});

/**
 * compose, send.
 *
 * One domain, split in two manifests by capability rather than by subject: both
 * carry `name: "mail"` and both prefix their tools with `mail_`. `mail_identities`
 * sits here despite being a read, because `Identity` is a `submission` object and
 * a server that does not send has none.
 *
 * `requires` is checked against the session, not against the account: a session
 * may advertise submission while the selected account cannot use it, and that
 * mismatch surfaces as a JMAP error on the call, not as a missing tool.
 */
export const mailSendingDomain = defineDomain({
  name: "mail",
  requires: [CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
  tools: [mailIdentities, mailCompose, mailSend],
});
