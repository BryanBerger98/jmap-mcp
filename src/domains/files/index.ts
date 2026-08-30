import { CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";

/** file nodes and upload. */
export const filesDomain = defineDomain({
  name: "files",
  requires: [CAPABILITY_FILENODE],
  tools: [],
});
