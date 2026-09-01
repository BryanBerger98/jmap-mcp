import { describe, expect, it } from "vitest";
import { mailFlag } from "../../src/domains/mail/flag.js";
import { MAX_IDS_PER_CALL } from "../../src/domains/mail/organize.js";
import type { SetResponse } from "../../src/jmap/types/core.js";
import type { Email } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const partial = loadFixture<SetResponse<Email>>("email-set-updated.json");

const CLEAN: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-1",
  newState: "email-state-2",
  updated: { "m-1": null, "m-2": null },
};

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m-${index}`);
}

describe("mail_flag", () => {
  it("patches one keyword path and leaves every other property alone", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    await mailFlag.run({ ids: ["m-1", "m-2"], add: ["seen"] }, context);

    const call = requests[0]?.methodCalls[0];
    expect(call?.[0]).toBe("Email/set");
    expect(call?.[1]).toMatchObject({
      update: { "m-1": { "keywords/$seen": true }, "m-2": { "keywords/$seen": true } },
    });
    // Neither the whole keyword map nor the folders: marking moves nothing.
    const update = (call?.[1].update ?? {}) as Record<string, object>;
    expect(Object.keys(update["m-1"] ?? {})).toEqual(["keywords/$seen"]);
  });

  it("clears a keyword with null rather than false, as RFC 8620 patches do", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    await mailFlag.run({ ids: ["m-1"], remove: ["flagged"] }, context);

    const update = requests[0]?.methodCalls[0]?.[1].update as Record<string, object>;
    expect(update["m-1"]).toEqual({ "keywords/$flagged": null });
  });

  it("carries an add and a remove in the same patch", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    await mailFlag.run({ ids: ["m-1"], add: ["seen"], remove: ["flagged"] }, context);

    const update = requests[0]?.methodCalls[0]?.[1].update as Record<string, object>;
    expect(update["m-1"]).toEqual({ "keywords/$seen": true, "keywords/$flagged": null });
  });

  it("says which keywords it wrote, id by id", async () => {
    const { context } = fakeTransport([partial]);

    const { text } = await mailFlag.run(
      { ids: ["m-1", "m-2", "m-3"], add: ["seen"], remove: ["flagged"] },
      context,
    );

    expect(text).toContain("marked $seen, cleared $flagged");
    expect(text).toMatch(/m-3\s+refused: notFound/);
  });

  it("never asks, however many messages the marking covers", async () => {
    const { context } = fakeTransport([CLEAN], { bulkConfirmAbove: 2 });

    expect(mailFlag.confirmWhen).toBeUndefined();
    expect(await mailFlag.precheck?.({ ids: ids(100), add: ["seen"] }, context)).toContain(
      `batches of ${MAX_IDS_PER_CALL}`,
    );
    expect(await mailFlag.precheck?.({ ids: ids(50), add: ["seen"] }, context)).toBeUndefined();
  });

  it("refuses an empty list without emitting a single JMAP method", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    expect(await mailFlag.precheck?.({ ids: [], add: ["seen"] }, context)).toContain(
      "nothing to act on",
    );
    expect(requests).toHaveLength(0);
  });

  it("takes no keyword outside the standard set, and never $draft", () => {
    const parsed = mailFlag.inputSchema.safeParse({ ids: ["m-1"], add: ["draft"] });
    expect(parsed.success).toBe(false);

    const invented = mailFlag.inputSchema.safeParse({ ids: ["m-1"], add: ["urgent"] });
    expect(invented.success).toBe(false);
  });

  it("refuses a call that names no keyword at all", () => {
    expect(mailFlag.inputSchema.safeParse({ ids: ["m-1"] }).success).toBe(false);
    expect(mailFlag.inputSchema.safeParse({ ids: ["m-1"], add: [], remove: [] }).success).toBe(
      false,
    );
    expect(mailFlag.inputSchema.safeParse({ ids: ["m-1"], add: ["seen"] }).success).toBe(true);
  });
});
