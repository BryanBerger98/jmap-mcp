import { CAPABILITY_CONTACTS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { contactsDelete } from "./delete.js";
import { contactsRead } from "./read.js";
import { contactsSearch } from "./search.js";
import { contactsWrite } from "./write.js";

/**
 * address books and cards, read only.
 *
 * The reading surface keeps a manifest of its own now that a second one writes:
 * splitting them is what makes "nothing in this manifest writes" a claim a
 * contract test can hold, rather than a comment somebody has to trust.
 */
export const contactsDomain = defineDomain({
  name: "contacts",
  requires: [CAPABILITY_CONTACTS],
  tools: [contactsSearch, contactsRead],
});

/**
 * The tools that change an address book.
 *
 * On the contacts capability alone, like the reading surface: JMAP has no second
 * capability for writing cards, so the split buys a provable boundary rather
 * than a different gate.
 */
export const contactsWritingDomain = defineDomain({
  name: "contacts-writing",
  requires: [CAPABILITY_CONTACTS],
  tools: [contactsWrite, contactsDelete],
});
