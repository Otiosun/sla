import type { Clock } from "../clock/index.js";
import type { CausalityContext } from "../../shared-kernel/causality.js";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly context: unknown;
}

export interface LogSink {
  write(entry: StructuredLogEntry): void;
}

const sensitiveKeys = new Set([
  "apikey",
  "authorization",
  "cookie",
  "jid",
  "password",
  "phone",
  "phonenumber",
  "seed",
  "secret",
  "token",
]);

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b\d{10,15}\b/g, "[REDACTED_PHONE]");
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    output[key] = sensitiveKeys.has(normalizedKey) ? "[REDACTED]" : redact(nested, seen);
  }
  return output;
}

export function redactLogContext(context: unknown): unknown {
  return redact(context, new WeakSet<object>());
}

export class JsonLineStdoutSink implements LogSink {
  public write(entry: StructuredLogEntry): void {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

export class StructuredLogger {
  public constructor(
    private readonly clock: Clock,
    private readonly sink: LogSink,
  ) {}

  public log(
    level: LogLevel,
    event: string,
    context: unknown = {},
    causality: CausalityContext | null = null,
  ): void {
    this.sink.write({
      timestamp: this.clock.now().toISOString(),
      level,
      event,
      correlationId: causality?.correlationId ?? null,
      causationId: causality?.causationId ?? null,
      context: redactLogContext(context),
    });
  }
}
