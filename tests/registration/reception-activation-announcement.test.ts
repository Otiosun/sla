import { describe, expect, it } from "vitest";
import { PostgresReceptionActivationAnnouncement } from "../../src/platform/registration/postgres-reception-activation-announcement.js";

const REVIEW_ID = "00000000-0000-4000-8000-000000000901";
const PLAYER_ID = "00000000-0000-4000-8000-000000000902" as never;
const GROUP_ID = "00000000-0000-4000-8000-000000000903";

describe("Reception activation announcement", () => {
  it("enqueues the /menu route with the existing durable idempotency key", async () => {
    const queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        queries.push(values === undefined ? { text } : { text, values });
        if (text.includes("FROM outbox_messages review_notification")) {
          return { rows: [{ id: GROUP_ID, chat_ref: "120363000000000001@g.us" }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO outbox_messages")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const announcement = new PostgresReceptionActivationAnnouncement({
      connect: async () => client,
    } as never);

    await announcement.enqueueActivated({
      reviewId: REVIEW_ID,
      playerId: PLAYER_ID,
      trainerName: "Liora Vale",
    });

    const insert = queries.find((query) => query.text.includes("INSERT INTO outbox_messages"));
    if (insert?.values === undefined) throw new Error("Expected activation outbox insert");
    expect(JSON.parse(String(insert.values[2]))).toMatchObject({
      text: expect.stringMatching(/Liora Vale[\s\S]*\/menu/i),
      registrationActivation: { reviewId: REVIEW_ID, playerId: PLAYER_ID },
    });
    expect(insert.values[3]).toBe(`registration-activated:${REVIEW_ID}:${GROUP_ID}`);
    const sourceLookup = queries.find((query) =>
      query.text.includes("FROM outbox_messages review_notification"),
    );
    expect(sourceLookup?.values).toEqual([REVIEW_ID]);
    expect(sourceLookup?.text).toMatch(/registrationReview,reviewId/);
  });

  it("fails closed instead of broadcasting when the source Reception cannot be resolved", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("FROM outbox_messages review_notification")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const announcement = new PostgresReceptionActivationAnnouncement({
      connect: async () => client,
    } as never);

    await expect(
      announcement.enqueueActivated({
        reviewId: REVIEW_ID,
        playerId: PLAYER_ID,
        trainerName: "Liora Vale",
      }),
    ).rejects.toThrow(/source Reception/i);
    expect(queries.some((text) => text.includes("INSERT INTO outbox_messages"))).toBe(false);
  });
});
