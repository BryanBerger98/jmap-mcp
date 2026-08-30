import { CAPABILITY_SIEVE, CAPABILITY_VACATION } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";

/** Sieve scripts and the vacation responder. */
export const sieveDomain = defineDomain({
  name: "sieve",
  requires: [CAPABILITY_SIEVE, CAPABILITY_VACATION],
  tools: [],
});
