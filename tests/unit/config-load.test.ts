import { describe, expect, it, vi } from "vitest";

/**
 * The config file is stubbed away rather than read: `loadConfig` looks under
 * the real home directory, and a developer who happens to have one there would
 * otherwise steer these assertions.
 */
vi.mock("node:fs/promises", () => ({
  readFile: async () => {
    const missing = new Error("ENOENT") as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  },
}));

const { loadConfig } = await import("../../src/config/load.js");
const { DEFAULT_BULK_CONFIRM_ABOVE, configSchema } = await import("../../src/config/schema.js");

/** The two keys the schema demands, so a files case says nothing else. */
const CREDENTIALS = {
  sessionUrl: "https://mail.example.com/.well-known/jmap",
  bearerToken: "a-token",
};

/** The two keys without which nothing loads at all. `process.env` is untouched. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    JMAP_SESSION_URL: "https://mail.example.com/.well-known/jmap",
    JMAP_BEARER_TOKEN: "a-token",
    ...extra,
  };
}

describe("bulk confirmation threshold", () => {
  it("defaults when nothing sets it", async () => {
    const config = await loadConfig(env());

    expect(config.bulkConfirmAbove).toBe(DEFAULT_BULK_CONFIRM_ABOVE);
  });

  it("takes the environment value as a number", async () => {
    const config = await loadConfig(env({ JMAP_BULK_CONFIRM_ABOVE: "5" }));

    expect(config.bulkConfirmAbove).toBe(5);
  });

  it("names the key rather than falling back when the value is not a number", async () => {
    const failure = loadConfig(env({ JMAP_BULK_CONFIRM_ABOVE: "a few" }));

    await expect(failure).rejects.toThrow(/bulkConfirmAbove/);
  });

  it("refuses a threshold of zero, which would confirm every single call", async () => {
    const failure = loadConfig(env({ JMAP_BULK_CONFIRM_ABOVE: "0" }));

    await expect(failure).rejects.toThrow(/bulkConfirmAbove/);
  });

  it("refuses a fractional threshold rather than rounding it", async () => {
    const failure = loadConfig(env({ JMAP_BULK_CONFIRM_ABOVE: "2.5" }));

    await expect(failure).rejects.toThrow(/bulkConfirmAbove/);
  });
});

/**
 * Read off the schema rather than through `loadConfig`: `files.localRoot` has no
 * environment equivalent, and the config file is stubbed away above.
 */
describe("local file directory", () => {
  it("takes a named directory", () => {
    const config = configSchema.parse({
      ...CREDENTIALS,
      files: { localRoot: "/Users/you/jmap-files" },
    });

    expect(config.files.localRoot).toBe("/Users/you/jmap-files");
  });

  it("refuses a relative path, naming the key", () => {
    const failure = () =>
      configSchema.parse({ ...CREDENTIALS, files: { localRoot: "jmap-files" } });

    expect(failure).toThrow(/files\.localRoot/);
  });

  it("refuses the filesystem root at load, not at the first transfer", () => {
    const failure = () => configSchema.parse({ ...CREDENTIALS, files: { localRoot: "/" } });

    // The containment check would refuse every path under it anyway, but by
    // accident and with a sentence blaming the path rather than the setting.
    expect(failure).toThrow(/files\.localRoot cannot be the filesystem root/);
  });
});
