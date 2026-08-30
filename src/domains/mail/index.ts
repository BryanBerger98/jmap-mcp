import { CAPABILITY_MAIL } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { mailFolders } from "./folders.js";

/**
 * search, read, locate.
 *
 * The manifest asks only for what its tools call. Requiring `submission` here
 * would silence three read tools on a server that does not send.
 */
export const mailDomain = defineDomain({
  name: "mail",
  requires: [CAPABILITY_MAIL],
  tools: [mailFolders],
});
