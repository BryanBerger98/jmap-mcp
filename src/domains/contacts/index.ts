import { CAPABILITY_CONTACTS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";

/** address books and cards. */
export const contactsDomain = defineDomain({
  name: "contacts",
  requires: [CAPABILITY_CONTACTS],
  tools: [],
});
