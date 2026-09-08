// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  PreviewGatewayError,
  type PreviewGatewayIssueInput,
  type PreviewGatewayRegisterInput,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import type { GatewayRoute } from "./GatewayTransport.ts";

export const GATEWAY_PATH = "/api/preview/";
const TOKEN_TTL_MS = 15 * 60_000;
const MAX_LEASES = 256;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const HOST_PATTERN = /^t3-preview-([a-f0-9]{32})\.localhost$/;

interface Lease {
  readonly owner: string;
  target: URL;
  expiresAt: number;
  active: number;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function makeGateway(input: { readonly port: number; readonly supported: boolean }) {
  let listeningPort = input.port;
  const remote = new Map<string, Lease>();
  const local = new Map<string, Lease>();
  const originKey = NodeCrypto.randomBytes(32);

  const remove = (leases: Map<string, Lease>, key: string) => {
    const lease = leases.get(key);
    if (!lease) return;
    leases.delete(key);
    clearTimeout(lease.timer);
    lease.controller.abort();
  };

  const available = () => {
    if (!input.supported) {
      throw new PreviewGatewayError({
        reason: "unsupported-runtime",
        message: "Dynamic T3 browser previews require a Node T3 server on both environments.",
      });
    }
  };

  const idle = (leases: Map<string, Lease>, key: string, lease: Lease) => {
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => remove(leases, key), Math.max(0, lease.expiresAt - Date.now()));
    lease.timer.unref();
  };

  const add = (
    leases: Map<string, Lease>,
    key: string,
    owner: string,
    target: URL,
    expiresAt: number,
  ) => {
    available();
    if (!leases.has(key) && remote.size + local.size >= MAX_LEASES) {
      throw new PreviewGatewayError({ reason: "capacity", message: "Too many active previews." });
    }
    const existing = leases.get(key);
    if (existing?.owner === owner) {
      existing.target = target;
      existing.expiresAt = expiresAt;
      if (existing.active === 0) idle(leases, key, existing);
      return;
    }
    remove(leases, key);
    const controller = new AbortController();
    NodeEvents.EventEmitter.setMaxListeners(128, controller.signal);
    const lease: Lease = { owner, target, expiresAt, active: 0, timer: undefined, controller };
    leases.set(key, lease);
    idle(leases, key, lease);
  };

  const issue = (request: PreviewGatewayIssueInput, owner: string) => {
    available();
    if (
      !Number.isInteger(request.port) ||
      request.port < 1 ||
      request.port > 65535 ||
      request.port === listeningPort
    ) {
      throw new PreviewGatewayError({
        reason: "invalid-target",
        message: "Choose a project HTTP port, not the T3 server port.",
      });
    }
    const token = NodeCrypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    add(remote, token, owner, new URL(`http://localhost:${request.port}/`), expiresAt);
    return { path: `${GATEWAY_PATH}${token}/`, expiresAt };
  };

