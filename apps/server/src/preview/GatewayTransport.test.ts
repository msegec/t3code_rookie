// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { makeGatewayServer } from "./GatewayTransport.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.toReversed()) await dispose();
  cleanup.length = 0;
});

async function listen(server: NodeHttp.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return `http://127.0.0.1:${address.port}`;
}

async function gateway(upstream: string) {
  const controller = new AbortController();
  NodeEvents.EventEmitter.setMaxListeners(128, controller.signal);
  const leases = { acquired: 0, released: 0 };
  let publicOrigin = "";
  const transport = makeGatewayServer((request) =>
    request.url === "/ordinary"
      ? null
      : request.url === "/denied"
        ? { status: 403 }
        : {
            url: new URL(request.url ?? "/", upstream),
            publicOrigin,
            expiresAt: Date.now() + 60_000,
            isGateway: false,
            signal: controller.signal,
            retain: () => {
              leases.acquired++;
              return () => {
                leases.released++;
              };
            },
          },
  );
  transport.server.on("request", (_request, response) => response.end("ordinary"));
  publicOrigin = await listen(transport.server);
  cleanup.push(transport.dispose);
  return { origin: publicOrigin, controller, leases };
}

describe("preview gateway transport", () => {
  it("streams methods and bodies, preserves app cookies and rewrites the app origin", async () => {
    let received: NodeHttp.IncomingHttpHeaders = {};
    const app = NodeHttp.createServer((request, response) => {
      received = request.headers;
      response.setHeader("set-cookie", ["one=1; Domain=127.0.0.1; Path=/", "two=2; HttpOnly"]);
      response.write(`${request.method}:`);
      request.pipe(response);
    });
    const upstream = await listen(app);
    const { origin } = await gateway(upstream);
    const response = await fetch(`${origin}/submit`, {
      method: "POST",
      headers: {
        authorization: "secret",
        "proxy-authorization": "secret",
        "x-t3-forged": "secret",
        cookie: "app=ok",
        origin,
        referer: `${origin}/page`,
      },
      body: "streamed body",
    });
    expect(await response.text()).toBe("POST:streamed body");
    expect(response.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; HttpOnly"]);
    expect(received).toMatchObject({
      host: new URL(upstream).host,
      origin: upstream,
      referer: `${upstream}/page`,
      cookie: "app=ok",
    });
    expect(received.authorization).toBe("secret");
    expect(received["proxy-authorization"]).toBeUndefined();
    expect(received["x-t3-forged"]).toBeUndefined();
    expect(await (await fetch(`${origin}/ordinary`)).text()).toBe("ordinary");
    expect((await fetch(`${origin}/denied`)).status).toBe(403);
  });

  it("rewrites absolute application redirects and preserves root-relative redirects", async () => {
    const app = NodeHttp.createServer((request, response) =>
      response
        .writeHead(302, {
          location:
            request.url === "/absolute"
              ? `http://${request.headers.host}/next`
              : request.url === "/alias"
                ? `http://localhost:${new URL(`http://${request.headers.host}`).port}/next?x=1#anchor`
                : "/next",
        })
        .end(),
    );
    const { origin } = await gateway(await listen(app));
    expect(
      (await fetch(`${origin}/absolute`, { redirect: "manual" })).headers.get("location"),
    ).toBe(`${origin}/next`);
    expect(
      (await fetch(`${origin}/relative`, { redirect: "manual" })).headers.get("location"),
    ).toBe("/next");
    expect((await fetch(`${origin}/alias`, { redirect: "manual" })).headers.get("location")).toBe(
      `${origin}/next?x=1#anchor`,
    );
  });

  it("cancels upstream streams when the browser disconnects or the capability expires", async () => {
    let markClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const app = NodeHttp.createServer((_request, response) => {
      response.write("stream begins");
      response.once("close", markClosed);
    });
    const { origin, controller } = await gateway(await listen(app));
    const browser = await fetch(origin);
    await browser.body?.cancel();
    await closed;
    const second = await fetch(origin);
    controller.abort();
    await expect(second.text()).rejects.toThrow();
    expect((await fetch(origin)).status).toBe(410);
  });

  it("negotiates the upstream-selected protocol and relays text, binary, and close codes", async () => {
    const app = NodeHttp.createServer();
    const upstream = new NodeWS.WebSocketServer({
      server: app,
      handleProtocols: (protocols) => protocols.has("second") && "second",
    });
    cleanup.push(() => {
      for (const client of upstream.clients) client.terminate();
      upstream.close();
    });
    upstream.on("connection", (socket) =>
      socket.on("message", (data, binary) => {
        if (data.toString() === "close") socket.close(4001, "finished");
        else socket.send(data, { binary });
      }),
    );
    const { origin } = await gateway(await listen(app));
    const browser = new NodeWS.WebSocket(origin.replace("http:", "ws:"), ["first", "second"]);
    cleanup.push(() => browser.terminate());
    await NodeEvents.EventEmitter.once(browser, "open");
    expect(browser.protocol).toBe("second");
    const text = NodeEvents.EventEmitter.once(browser, "message");
    browser.send("hello");
    const [textData, textBinary] = await text;
    expect(textData.toString()).toBe("hello");
    expect(textBinary).toBe(false);
    const binary = NodeEvents.EventEmitter.once(browser, "message");
    browser.send(Buffer.from([0, 255, 12]));
    const [binaryData, isBinary] = await binary;
    expect(binaryData).toEqual(Buffer.from([0, 255, 12]));
    expect(isBinary).toBe(true);
    const close = NodeEvents.EventEmitter.once(browser, "close");
    browser.send("close");
    const [code, reason] = await close;
    expect(code).toBe(4001);
    expect(reason.toString()).toBe("finished");
  });

  it("relays client close codes to the app and aborts open sockets on revocation", async () => {
    const app = NodeHttp.createServer();
    const upstream = new NodeWS.WebSocketServer({ server: app });
    cleanup.push(() => {
      for (const client of upstream.clients) client.terminate();
      upstream.close();
    });
    const { origin, controller } = await gateway(await listen(app));
    const accepted = NodeEvents.EventEmitter.once(upstream, "connection");
    const browser = new NodeWS.WebSocket(origin.replace("http:", "ws:"));
    cleanup.push(() => browser.terminate());
    const [remote] = await accepted;
    await NodeEvents.EventEmitter.once(browser, "open");
    const closed = NodeEvents.EventEmitter.once(remote, "close");
    browser.close(4002, "client done");
    const [code, reason] = await closed;
    expect(code).toBe(4002);
    expect(reason.toString()).toBe("client done");
    const second = new NodeWS.WebSocket(origin.replace("http:", "ws:"));
    cleanup.push(() => second.terminate());
    await NodeEvents.EventEmitter.once(second, "open");
    const revoked = NodeEvents.EventEmitter.once(second, "close");
    controller.abort();
    await revoked;
  });

  it("rejects malformed upgrade protocols without affecting normal requests", async () => {
    const { origin, leases } = await gateway("http://127.0.0.1:1");
    const request = NodeHttp.request(origin, {
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
        "sec-websocket-protocol": "duplicate, duplicate",
      },
    });
    const response = NodeEvents.EventEmitter.once(request, "response");
    request.end();
    const [incoming] = await response;
    incoming.resume();
    expect(incoming.statusCode).toBe(502);
    expect(await (await fetch(`${origin}/ordinary`)).text()).toBe("ordinary");
    expect(leases).toEqual({ acquired: 0, released: 0 });
  });

  it("bounds concurrent streams and releases each lease once on cancellation", async () => {
    const app = NodeHttp.createServer((_request, response) => response.write("open"));
    const { origin, controller, leases } = await gateway(await listen(app));
    const responses = await Promise.all(Array.from({ length: 128 }, () => fetch(origin)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await fetch(origin)).status).toBe(503);
    expect(leases).toEqual({ acquired: 128, released: 0 });
    const bodies = responses.map((response) => response.text());
    controller.abort();
    await Promise.allSettled(bodies);
    expect(leases).toEqual({ acquired: 128, released: 128 });
  });
});
