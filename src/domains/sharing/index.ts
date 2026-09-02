import { CAPABILITY_PRINCIPALS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { sharingAccess } from "./access.js";
import { sharingManage } from "./manage.js";

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

/**
 * Changing who has access, on the same capability as reading it.
 *
 * A second manifest for the reason that holds in the four other domains: the
 * reading surface above stays provably free of any write, and a contract test
 * proves it by walking that manifest rather than by reading the code.
 *
 * The name is `sharing-writing` and not `sharing`. The composition report names
 * the domains it skipped, and two entries under one name would not say which of
 * the two surfaces fell silent.
 */
export const sharingWritingDomain = defineDomain({
  name: "sharing-writing",
  requires: [CAPABILITY_PRINCIPALS],
  tools: [sharingManage],
});
