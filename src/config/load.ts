import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Config, configSchema } from "./schema.js";

const CONFIG_PATH = join(homedir(), ".config", "jmap-mcp", "config.json");

/**
 * Resolves the configuration from the environment first, then the config file.
 * The environment wins so a client can override a stored config per registration.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const fromFile = await readConfigFile();

  const merged = {
    ...fromFile,
    ...definedOnly({
      sessionUrl: env.JMAP_SESSION_URL,
      bearerToken: env.JMAP_BEARER_TOKEN,
      accountId: env.JMAP_ACCOUNT_ID,
    }),
  };

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid jmap-mcp configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function readConfigFile(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function definedOnly(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}
