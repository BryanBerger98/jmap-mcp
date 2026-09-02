import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rightsOf } from "../../src/domains/sharing/rights.js";
import {
  displayNameOf,
  requireCapability,
  SHARE_TARGET_LIST,
  SHARE_TARGETS,
  shareTarget,
} from "../../src/domains/sharing/target.js";
import type { JmapSession } from "../../src/jmap/session.js";
import {
  CAPABILITY_CALENDARS,
  CAPABILITY_CONTACTS,
  CAPABILITY_FILENODE,
  CAPABILITY_MAIL,
} from "../../src/jmap/types/core.js";
import { SHAREABLE_TYPES } from "../../src/jmap/types/sharing.js";

function sessionWith(capabilities: readonly string[]): JmapSession {
  return { has: (uri: string) => capabilities.includes(uri) } as unknown as JmapSession;
}

/** Mail, calendars and contacts, but no file storage. */
const PARTIAL_SESSION = sessionWith([CAPABILITY_MAIL, CAPABILITY_CALENDARS, CAPABILITY_CONTACTS]);

describe("the target table", () => {
  it("covers the four shareable types and nothing else", () => {
    expect(Object.keys(SHARE_TARGETS).sort()).toEqual([...SHAREABLE_TYPES].sort());
    expect(SHARE_TARGET_LIST.map((entry) => entry.type)).toEqual([...SHAREABLE_TYPES]);
  });

  it("derives both method names from the type", () => {
    expect(shareTarget("Mailbox").getMethod).toBe("Mailbox/get");
    expect(shareTarget("FileNode").setMethod).toBe("FileNode/set");
  });

  it("binds each type to the capability its methods need", () => {
    expect(shareTarget("Mailbox").capability).toBe(CAPABILITY_MAIL);
    expect(shareTarget("Calendar").capability).toBe(CAPABILITY_CALENDARS);
    expect(shareTarget("AddressBook").capability).toBe(CAPABILITY_CONTACTS);
    expect(shareTarget("FileNode").capability).toBe(CAPABILITY_FILENODE);
  });

  it("reads the sharing properties and never the object's contents", () => {
    for (const type of SHAREABLE_TYPES) {
      const entry = shareTarget(type);

      expect(entry.properties).toEqual(["id", entry.displayNameProperty, "shareWith", "myRights"]);
      // Nothing that would carry a message, an event, a card or a byte.
      expect(entry.properties).not.toContain("blobId");
      expect(entry.properties).not.toContain("totalEmails");
    }
  });

  it("carries the display name property rather than leaving it to each tool", () => {
    for (const type of SHAREABLE_TYPES) {
      expect(shareTarget(type).displayNameProperty).toBe("name");
    }
  });

  it("takes its rights straight from the type's vocabulary", () => {
    for (const type of SHAREABLE_TYPES) {
      expect(shareTarget(type).rights).toEqual(rightsOf(type));
    }
  });
});

describe("requireCapability", () => {
  it("says nothing when the server advertises the capability", () => {
    expect(requireCapability("Mailbox", PARTIAL_SESSION)).toBeUndefined();
    expect(requireCapability("AddressBook", PARTIAL_SESSION)).toBeUndefined();
  });

  it("refuses a file node on a session without filenode, naming the capability", () => {
    // The composition is static: the schema still offers FileNode on a server
    // that has none, so the refusal happens here and says which capability is
    // missing rather than surfacing an unknown-method error.
    const refusal = requireCapability("FileNode", PARTIAL_SESSION);

    expect(refusal).toContain(CAPABILITY_FILENODE);
    expect(refusal).toContain("FileNode");
  });

  it("refuses each type on a session that advertises nothing", () => {
    const empty = sessionWith([]);

    for (const type of SHAREABLE_TYPES) {
      expect(requireCapability(type, empty)).toContain(shareTarget(type).capability);
    }
  });
});

describe("the two modules stay off the network", () => {
  it("imports no JMAP client", () => {
    // They describe a target and a vocabulary. Reading one is the tools' job,
    // and a client reachable from here would make a pure module testable only
    // against a fake server.
    for (const module of ["rights.ts", "target.ts"]) {
      const source = readFileSync(new URL(`../../src/domains/sharing/${module}`, import.meta.url), {
        encoding: "utf8",
      });

      expect(source).not.toContain("jmap/client");
      expect(source).not.toContain("JmapClient");
    }
  });
});

describe("displayNameOf", () => {
  it("reads the name the table names", () => {
    expect(displayNameOf("Calendar", { id: "c1", name: "Work" })).toBe("Work");
  });

  it("returns nothing when the read did not carry it", () => {
    expect(displayNameOf("Calendar", { id: "c1" })).toBeUndefined();
    expect(displayNameOf("FileNode", { id: "f1", name: null })).toBeUndefined();
  });
});
