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
const URL_CREDENTIAL_PATTERN = /((?:https?|postgres(?:ql)?):\/\/[^:\s/@]+):([^@\s/]+)@/gi;
const INLINE_BEARER_PATTERN = /Bearer\s+\S+/gi;
const INLINE_JID_PATTERN = /\b\d+@(?:s\.whatsapp\.net|g\.us)\b/gi;
const INLINE_PHONE_PATTERN = /(?<!\d)\+?\d{10,15}(?!\d)/g;
const COMMON_TOKEN_PATTERN = /\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+\b/g;

function redactSensitiveText(value: string): string {
  return value
    .replace(URL_CREDENTIAL_PATTERN, "$1:[REDACTED]@")
    .replace(INLINE_BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(INLINE_JID_PATTERN, "[REDACTED]")
    .replace(COMMON_TOKEN_PATTERN, "[REDACTED]")
    .replace(INLINE_PHONE_PATTERN, "[REDACTED]");
}

function sanitizeValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactSensitiveText(value.message) };
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
