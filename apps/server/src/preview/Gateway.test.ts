// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { EnvironmentId, PreviewGatewayError, ThreadId } from "@t3tools/contracts";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { makeGateway } from "./Gateway.ts";
import { makeGatewayServer } from "./GatewayTransport.ts";

const threadId = ThreadId.make("thread-one");
const environmentId = EnvironmentId.make("environment-one");
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups.length = 0;
});

function request(url: string, host = "localhost:9000", origin?: string) {
  const value = new NodeHttp.IncomingMessage(new NodeNet.Socket());
  value.url = url;
  value.headers = { host, ...(origin ? { "x-t3-preview-origin": origin } : {}) };
  return value;
}

function gateway(port = 9000, supported = true) {
  const result = makeGateway({ port, supported });
  cleanups.push(result.dispose);
  return result;
}

function register(owner: ReturnType<typeof makeGateway>, port = 5173, overrides = {}) {
  return owner.register(
    {
      threadId,
      environmentId,
      port,
      gatewayUrl: `http://127.0.0.1:9001/api/preview/${"a".repeat(32)}/`,
      expiresAt: Date.now() + 60_000,
      ...overrides,
    },
    "client-one",
  );
}

async function listen(server: NodeHttp.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return address.port;
}

async function listeningGateway() {
  let owner = gateway();
  const transport = makeGatewayServer((req) => owner.resolve(req));
  transport.server.on("request", (_request, response) => response.end("T3"));
  const port = await listen(transport.server);
  owner = gateway(port);
  cleanups.push(transport.dispose);
  return { owner, port };
}

