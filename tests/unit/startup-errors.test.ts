import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeStartupFailure } from "../../src/jmap/errors.js";
import { discoverSession } from "../../src/jmap/session.js";

/**
 * The three ways a startup dies. Discovery runs on an injected `fetchImpl`, so
 * no test here opens a socket.
 */

const SESSION_URL = "https://mail.example.com/.well-known/jmap";

const sessionBody = readFileSync(new URL("../fixtures/session.json", import.meta.url), "utf8");

const answering = (status: number, body = sessionBody): typeof fetch =>
  (async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

/** Shaped like a real undici refusal: a TypeError carrying the socket error as its cause. */
const offline: typeof fetch = () =>
  Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }));

/** Runs discovery and hands back whatever it threw. */
async function failureOf(fetchImpl: typeof fetch, accountId?: string): Promise<unknown> {
  try {
    await discoverSession(SESSION_URL, "a-token", accountId, fetchImpl);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("describeStartupFailure", () => {
  it("names the token when the server answers 401", async () => {
    const message = describeStartupFailure(await failureOf(answering(401, "{}")));

    expect(message).toContain("bearerToken");
  });

  it("treats a 403 the same way: the credentials are the thing to fix", async () => {
    const message = describeStartupFailure(await failureOf(answering(403, "{}")));

    expect(message).toContain("bearerToken");
  });

  it("names the session URL when the host cannot be reached", async () => {
    const message = describeStartupFailure(await failureOf(offline));

    expect(message).toContain("sessionUrl");
    expect(message).not.toContain("fetch failed");
  });

  it("names the requested account when it is not in the session", async () => {
    const message = describeStartupFailure(await failureOf(answering(200), "acc-missing"));

    expect(message).toContain("acc-missing");
  });

  it("keeps the three causes distinguishable", async () => {
    const messages = [
      describeStartupFailure(await failureOf(answering(401, "{}"))),
      describeStartupFailure(await failureOf(offline)),
      describeStartupFailure(await failureOf(answering(200), "acc-missing")),
    ];

    expect(new Set(messages).size).toBe(3);
  });

  it("does not blame the network for a TypeError raised past the transport", async () => {
    // A session body without `accounts` reaches `preferred in session.accounts`
    // and throws a causeless TypeError: the server answered, the URL is fine.
    const message = describeStartupFailure(
      await failureOf(answering(200, JSON.stringify({ capabilities: {} })), "acc-1"),
    );

    expect(message).not.toContain("sessionUrl");
    expect(message).not.toContain("could not be reached");
  });

  it("passes a configuration error through untouched", () => {
    const message = describeStartupFailure(new Error("Invalid jmap-mcp configuration: ..."));

    expect(message).toBe("Invalid jmap-mcp configuration: ...");
  });
});

describe("discoverSession", () => {
  it("resolves the primary core account when none is requested", async () => {
    const session = await discoverSession(SESSION_URL, "a-token", undefined, answering(200));

    expect(session.accountId).toBe("acc-1");
    expect(session.apiUrl).toBe("https://mail.example.com/jmap/");
  });
});
