import { CAPABILITY_CONTACTS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { contactsSearch } from "./search.js";

/**
 * address books and cards, read only.
 *
 * One manifest, on the contacts capability alone: nothing here writes, so there
 * is no second capability to gate on and no reason to split the surface.
 */
export const contactsDomain = defineDomain({
  name: "contacts",
  requires: [CAPABILITY_CONTACTS],
  tools: [contactsSearch],
});