function get(url: string, host: string, body?: string) {
  return new Promise<{ body: string; headers: NodeHttp.IncomingHttpHeaders }>((resolve, reject) => {
    const req = NodeHttp.request(
      url,
      { method: body ? "POST" : "GET", headers: { host } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (data: string) => {
          text += data;
        });
        response.on("end", () => resolve({ body: text, headers: response.headers }));
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("preview gateway capabilities", () => {
  it("scopes remote capabilities to one loopback port and rejects direct page navigation", () => {
    const owner = gateway();
    const result = owner.issue({ threadId, port: 5173 }, "client-one");
    const publicOrigin = `http://t3-preview-${"b".repeat(32)}.localhost:9000`;
    expect(owner.resolve(request(`${result.path}entry`))).toEqual({ status: 403 });
    const route = owner.resolve(
      request(`${result.path}api/items?q=1`, "server:9000", publicOrigin),
    );
    expect(route && "url" in route && route.url.href).toBe("http://localhost:5173/api/items?q=1");
    expect(
      owner.resolve(request(`/api/preview/${"c".repeat(32)}/`, "server:9000", publicOrigin)),
    ).toEqual({ status: 404 });
    expect(() => owner.issue({ threadId, port: 9000 }, "client-one")).toThrow(PreviewGatewayError);
    expect(owner.resolve(request("/api/other"))).toBeNull();
  });

  it("keeps each app origin stable and isolates environments, threads and ports", () => {
    const owner = gateway();
    const first = register(owner);
    expect(register(owner).origin).toBe(first.origin);
    expect(register(owner, 5174).origin).not.toBe(first.origin);
    expect(register(owner, 5173, { environmentId: EnvironmentId.make("other") }).origin).not.toBe(
      first.origin,
    );
    expect(register(owner, 5173, { threadId: ThreadId.make("other") }).origin).not.toBe(
      first.origin,
    );
    const host = new URL(first.origin).host;
    const route = owner.resolve(request("/api/preview/app-owned-route", host));
    expect(route && "url" in route && route.url.pathname).toBe(
      `/api/preview/${"a".repeat(32)}/api/preview/app-owned-route`,
    );
    owner.revoke(first.origin, "wrong-client");
    expect(owner.resolve(request("/", host))).not.toEqual({ status: 404 });
    owner.revoke(first.origin, "client-one");
    expect(owner.resolve(request("/", host))).toEqual({ status: 404 });
    expect(route && "signal" in route && route.signal.aborted).toBe(true);
  });

  it("renews future requests without interrupting active tabs and revokes both generations", () => {
    vi.useFakeTimers();
    const owner = gateway();
    const first = register(owner, 5173, { expiresAt: Date.now() + 50 });
    const host = new URL(first.origin).host;
    const previous = owner.resolve(request("/hmr", host));
    if (!previous || !("retain" in previous)) throw new Error("Missing preview route");
    const releasePrevious = previous.retain();
    vi.advanceTimersByTime(51);
    const renewed = register(owner, 5173, {
      gatewayUrl: `http://127.0.0.1:9001/api/preview/${"b".repeat(32)}/`,
    });
    expect(renewed.origin).toBe(first.origin);
    expect(previous.signal.aborted).toBe(false);
    expect(previous.url.pathname).toBe(`/api/preview/${"a".repeat(32)}/hmr`);
    const current = owner.resolve(request("/api/value", host));
    if (!current || !("retain" in current)) throw new Error("Missing renewed preview route");
    const releaseCurrent = current.retain();
    expect(current.url.pathname).toBe(`/api/preview/${"b".repeat(32)}/api/value`);
    owner.revoke(renewed.origin, "client-one");
    expect(previous.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(true);
    releasePrevious();
    releaseCurrent();
  });

  it("expires capabilities and closes their active transport scope", () => {
    vi.useFakeTimers();
    const owner = gateway();
    const result = register(owner, 5173, { expiresAt: Date.now() + 50 });
    const route = owner.resolve(request("/", new URL(result.origin).host));
    vi.advanceTimersByTime(51);
    expect(route && "signal" in route && route.signal.aborted).toBe(true);
    expect(owner.resolve(request("/", new URL(result.origin).host))).toEqual({ status: 404 });
    expect(() => register(owner, 5173, { expiresAt: Date.now() - 1 })).toThrow(PreviewGatewayError);
  });

  it("keeps active previews alive and expires them only after they become idle", () => {
    vi.useFakeTimers();
    const owner = gateway();
    const result = register(owner, 5173, { expiresAt: Date.now() + 50 });
    const host = new URL(result.origin).host;
    const route = owner.resolve(request("/hmr", host));
    if (!route || !("retain" in route)) throw new Error("Missing preview route");
    const release = route.retain();
    vi.advanceTimersByTime(60 * 60_000);
    expect(route.signal.aborted).toBe(false);
    expect(owner.resolve(request("/next", host))).not.toEqual({ status: 404 });
    release();
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(route.signal.aborted).toBe(true);
  });

  it("uses the actual listening port and leaves unrelated requests to T3", () => {
    const owner = gateway(0);
    owner.setListeningPort(43117);
    expect(new URL(register(owner).origin).port).toBe("43117");
    expect(() => owner.issue({ threadId, port: 43117 }, "client-one")).toThrow(PreviewGatewayError);
    expect(owner.resolve(request("/ws", "bad host"))).toBeNull();
    expect(owner.resolve(request("/api/environment", "bad host"))).toBeNull();
  });

  it("revokes an authenticated owner's remote and local routes without affecting another owner", () => {
    const owner = gateway();
    const first = register(owner);
    const remote = owner.issue({ threadId, port: 5173 }, "client-one");
    const other = owner.issue({ threadId, port: 5173 }, "client-two");
    const publicOrigin = first.origin;
    const active = owner.resolve(request(`${remote.path}hmr`, "server:9000", publicOrigin));
    if (!active || !("retain" in active)) throw new Error("Missing preview route");
    const release = active.retain();
    owner.revokeOwner("client-one");
    expect(active.signal.aborted).toBe(true);
    expect(owner.resolve(request("/", new URL(first.origin).host))).toEqual({ status: 404 });
    expect(owner.resolve(request(other.path, "server:9000", publicOrigin))).not.toEqual({
      status: 404,
    });
    release();
  });

  it("bounds leases, validates gateway targets and explicitly rejects unsupported runtimes", () => {
    const owner = gateway();
    for (let i = 0; i < 256; i++) owner.issue({ threadId, port: 5173 }, "client-one");
    expect(() => owner.issue({ threadId, port: 5173 }, "client-one")).toThrow(
      "Too many active previews",
    );
    expect(() => register(gateway(), 5173, { gatewayUrl: "http://localhost:8000/admin" })).toThrow(
      PreviewGatewayError,
    );
    expect(() =>
      register(gateway(), 5173, {
        gatewayUrl: `http://user:pass@localhost:8000/api/preview/${"a".repeat(32)}/`,
      }),
    ).toThrow(PreviewGatewayError);
    expect(() => gateway(9000, false).issue({ threadId, port: 5173 }, "client-one")).toThrow(
      "require a Node T3 server",
    );
  });

  it("carries root assets, API bodies, cookies and native WebSockets across two existing listeners", async () => {
    const app = NodeHttp.createServer((req, response) => {
      if (req.url === "/") response.end('<script src="/main.js"></script>');
      else if (req.url === "/main.js") response.end('fetch("/api/value")');
      else if (req.url === "/api/value") {
        response.setHeader("set-cookie", [
          "app=one; Domain=localhost; Path=/",
          "other=two; HttpOnly",
        ]);
        req.pipe(response);
      } else response.writeHead(404).end();
    });
    const appPort = await listen(app);
    const sockets = new NodeWS.WebSocketServer({
      server: app,
      handleProtocols: (values) => (values.has("vite-hmr") ? "vite-hmr" : false),
    });
    cleanups.push(() => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    });
    sockets.on("connection", (socket) =>
      socket.on("message", (data, binary) => socket.send(data, { binary })),
    );
    const remote = await listeningGateway();
    const local = await listeningGateway();
    const issued = remote.owner.issue({ threadId, port: appPort }, "remote-client");
    const registered = local.owner.register(
      {
        threadId,
        environmentId,
        port: appPort,
        gatewayUrl: `http://127.0.0.1:${remote.port}${issued.path}`,
        expiresAt: issued.expiresAt,
      },
      "local-client",
    );
    const host = new URL(registered.origin).host;
    const endpoint = `http://127.0.0.1:${local.port}`;
    expect((await get(endpoint, host)).body).toContain('src="/main.js"');
    expect((await get(`${endpoint}/main.js`, host)).body).toBe('fetch("/api/value")');
    const result = await get(`${endpoint}/api/value`, host, "application body");
    expect(result.body).toBe("application body");
    expect(result.headers["set-cookie"]).toEqual(["app=one; Path=/", "other=two; HttpOnly"]);
    const ws = new NodeWS.WebSocket(`ws://127.0.0.1:${local.port}/hmr`, ["other", "vite-hmr"], {
      headers: { host, origin: registered.origin },
    });
    cleanups.push(() => ws.terminate());
    await NodeEvents.EventEmitter.once(ws, "open");
    expect(ws.protocol).toBe("vite-hmr");
    const message = NodeEvents.EventEmitter.once(ws, "message");
    ws.send("refresh");
    expect((await message)[0].toString()).toBe("refresh");
    const closed = NodeEvents.EventEmitter.once(ws, "close");
    local.owner.revoke(registered.origin, "local-client");
    await closed;
  });
});
