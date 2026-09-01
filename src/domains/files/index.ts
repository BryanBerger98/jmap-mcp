import { CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { filesBrowse } from "./browse.js";
import { filesFetch } from "./fetch.js";

/** Reading the file tree, and moving bytes out of it onto this machine. */
export const filesDomain = defineDomain({
  name: "files",
  requires: [CAPABILITY_FILENODE],
  tools: [filesBrowse, filesFetch],
});
