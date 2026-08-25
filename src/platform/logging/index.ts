export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|jid|password|phone|secret|seed|token|whatsapp)/i;
const PHONE_LIKE_PATTERN = /^\+?\d{10,15}$/;
const JID_LIKE_PATTERN = /@(?:s\.whatsapp\.net|g\.us)$/i;
const BEARER_PATTERN = /^Bearer\s+\S+/i;

function sanitizeValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    if (
      PHONE_LIKE_PATTERN.test(value) ||
      JID_LIKE_PATTERN.test(value) ||
      BEARER_PATTERN.test(value)
    ) {
      return "[REDACTED]";
    }
    return value;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    return value.map((item) => sanitizeValue(item, key, seen));
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    const sanitized: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      sanitized[nestedKey] = sanitizeValue(nestedValue, nestedKey, seen);
    }
    return sanitized;
  }

  return value;
}

export function redactLogFields(fields: LogFields): Readonly<Record<string, unknown>> {
  const seen = new WeakSet<object>();
  seen.add(fields);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = sanitizeValue(value, key, seen);
  }
  return sanitized;
}

export class RedactingLogger implements Logger {
  readonly #sink: LogSink;
  readonly #baseFields: LogFields;

  constructor(sink: LogSink, baseFields: LogFields = {}) {
    this.#sink = sink;
    this.#baseFields = baseFields;
  }

  debug(event: string, fields: LogFields = {}): void {
    this.#write("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.#write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.#write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.#write("error", event, fields);
  }

  #write(level: LogLevel, event: string, fields: LogFields): void {
    if (event.trim().length === 0) {
      throw new TypeError("log event must not be empty");
    }
    this.#sink.write({
      level,
      event,
      fields: redactLogFields({ ...this.#baseFields, ...fields }),
    });
  }
}
