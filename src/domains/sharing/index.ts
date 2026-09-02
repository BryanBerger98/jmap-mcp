import { CAPABILITY_PRINCIPALS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { sharingAccess } from "./access.js";

/**
 * Reading who has access to what, in both directions.
 *
 * Gated on `principals` alone, which is what carries the notifications and the
 * directory. The four shareable types each need their own capability on top, and
 * that one is checked at call time: the composition is static, so the schema
 * cannot shrink to hide a type this server does not serve.
 */
export const sharingDomain = defineDomain({
  name: "sharing",
  requires: [CAPABILITY_PRINCIPALS],
  tools: [sharingAccess],
});
