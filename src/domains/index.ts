import type { DomainManifest } from "../registry/manifest.js";
import { calendarDomain } from "./calendar/index.js";
import { contactsDomain } from "./contacts/index.js";
import { filesDomain } from "./files/index.js";
import { mailDomain, mailOrganizingDomain, mailSendingDomain } from "./mail/index.js";
import { sharingDomain } from "./sharing/index.js";
import { sieveDomain } from "./sieve/index.js";

export const ALL_DOMAINS: readonly DomainManifest[] = [
  mailDomain,
  mailOrganizingDomain,
  mailSendingDomain,
  calendarDomain,
  contactsDomain,
  filesDomain,
  sharingDomain,
  sieveDomain,
];
