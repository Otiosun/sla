import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";

describe("PostgresMessagingRepository delayed outbox", () => {
  it("stores delayMs as durable next_attempt_at scheduling without sleeping the worker", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];

    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });

        if (text.includes("SELECT correlation_id, status, normalized_payload")) {
          return {
            rows: [
              {
                correlation_id: "00000000-0000-4000-8000-000000000031",
                status: "PROCESSING",
                normalized_payload: null,
              },
            ],
            rowCount: 1,
          };
        }

        if (text.includes("INSERT INTO outbox_messages")) {
          return { rows: [{ id: "outbox-1" }], rowCount: 1 };
        }

        if (text.includes("UPDATE inbox_messages")) {
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: null };
      },
      release: () => {},
    };

    const pool = {
      connect: async () => client,
    } as unknown as Pool;

    const repository = new PostgresMessagingRepository(pool);
    const result = await repository.completeIncoming("inbox-1", {
      resultRefType: null,
      resultRefId: null,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: "5511999999999@s.whatsapp.net",
          messageType: "TEXT",
          payload: { text: "Seu acesso está pronto." },
          idempotencyKey: "site:reply",
          delayMs: 5_000,
        },
      ],
    });

    expect(result.ok).toBe(true);

    const insert = calls.find((call) => call.text.includes("INSERT INTO outbox_messages"));
    expect(insert?.text).toContain("now() + ($7::bigint * interval '1 millisecond')");
    expect(insert?.values?.[6]).toBe(5_000);
  });

  it("defaults ordinary outgoing messages to zero delay", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];

    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });

        if (text.includes("SELECT correlation_id, status, normalized_payload")) {
          return {
            rows: [
              {
                correlation_id: "00000000-0000-4000-8000-000000000031",
                status: "PROCESSING",
                normalized_payload: null,
              },
            ],
            rowCount: 1,
          };
        }

        if (text.includes("INSERT INTO outbox_messages")) {
          return { rows: [{ id: "outbox-1" }], rowCount: 1 };
        }

        if (text.includes("UPDATE inbox_messages")) {
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: null };
      },
      release: () => {},
    };

    const pool = {
      connect: async () => client,
    } as unknown as Pool;

    const repository = new PostgresMessagingRepository(pool);
    const result = await repository.completeIncoming("inbox-1", {
      resultRefType: null,
      resultRefId: null,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: "120363000000000001@g.us",
          messageType: "TEXT",
          payload: { text: "Use /site no PV." },
          idempotencyKey: "site:group-reply",
        },
      ],
    });

    expect(result.ok).toBe(true);

    const insert = calls.find((call) => call.text.includes("INSERT INTO outbox_messages"));
    expect(insert?.values?.[6]).toBe(0);
  });
});
