export interface LocalUatTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

export function localUatEnvironment(
  snapshot: Readonly<Record<string, string>>,
  target: LocalUatTarget,
): Record<string, string> {
  const value = snapshot.RUNTIME_DATABASE_URL;
  if (!value) throw new Error("LOCAL_UAT_RUNTIME_DATABASE_URL_REQUIRED");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LOCAL_UAT_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== "pokemon_runtime" ||
    url.hostname !== target.host ||
    Number(url.port || 5432) !== target.port ||
    decodeURIComponent(url.pathname.slice(1)) !== target.database ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("LOCAL_UAT_DATABASE_TARGET_MISMATCH");
  if (!snapshot.WHATSAPP_SESSION_KEY || !snapshot.WHATSAPP_AUTH_KEY_BASE64) {
    throw new Error("LOCAL_UAT_EXISTING_SESSION_REQUIRED");
  }
  if (snapshot.APP_ENV !== "staging" && snapshot.APP_ENV !== "development") {
    throw new Error("LOCAL_UAT_ENVIRONMENT_NOT_ALLOWED");
  }
  const result: Record<string, string> = { ...snapshot, DATABASE_URL: value };
  delete result.MIGRATOR_DATABASE_URL;
  return result;
}
