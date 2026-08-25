import { describe, expect, it } from "vitest";
import {
  RedactingLogger,
  redactLogFields,
  type LogRecord,
  type LogSink,
} from "../../src/platform/logging/index.js";

class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

describe("redacting logger", () => {
  it("redacts sensitive keys and common phone/JID/token-shaped values", () => {
    const fields = redactLogFields({
      player: "normal-player-label",
      phone: "+5511999999999",
      nested: {
        authToken: "secret-token",
        destination: "5511999999999@s.whatsapp.net",
        authorizationHeader: "Bearer abc.def",
      },
      genericPhoneValue: "5511988887777",
    });

    expect(fields).toEqual({
      player: "normal-player-label",
      phone: "[REDACTED]",
      nested: {
        authToken: "[REDACTED]",
        destination: "[REDACTED]",
        authorizationHeader: "[REDACTED]",
      },
      genericPhoneValue: "[REDACTED]",
    });
  });

  it("handles circular objects and arrays without throwing or mutating the source", () => {
    const circular: Record<string, unknown> = { label: "safe" };
    circular.self = circular;
    const circularArray: unknown[] = ["safe"];
    circularArray.push(circularArray);
    circular.array = circularArray;

    expect(redactLogFields(circular)).toEqual({
      label: "safe",
      self: "[CIRCULAR]",
      array: ["safe", "[CIRCULAR]"],
    });
    expect(circular.self).toBe(circular);
    expect(circularArray[1]).toBe(circularArray);
  });

  it("writes structured records only after redaction", () => {
    const sink = new MemorySink();
    const logger = new RedactingLogger(sink, { service: "engine", seed: "never-log-this" });

    logger.info("player.loaded", { playerId: "safe-id", jid: "123@s.whatsapp.net" });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toEqual({
      level: "info",
      event: "player.loaded",
      fields: {
        service: "engine",
        seed: "[REDACTED]",
        playerId: "safe-id",
        jid: "[REDACTED]",
      },
    });
  });
});
