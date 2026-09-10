import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for Player Portal entrypoint tests");
  return value;
})();

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a TCP port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error === undefined) resolve(port);
        else reject(error);
      });
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Player Portal entrypoint exited before becoming healthy");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response;
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Player Portal entrypoint did not become healthy");
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("Player Portal production entrypoint", () => {
  it("boots the dedicated HTTP process and shuts down cleanly on SIGTERM", async () => {
    const port = await findFreePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/player-portal-main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ENV: "test",
        LOG_LEVEL: "warn",
        DATABASE_URL: databaseUrl,
        PLAYER_PORTAL_SESSION_SIGNING_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
        ENCOUNTER_RNG_KEY_BASE64: Buffer.alloc(32, 12).toString("base64"),
        ENCOUNTER_RNG_KEY_VERSION: "1",
        PLAYER_PORTAL_HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: "ignore",
    });

    try {
      const health = await waitForHealth(port, child);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok",
        service: "pokemon-player-portal-api",
      });

      expect(child.kill("SIGTERM")).toBe(true);
      await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);
});
