import { describe, expect, it } from "vitest";
import {
  describeRadius,
  WIDE_RADIUS_ACTIONS,
  wideRadiusActions,
} from "../../src/domains/sieve/radius.js";
import { SCRIPT_TEXTS } from "../fixtures/sieve.js";

/**
 * The detector reads text and nothing else, so every case here is a string.
 *
 * The two directions are not symmetric and the tests say so: an action reported
 * where none runs is tolerated on purpose, an action that runs and goes
 * unreported is the failure this module exists to prevent.
 */

describe("wideRadiusActions", () => {
  it("names every wide-radius action a script carries", () => {
    const found = wideRadiusActions(SCRIPT_TEXTS["blob-sc-2"] ?? "");

    expect(found).toEqual([...WIDE_RADIUS_ACTIONS]);
  });

  it("names nothing in a script that only keeps and stops", () => {
    const neutral = `if header :contains "subject" "urgent" {
    setflag "\\\\Flagged";
    keep;
}
stop;
`;

    expect(wideRadiusActions(neutral)).toEqual([]);
  });

  it("orders by severity, not by where the action appears in the source", () => {
    const text = `require ["fileinto"];
fileinto "Invoices";
discard;
`;

    // fileinto comes first in the source and last in the answer: the order is
    // how much the action costs, never the reading order.
    expect(wideRadiusActions(text)).toEqual(["discard", "fileinto"]);
  });

  it("reads ereject as itself and never as a reject", () => {
    expect(wideRadiusActions('ereject "Not accepted";')).toEqual(["ereject"]);
  });

  describe("comments", () => {
    it("ignores a keyword behind a hash", () => {
      const text = `# This script used to discard everything.
keep;
`;

      expect(wideRadiusActions(text)).toEqual([]);
    });

    it("ignores a keyword inside a bracket comment, over several lines", () => {
      const text = `/* An older version:
     redirect "elsewhere@example.net";
*/
keep;
`;

      expect(wideRadiusActions(text)).toEqual([]);
    });

    it("keeps an action sitting behind a hash that is inside a string", () => {
      // The case a line-cutting regular expression gets wrong: the hash is
      // content, and the discard behind it is real.
      const text = 'if header :is "subject" "#" { discard; }';

      expect(wideRadiusActions(text)).toEqual(["discard"]);
    });

    it("does not fuse two words across a stripped comment", () => {
      expect(wideRadiusActions("dis# nothing\ncard;")).toEqual([]);
    });
  });

  describe("deliberate over-detection", () => {
    it("counts an action named only in a require list", () => {
      expect(wideRadiusActions('require ["reject"];\nkeep;\n')).toEqual(["reject"]);
    });

    it("counts an action named inside a string", () => {
      expect(wideRadiusActions('fileinto "discard";')).toEqual(["discard", "fileinto"]);
    });
  });
});

describe("describeRadius", () => {
  it("spells the consequence beside each action", () => {
    const sentence = describeRadius(["discard", "redirect"]);

    expect(sentence).toContain("discard — drop messages with no copy kept anywhere");
    expect(sentence).toContain("redirect — send mail on to another address, out of this account");
  });

  it("says so when the reading found nothing", () => {
    expect(describeRadius([])).toMatch(/none of the actions that lose or forward mail/);
  });
});
