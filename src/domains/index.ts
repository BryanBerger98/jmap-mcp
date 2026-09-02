import type { DomainManifest } from "../registry/manifest.js";
import {
  calendarAvailabilityDomain,
  calendarDomain,
  calendarWritingDomain,
} from "./calendar/index.js";
import { contactsDomain, contactsWritingDomain } from "./contacts/index.js";
import { filesDomain, filesWritingDomain } from "./files/index.js";
import { mailDomain, mailOrganizingDomain, mailSendingDomain } from "./mail/index.js";
import { sharingDomain } from "./sharing/index.js";
import { sieveDomain, sieveVacationDomain } from "./sieve/index.js";

export const ALL_DOMAINS: readonly DomainManifest[] = [
  mailDomain,
  mailOrganizingDomain,
  mailSendingDomain,
  calendarDomain,
  calendarAvailabilityDomain,
  calendarWritingDomain,
  contactsDomain,
  contactsWritingDomain,
  filesDomain,
  filesWritingDomain,
  sharingDomain,
  sieveDomain,
  sieveVacationDomain,
];
