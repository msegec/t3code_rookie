import { WS_METHODS, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createPreviewGatewayEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    issue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview-gateway:issue",
      tag: WS_METHODS.previewGatewayIssue,
    }),
    register: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview-gateway:register",
      tag: WS_METHODS.previewGatewayRegister,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview-gateway:revoke",
      tag: WS_METHODS.previewGatewayRevoke,
    }),
  };
}

export async function acquirePreviewGateway(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: number;
  readonly httpBaseUrl: string;
  readonly primary: { readonly environmentId: EnvironmentId; readonly httpBaseUrl: string } | null;
  readonly issue: (input: {
    threadId: ScopedThreadRef["threadId"];
    port: number;
  }) => Promise<{ path: string; expiresAt: number }>;
  readonly register: (input: {
    threadId: ScopedThreadRef["threadId"];
    environmentId: EnvironmentId;
    port: number;
    gatewayUrl: string;
    expiresAt: number;
  }) => Promise<{ origin: string; expiresAt: number }>;
}) {
  if (!input.primary) {
    throw new Error("Dynamic previews need the desktop's connected local T3 backend.");
  }
  const primary = new URL(input.primary.httpBaseUrl);
  if (
    primary.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(primary.hostname)
  ) {
    throw new Error("Dynamic previews need the desktop's local HTTP T3 backend.");
  }
  const lease = await input.issue({ threadId: input.threadRef.threadId, port: input.port });
  const gatewayUrl = new URL(lease.path, input.httpBaseUrl);
  if (
    gatewayUrl.origin !== new URL(input.httpBaseUrl).origin ||
    !gatewayUrl.pathname.startsWith("/api/preview/")
  ) {
    throw new Error("The environment returned an invalid preview gateway URL.");
  }
  return input.register({
    threadId: input.threadRef.threadId,
    environmentId: input.threadRef.environmentId,
    port: input.port,
    gatewayUrl: gatewayUrl.toString(),
    expiresAt: lease.expiresAt,
  });
}
