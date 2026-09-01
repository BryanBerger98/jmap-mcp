import { CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { filesBrowse } from "./browse.js";
import { filesFetch } from "./fetch.js";
import { filesWrite } from "./write.js";

/** Reading the file tree, and moving bytes out of it onto this machine. */
export const filesDomain = defineDomain({
  name: "files",
  requires: [CAPABILITY_FILENODE],
  tools: [filesBrowse, filesFetch],
});

/**
 * Writing to the same storage, split off for the reason mail and contacts were.
 *
 * One manifest would have made `filesDomain` merely observed to write nothing;
 * two make it provable, and a contract test holds the line without a reviewer.
 */
export const filesWritingDomain = defineDomain({
  name: "files",
  requires: [CAPABILITY_FILENODE],
  tools: [filesWrite],
});
