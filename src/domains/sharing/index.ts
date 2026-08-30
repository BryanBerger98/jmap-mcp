import { CAPABILITY_PRINCIPALS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";

/** principals and access rights. */
export const sharingDomain = defineDomain({
  name: "sharing",
  requires: [CAPABILITY_PRINCIPALS],
  tools: [],
});
