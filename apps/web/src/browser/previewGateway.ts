import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  acquirePreviewGateway,
  createPreviewGatewayEnvironmentAtoms,
} from "@t3tools/client-runtime/state/previewGateway";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isPreviewSupportedInRuntime, previewStateAtom } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentSession, readPreparedConnection } from "~/state/session";

const gateway = createPreviewGatewayEnvironmentAtoms(connectionAtomRuntime);
const routes = new Map<
  string,
  {
    origin: string;
    expiresAt: number;
    port: number;
    threadRef: ScopedThreadRef;
    inUse: () => boolean;
    dispose: (revoke?: boolean) => void;
  }
>();
const pending = new Map<string, Promise<string>>();

export function previewGatewayTargetPort(
  threadRef: ScopedThreadRef,
  origin: string,
): number | null {
  for (const route of routes.values()) {
    if (route.origin !== origin) continue;
    if (
      route.threadRef.environmentId !== threadRef.environmentId ||
      route.threadRef.threadId !== threadRef.threadId
    ) {
      throw new Error(
        "This preview belongs to another thread. Navigate using the project's loopback URL.",
      );
    }
    return route.port;
  }
  return null;
}

export function releaseUnusedPreviewGateway(url: string): void {
  const origin = new URL(url).origin;
  for (const route of routes.values()) {
    if (route.origin === origin && !route.inUse()) route.dispose();
  }
}

function isLocalGatewayConnection(
  connection: PreparedConnection | null,
): connection is PreparedConnection {
  if (connection?.target._tag !== "BearerConnectionTarget") return false;
  const url = new URL(connection.httpBaseUrl);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function readPreviewGatewayHost(connection: PreparedConnection): PreparedConnection {
  const primaryId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const primary = primaryId ? readPreparedConnection(primaryId) : null;
  if (primary) return primary;
  if (isLocalGatewayConnection(connection)) return connection;
  let host: PreparedConnection | null = null;
  for (const environmentId of appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.keys()) {
    const candidate = readPreparedConnection(environmentId);
    if (!isLocalGatewayConnection(candidate)) continue;
    if (host) {
      throw new Error(
        "Dynamic previews found multiple connected local T3 services. Enable the desktop Local environment or open a project on the intended local service.",
      );
    }
    host = candidate;
  }
  if (!host) {
    throw new Error(
      "Dynamic previews need a connected local HTTP T3 service. Enable the desktop Local environment or connect a local Node T3 service.",
    );
  }
  return host;
}

export async function resolvePreviewGateway(
  threadRef: ScopedThreadRef,
  port: number,
): Promise<string> {
  if (!isPreviewSupportedInRuntime()) {
    throw new Error("Dynamic previews require a connected T3 desktop browser host.");
  }
  const connection = readPreparedConnection(threadRef.environmentId);
  if (!connection) {
    throw new Error("Dynamic previews need the project environment connected.");
  }
  const host = readPreviewGatewayHost(connection);
  const key = JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    port,
    connection.httpBaseUrl,
    host.environmentId,
    host.httpBaseUrl,
  ]);
  const existing = routes.get(key);
  if (existing && existing.expiresAt > Date.now() + 30_000) return existing.origin;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  for (const route of routes.values()) {
    if (route.expiresAt <= Date.now() && !route.inUse()) route.dispose();
  }
  if (!existing && routes.size + pending.size >= 64) {
    throw new Error("Too many active preview routes. Close unused browser tabs and try again.");
  }
  existing?.dispose(false);
  const acquire = async () => {
    const lease = await acquirePreviewGateway({
      threadRef,
      port,
      httpBaseUrl: connection.httpBaseUrl,
      primary: host,
      issue: async (input) => {
        const result = await gateway.issue.run(appAtomRegistry, {
          environmentId: threadRef.environmentId,
          input,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      register: async (input) => {
        const result = await gateway.register.run(appAtomRegistry, {
          environmentId: host.environmentId,
          input,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
    });
    const unsubscribers: Array<() => void> = [];
    let observed = false;
    let disposed = false;
    const dispose = (revoke = true) => {
      if (disposed) return;
      disposed = true;
      if (routes.get(key)?.dispose === dispose) routes.delete(key);
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (revoke)
        void gateway.revoke.run(appAtomRegistry, {
          environmentId: host.environmentId,
          input: { origin: lease.origin },
        });
    };
    if (
      host.target._tag === "BearerConnectionTarget" &&
      new URL(lease.origin).port !== new URL(host.httpBaseUrl).port
    ) {
      dispose();
      throw new Error(
        "The local T3 service returned a preview port that does not match its connected endpoint. Connect directly to the local service and try again.",
      );
    }
    const isCurrent = () =>
      readPreparedConnection(threadRef.environmentId) === connection &&
      readPreparedConnection(host.environmentId) === host;
    if (!isCurrent()) {
      dispose();
      throw new Error(
        "The environment connection changed while opening the preview. Navigate again.",
      );
    }
    const stateAtom = previewStateAtom(scopedThreadKey(threadRef));
    const inUse = () =>
      Object.values(appAtomRegistry.get(stateAtom).sessions).some(
        (session) =>
          (session.navStatus._tag === "Success" || session.navStatus._tag === "Loading") &&
          session.navStatus.url.startsWith(`${lease.origin}/`),
      );
    observed = inUse();
    routes.set(key, { ...lease, port, threadRef, inUse, dispose });
    for (const environmentId of new Set([host.environmentId, threadRef.environmentId])) {
      unsubscribers.push(
        appAtomRegistry.subscribe(
          environmentSession.preparedConnectionValueAtom(environmentId),
          () => {
            if (!isCurrent()) dispose();
          },
        ),
      );
    }
    unsubscribers.push(
      appAtomRegistry.subscribe(stateAtom, (state) => {
        if (inUse()) observed = true;
        else if (
          observed ||
          Object.values(state.sessions).some(
            (session) =>
              session.navStatus._tag === "LoadFailed" &&
              session.navStatus.url.startsWith(`${lease.origin}/`),
          )
        )
          dispose();
      }),
    );
    return lease.origin;
  };
  const promise = acquire().finally(() => {
    pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}