  const register = (request: PreviewGatewayRegisterInput, owner: string) => {
    available();
    let target: URL;
    try {
      target = new URL(request.gatewayUrl);
    } catch {
      throw new PreviewGatewayError({
        reason: "invalid-target",
        message: "Invalid T3 preview gateway URL.",
      });
    }
    const token = target.pathname.slice(GATEWAY_PATH.length, -1);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !target.pathname.startsWith(GATEWAY_PATH) ||
      !target.pathname.endsWith("/") ||
      !TOKEN_PATTERN.test(token) ||
      HOST_PATTERN.test(target.hostname)
    ) {
      throw new PreviewGatewayError({
        reason: "invalid-target",
        message: "Expected a scoped T3 preview gateway URL.",
      });
    }
    const expiresAt = Math.min(request.expiresAt, Date.now() + TOKEN_TTL_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new PreviewGatewayError({
        reason: "expired",
        message: "The preview route expired. Open the target again.",
      });
    }
    const key = NodeCrypto.createHmac("sha256", originKey)
      .update(JSON.stringify([owner, request.environmentId, request.threadId, request.port]))
      .digest("hex")
      .slice(0, 32);
    add(local, key, owner, target, expiresAt);
    return { origin: `http://t3-preview-${key}.localhost:${listeningPort}`, expiresAt };
  };

  const revoke = (origin: string, owner: string) => {
    let target: URL;
    try {
      target = new URL(origin);
    } catch {
      return;
    }
    const key = HOST_PATTERN.exec(target.hostname)?.[1];
    if (key && local.get(key)?.owner === owner) remove(local, key);
  };

  const resolve = (request: NodeHttp.IncomingMessage): GatewayRoute => {
    const rawPath = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    if (!host.startsWith("t3-preview-") && !rawPath.startsWith(GATEWAY_PATH)) return null;
    if (rawPath[0] !== "/" || rawPath.startsWith("//")) return { status: 400 };
    let incoming: URL;
    try {
      incoming = new URL(rawPath, `http://${host}`);
    } catch {
      return { status: 400 };
    }
    const localKey = HOST_PATTERN.exec(incoming.hostname)?.[1];
    const isRemote = incoming.pathname.startsWith(GATEWAY_PATH);
    if (!localKey && !isRemote) return null;
    if (
      localKey &&
      request.socket.remoteAddress &&
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
    )
      return { status: 403 };

    const token = localKey ?? incoming.pathname.slice(GATEWAY_PATH.length).split("/", 1)[0];
    const leases = localKey ? local : remote;
    const lease = token ? leases.get(token) : undefined;
    if (!lease || (lease.active === 0 && lease.expiresAt <= Date.now())) return { status: 404 };
    let publicOrigin = incoming.origin;
    if (!localKey) {
      const value = request.headers["x-t3-preview-origin"];
      if (typeof value !== "string") return { status: 403 };
      let origin: URL;
      try {
        origin = new URL(value);
      } catch {
        return { status: 403 };
      }
      if (
        origin.protocol !== "http:" ||
        !HOST_PATTERN.test(origin.hostname) ||
        origin.origin !== value
      )
        return { status: 403 };
      publicOrigin = origin.origin;
    }
    const path = localKey
      ? incoming.pathname
      : incoming.pathname.slice(GATEWAY_PATH.length + token!.length);
    const url = new URL(lease.target);
    url.pathname = `${lease.target.pathname.replace(/\/$/, "")}${path || "/"}`;
    url.search = incoming.search;
    return {
      url,
      publicOrigin,
      expiresAt: lease.expiresAt,
      isGateway: Boolean(localKey),
      signal: lease.controller.signal,
      retain: () => {
        lease.active += 1;
        clearTimeout(lease.timer);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          lease.active -= 1;
          if (lease.active === 0 && !lease.controller.signal.aborted) {
            lease.expiresAt = Date.now() + TOKEN_TTL_MS;
            idle(leases, token!, lease);
          }
        };
      },
    };
  };

  const dispose = () => {
    for (const key of remote.keys()) remove(remote, key);
    for (const key of local.keys()) remove(local, key);
  };

  const revokeOwner = (owner: string) => {
    for (const leases of [remote, local]) {
      for (const [key, lease] of leases) if (lease.owner === owner) remove(leases, key);
    }
  };

  return {
    issue,
    register,
    revoke,
    resolve,
    dispose,
    revokeOwner,
    setListeningPort: (port: number) => {
      listeningPort = port;
    },
  };
}

export class Gateway extends Context.Service<Gateway, ReturnType<typeof makeGateway>>()(
  "t3/preview/Gateway",
) {}

export const layer = Layer.effect(
  Gateway,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* Effect.acquireRelease(
      Effect.sync(() => makeGateway({ port: config.port, supported: typeof Bun === "undefined" })),
      (gateway) => Effect.sync(gateway.dispose),
    );
  }),
);

export const revocationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const gateway = yield* Gateway;
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          if (change.type === "clientRemoved") gateway.revokeOwner(change.sessionId);
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
