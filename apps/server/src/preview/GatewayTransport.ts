// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";

export type GatewayTarget = {
  url: URL;
  publicOrigin: string;
  expiresAt: number;
  isGateway: boolean;
  signal: AbortSignal;
  retain: () => () => void;
};

export type GatewayRoute = GatewayTarget | { status: number } | null;

const MAX_ACTIVE = 128;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const HEADER_TIMEOUT = 15_000;
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function cleanHeaders(source: NodeHttp.IncomingHttpHeaders) {
  const headers = { ...source };
  for (const name of [...HOP_HEADERS, ...(source.connection?.split(",") ?? [])]) {
    delete headers[name.trim().toLowerCase()];
  }
  return headers;
}

function requestHeaders(request: NodeHttp.IncomingMessage, target: GatewayTarget) {
  const headers = cleanHeaders(request.headers);
  for (const name of Object.keys(headers)) {
    if (name.startsWith("x-t3-")) delete headers[name];
  }
  headers.host = target.url.host;
  if (target.isGateway) headers["x-t3-preview-origin"] = target.publicOrigin;
  else {
    for (const name of ["origin", "referer"]) {
      const value = headers[name];
      if (typeof value !== "string") continue;
      if (value === target.publicOrigin || value.startsWith(`${target.publicOrigin}/`)) {
        headers[name] = target.url.origin + value.slice(target.publicOrigin.length);
      }
    }
  }
  return headers;
}

