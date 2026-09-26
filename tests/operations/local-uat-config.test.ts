import { describe, expect, it } from "vitest";
import { localUatEnvironment } from "../../src/operations/local-uat-config.js";

const target = { host: "127.0.0.1", port: 55439, database: "postgres" };
const snapshot = {
  APP_ENV: "staging",
  RUNTIME_DATABASE_URL: "postgresql://pokemon_runtime@127.0.0.1:55439/postgres",
  DATABASE_URL: "postgresql://postgres@wrong/legacy",
  WHATSAPP_SESSION_KEY: "test",
  WHATSAPP_AUTH_KEY_BASE64: "test-key",
};
describe("durable local UAT configuration", () => {
  it("uses only the explicit runtime connection and keeps the existing session", () => {
    expect(localUatEnvironment(snapshot, target)).toMatchObject({
      DATABASE_URL: snapshot.RUNTIME_DATABASE_URL,
      WHATSAPP_SESSION_KEY: "test",
      WHATSAPP_AUTH_KEY_BASE64: "test-key",
    });
  });
  it.each([
    undefined,
    "postgresql://postgres@127.0.0.1:55439/postgres",
    "postgresql://pokemon_runtime@127.0.0.1:5432/postgres",
    "postgresql://pokemon_runtime@127.0.0.1:55439/other",
    "postgresql://pokemon_runtime@other:55439/postgres",
    "postgresql://pokemon_runtime@127.0.0.1:55439/postgres?options=x",
  ])("fails closed for missing or mismatched configuration", (url) => {
    const candidate: Record<string, string> = { ...snapshot };
    if (url === undefined) delete candidate.RUNTIME_DATABASE_URL;
    else candidate.RUNTIME_DATABASE_URL = url;
    expect(() => localUatEnvironment(candidate, target)).toThrow(/LOCAL_UAT/);
  });
});
