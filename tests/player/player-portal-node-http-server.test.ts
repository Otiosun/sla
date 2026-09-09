import { describe, expect, it } from "vitest";
import { startPlayerPortalHttpServer } from "../../src/adapters/http/player-portal-node-server.js";

class EchoHandler {
  public async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : "";
    return new Response(
      JSON.stringify({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body,
        authorization: request.headers.get("authorization"),
      }),
      {
        status: 201,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-player-portal-test": "forwarded",
        },
      },
    );
  }
}

describe("player portal Node HTTP transport", () => {
  it("forwards method, path, query, headers and body to the Fetch handler", async () => {
    const server = await startPlayerPortalHttpServer({
      handler: new EchoHandler(),
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/hub/world/travel?source=test`, {
        method: "POST",
        headers: {
          authorization: "Bearer smoke",
          "content-type": "application/json",
        },
        body: JSON.stringify({ destinationAreaId: "area-2" }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("x-player-portal-test")).toBe("forwarded");
      await expect(response.json()).resolves.toEqual({
        method: "POST",
        pathname: "/v1/hub/world/travel",
        search: "?source=test",
        body: JSON.stringify({ destinationAreaId: "area-2" }),
        authorization: "Bearer smoke",
      });
    } finally {
      await server.close();
    }
  });

  it("returns 500 without exposing thrown handler details", async () => {
    const server = await startPlayerPortalHttpServer({
      handler: {
        handle: async () => {
          throw new Error("sensitive backend detail");
        },
      },
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/boom`);
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "INTERNAL_ERROR" });
      expect(await response.clone().text()).not.toContain("sensitive backend detail");
    } finally {
      await server.close();
    }
  });
});
