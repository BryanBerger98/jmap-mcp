import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../../src/server.js";

describe("SERVER_VERSION", () => {
  it("is the version the package manifest publishes", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});