function responseHeaders(source: NodeHttp.IncomingHttpHeaders, target: GatewayTarget) {
  const headers = cleanHeaders(source);
  if (target.isGateway) return headers;
  const location = headers.location;
  if (location && URL.canParse(location)) {
    const redirect = new URL(location);
    if (
      redirect.origin === target.url.origin ||
      (["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) &&
        redirect.port === target.url.port &&
        redirect.protocol === target.url.protocol)
    ) {
      headers.location = target.publicOrigin + redirect.pathname + redirect.search + redirect.hash;
    }
  }
  if (headers["set-cookie"]) {
    headers["set-cookie"] = headers["set-cookie"].map((cookie) =>
      cookie.replace(/;\s*Domain=\.?([^;]+)/gi, (attribute, domain: string) =>
        [target.url.hostname, "localhost", "127.0.0.1", "[::1]"].includes(domain.toLowerCase())
          ? ""
          : attribute,
      ),
    );
  }
  return headers;
}

export function makeGatewayServer(
  resolveRequest: (request: NodeHttp.IncomingMessage) => GatewayRoute,
) {
  const active = new Set<() => void>();
  const sockets = new NodeWS.WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  let disposed = false;

  function proxyHttp(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    target: GatewayTarget,
  ) {
    const upstream = (target.url.protocol === "https:" ? NodeHttps : NodeHttp).request(target.url, {
      method: request.method,
      headers: requestHeaders(request, target),
    });
    const releaseLease = target.retain();
    let released = false;
    let upstreamResponse: NodeHttp.IncomingMessage | undefined;
    const timeout = setTimeout(() => {
      if (!response.headersSent) response.writeHead(504);
      response.end();
      cancel();
    }, HEADER_TIMEOUT).unref();
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      target.signal.removeEventListener("abort", cancel);
      active.delete(cancel);
      releaseLease();
    };
    const cancel = () => {
      upstream.destroy();
      upstreamResponse?.destroy();
      response.destroy();
      release();
    };
    active.add(cancel);
    target.signal.addEventListener("abort", cancel, { once: true });
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableFinished) cancel();
      else release();
    });
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
      release();
    });
    upstream.once("response", (incoming) => {
      upstreamResponse = incoming;
      clearTimeout(timeout);
      response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers, target));
      incoming.once("error", cancel);
      incoming.pipe(response);
    });
    request.pipe(upstream);
  }

  function proxyWebSocket(
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
    target: GatewayTarget,
  ) {
    const url = new URL(target.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const headers = requestHeaders(request, target);
    for (const name of Object.keys(headers)) {
      if (name.startsWith("sec-websocket-")) delete headers[name];
    }
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim());
    const upstream = new NodeWS.WebSocket(url, protocols, {
      headers,
      handshakeTimeout: HEADER_TIMEOUT,
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: false,
    });
    const releaseLease = target.retain();
    let released = false;
    let downstream: NodeWS.WebSocket | undefined;
    const release = () => {
      if (released) return;
      released = true;
      target.signal.removeEventListener("abort", cancel);
      active.delete(cancel);
      releaseLease();
    };
    const cancel = () => {
      upstream.terminate();
      downstream?.terminate();
      socket.destroy();
      release();
    };
    active.add(cancel);
    target.signal.addEventListener("abort", cancel, { once: true });
    socket.once("close", () => {
      if (!downstream) cancel();
    });
    socket.once("error", cancel);
    upstream.once("error", cancel);
    const forwardClose = (destination: NodeWS.WebSocket, code: number, reason: Buffer) => {
      if (code === 1005 || code === 1006 || code === 1015) destination.close();
      else destination.close(code, reason);
    };
    upstream.once("close", (code, reason) => {
      if (downstream) forwardClose(downstream, code, reason);
      else socket.destroy();
      if (!downstream || downstream.readyState === NodeWS.WebSocket.CLOSED) release();
    });
    upstream.once("open", () => {
      if (socket.destroyed || target.signal.aborted) return cancel();
      if (upstream.protocol) request.headers["sec-websocket-protocol"] = upstream.protocol;
      else delete request.headers["sec-websocket-protocol"];
      sockets.handleUpgrade(request, socket, head, (client) => {
        downstream = client;
        const forward = (destination: NodeWS.WebSocket, data: NodeWS.RawData, binary: boolean) => {
          if (
            destination.readyState !== NodeWS.WebSocket.OPEN ||
            destination.bufferedAmount > MAX_PAYLOAD
          ) {
            cancel();
            return;
          }
          destination.send(data, { binary }, (error) => {
            if (error) cancel();
          });
        };
        upstream.on("message", (data, binary) => forward(client, data, binary));
        client.on("message", (data, binary) => forward(upstream, data, binary));
        client.once("error", cancel);
        client.once("close", (code, reason) => {
          forwardClose(upstream, code, reason);
          if (upstream.readyState === NodeWS.WebSocket.CLOSED) release();
        });
      });
    });
  }

  class GatewayServer extends NodeHttp.Server {
    override emit(event: string, ...args: unknown[]): boolean {
      const [request, response, head] = args;
      if (
        (event !== "request" && event !== "upgrade") ||
        !(request instanceof NodeHttp.IncomingMessage)
      ) {
        return super.emit(event, ...args);
      }
      const route = resolveRequest(request);
      if (route === null) return super.emit(event, ...args);
      const status =
        "status" in route
          ? route.status
          : disposed || route.signal.aborted
            ? 410
            : active.size >= MAX_ACTIVE
              ? 503
              : undefined;
      if (status !== undefined) {
        if (response instanceof NodeHttp.ServerResponse) response.writeHead(status).end();
        else if (response instanceof NodeStream.Duplex)
          response.end(
            `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
        return true;
      }
      if ("status" in route) return true;
      try {
        if (event === "request" && response instanceof NodeHttp.ServerResponse)
          proxyHttp(request, response, route);
        else if (
          event === "upgrade" &&
          response instanceof NodeStream.Duplex &&
          Buffer.isBuffer(head)
        )
          proxyWebSocket(request, response, head, route);
      } catch {
        if (response instanceof NodeHttp.ServerResponse) response.writeHead(502).end();
        else if (response instanceof NodeStream.Duplex)
          response.end(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
      }
      return true;
    }
  }

  const server = new GatewayServer();
  server.on("upgrade", (_request, socket) => {
    if (server.listenerCount("upgrade") === 1) socket.destroy();
  });
  return {
    server,
    dispose: () => {
      disposed = true;
      for (const cancel of active) cancel();
      sockets.close();
    },
  };
}
