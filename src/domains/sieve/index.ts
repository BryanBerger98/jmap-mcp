import { CAPABILITY_SIEVE, CAPABILITY_VACATION } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { sieveScripts } from "./scripts.js";
import { vacationManage } from "./vacation.js";
import { sieveWrite } from "./write.js";

/** Reading the Sieve filters of the account, and nothing else. */
export const sieveDomain = defineDomain({
  name: "sieve",
  requires: [CAPABILITY_SIEVE],
  tools: [sieveScripts],
});

/**
 * Writing them, split off the reading manifest on the same capability.
 *
 * The reason the mail, contacts, calendar and files domains split the same way:
 * `sieveDomain` stays provably free of any write, and a contract asserting it is
 * worth more than one file fewer.
 */
export const sieveWritingDomain = defineDomain({
  // Suffixed apart from `sieve` for the reason the files split carries: the
  // composition report names a skipped domain, and two entries reading "sieve"
  // would not say which surface went quiet.
  name: "sieve-writing",
  requires: [CAPABILITY_SIEVE],
  tools: [sieveWrite],
});

/**
 * The vacation response, split off from the scripts rather than folded in.
 *
 * Not a stylistic split: Stalwart grants the two capabilities through two
 * independent permissions, `JmapSieveScriptGet` and `JmapVacationResponseGet`
 * (`api/session.rs:113` and `:118`). An administrator who withdraws the first
 * and keeps the second is a plausible account, and a single manifest would take
 * the vacation response away from them along with the scripts.
 */
export const sieveVacationDomain = defineDomain({
  // Named apart from the scripts manifest, as the files and contacts splits
  // are: the composition report lists a skipped domain by name, and two
  // entries reading "sieve" would say nothing about which surface went quiet.
  name: "sieve-vacation",
  requires: [CAPABILITY_VACATION],
  tools: [vacationManage],
});
