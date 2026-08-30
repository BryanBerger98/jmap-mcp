import { CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";

/** search, read, compose, organize, attachments. */
export const mailDomain = defineDomain({
  name: "mail",
  requires: [CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
  tools: [],
});
