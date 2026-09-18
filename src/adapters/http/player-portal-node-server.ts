import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface PlayerPortalFetchHandler {
  handle(request: Request): Promise<Response>;
}

export interface PlayerPortalHttpServerOptions {
  readonly handler: PlayerPortalFetchHandler;
  readonly host: string;
  readonly port: number;
  readonly onError?: (error: unknown) => void;
}

export interface RunningPlayerPortalHttpServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startPlayerPortalHttpServer(
  options: PlayerPortalHttpServerOptions,
): Promise<RunningPlayerPortalHttpServer> {
  const server = createServer((incoming, outgoing) => {
    void handleIncomingRequest(incoming, outgoing, options);
  });

  await listen(server, options.host, options.port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Player portal HTTP server did not expose a TCP address");
  }

  return {
    port: (address as AddressInfo).port,
    close: () => closeServer(server),
  };
}

async function handleIncomingRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: PlayerPortalHttpServerOptions,
): Promise<void> {
  try {
    const request = await toFetchRequest(incoming);
    const response = await options.handler.handle(request);
    await writeFetchResponse(response, outgoing, incoming.method ?? "GET");
  } catch (error) {
    options.onError?.(error);
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }

    outgoing.statusCode = 500;
    outgoing.setHeader("cache-control", "no-store");
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
  }
}

async function toFetchRequest(incoming: IncomingMessage): Promise<Request> {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
      continue;
    }
    headers.set(name, value);
  }

  const authority = incoming.headers.host ?? "localhost";
  const url = `http://${authority}${incoming.url ?? "/"}`;
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const body = await readRequestBody(incoming);
  return new Request(url, {
    method,
    headers,
    ...(body.byteLength === 0 ? {} : { body }),
  });
}

async function readRequestBody(incoming: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function writeFetchResponse(
  response: Response,
  outgoing: ServerResponse,
  requestMethod: string,
): Promise<void> {
  outgoing.statusCode = response.status;

  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie" && setCookies.length > 0) return;
    outgoing.setHeader(name, value);
  });
  if (setCookies.length > 0) {
    outgoing.setHeader("set-cookie", setCookies);
  }

  if (requestMethod === "HEAD") {
    outgoing.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
