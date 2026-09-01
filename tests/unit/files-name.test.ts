import { describe, expect, it } from "vitest";
import { MAX_NAME_BYTES, refuseInvalidName } from "../../src/domains/files/name.js";

describe("refuseInvalidName", () => {
  it("accepts an ordinary name", () => {
    expect(refuseInvalidName("report.pdf")).toBeUndefined();
    expect(refuseInvalidName("Rapport annuel — 2026")).toBeUndefined();
  });

  it("refuses an empty name", () => {
    expect(refuseInvalidName("")).toMatch(/cannot be empty/);
  });

  describe("length, counted in bytes", () => {
    it("accepts 255 bytes and refuses 256", () => {
      const at = "a".repeat(MAX_NAME_BYTES);
      const over = "a".repeat(MAX_NAME_BYTES + 1);

      expect(refuseInvalidName(at)).toBeUndefined();
      expect(refuseInvalidName(over)).toMatch(/256 bytes long/);
    });

    it("counts bytes and not code points, so an accented name reaches the limit sooner", () => {
      // 128 two-byte characters: 128 code points, 256 bytes.
      const accented = "é".repeat(128);

      expect(accented.length).toBe(128);
      expect(refuseInvalidName(accented)).toMatch(/256 bytes long/);
    });
  });

  describe("forbidden characters", () => {
    it("names the offending character in the refusal", () => {
      const refusal = refuseInvalidName("year/month");

      expect(refusal).toBeDefined();
      expect(refusal).toContain("/");
      expect(refusal).toMatch(/does not allow in a name/);
    });

    it.each(["<", ">", ":", '"', "\\", "|", "?", "*"])("refuses %s", (char) => {
      expect(refuseInvalidName(`draft${char}1`)).toBeDefined();
    });
  });

  describe("reserved names", () => {
    it("refuses com1 exactly as it refuses COM1", () => {
      expect(refuseInvalidName("COM1")).toMatch(/reserved name/);
      expect(refuseInvalidName("com1")).toMatch(/reserved name/);
      expect(refuseInvalidName("Com1")).toMatch(/reserved name/);
    });

    it("refuses the two relative directory names", () => {
      expect(refuseInvalidName(".")).toMatch(/reserved name/);
      expect(refuseInvalidName("..")).toMatch(/reserved name/);
    });

    it("does not refuse a name that merely starts with a reserved one", () => {
      expect(refuseInvalidName("COM1.txt")).toBeUndefined();
      expect(refuseInvalidName("CONTRACT")).toBeUndefined();
    });
  });
});
