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
    ...bulkConfirmFrom(env),
    ...recipientsFrom(env, fromFile.recipients),
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

/**
 * The bulk confirmation threshold, read as a number.
 *
 * An unreadable value travels to the schema unchanged rather than falling back
 * on the default: someone who set the key meant something by it, and running at
 * twenty behind their back would hide the typo until a bulk write went through
 * without asking.
 */
function bulkConfirmFrom(env: NodeJS.ProcessEnv): { bulkConfirmAbove?: number } {
  const raw = env.JMAP_BULK_CONFIRM_ABOVE;
  return raw === undefined ? {} : { bulkConfirmAbove: Number(raw) };
}

/**
 * The recipient perimeter, key by key.
 *
 * Merged rather than replaced: setting the scope from the environment must not
 * silently drop an allow list the config file carries. Absent from both, the
 * key stays absent and the schema defaults it open.
 */
function recipientsFrom(
  env: NodeJS.ProcessEnv,
  fromFile: unknown,
): { recipients?: Record<string, unknown> } {
  const base = typeof fromFile === "object" && fromFile !== null ? fromFile : {};

  const recipients = {
    ...base,
    ...definedOnly({ scope: env.JMAP_RECIPIENT_SCOPE }),
    ...(env.JMAP_RECIPIENT_ALLOW === undefined
      ? {}
      : { allow: splitList(env.JMAP_RECIPIENT_ALLOW) }),
  };

  return Object.keys(recipients).length === 0 ? {} : { recipients };
}

/** Comma-separated, and an empty entry is dropped rather than validated. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function definedOnly(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}
