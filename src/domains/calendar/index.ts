import { CAPABILITY_CALENDARS } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";

/** events, availability, participants. */
export const calendarDomain = defineDomain({
  name: "calendar",
  requires: [CAPABILITY_CALENDARS],
  tools: [],
});
