import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
  ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { previewGatewayTargetPort, resolvePreviewGateway } from "./previewGateway";

export {
  normalizeHostname,
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isPublicFaviconHost,
} from "@t3tools/shared/hostClassification";

export async function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: Exclude<BrowserNavigationTarget, { readonly kind: "workspace-file" }>,
  threadId: ThreadId,
): Promise<PreviewUrlResolution> {
  const requestedUrl =
    target.kind === "url"
      ? target.url
      : `${target.protocol ?? "http"}://localhost:${target.port}/${target.path?.replace(/^\//, "") ?? ""}`;
  const parsed = new URL(normalizePreviewUrl(requestedUrl));
  const gatewayPort = previewGatewayTargetPort({ environmentId, threadId }, parsed.origin);
  if (gatewayPort === null && parsed.hostname.endsWith(".localhost")) {
    throw new Error(
      "This preview route is no longer owned by this browser. Navigate using the project's loopback URL.",
    );
  }
  if (target.kind === "url" && !isLoopbackHost(parsed.hostname) && gatewayPort === null) {
    return {
      requestedUrl,
      resolvedUrl: parsed.toString(),
      resolutionKind: "direct",
      environmentId,
    };
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      "The T3 preview gateway supports HTTP development servers. Use an HTTP loopback URL.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Preview gateway URLs cannot contain credentials.");
  }
  const origin = await resolvePreviewGateway(
    { environmentId, threadId },
    gatewayPort ?? Number(parsed.port || 80),
  );
  const resolved = new URL(origin);
  resolved.pathname = parsed.pathname;
  resolved.search = parsed.search;
  resolved.hash = parsed.hash;
  return {
    requestedUrl,
    resolvedUrl: resolved.toString(),
    resolutionKind: "gateway",
    environmentId,
  };
}

export async function resolveDiscoveredServerUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
  threadId: ThreadId,
): Promise<string> {
  return (
    await resolveBrowserNavigationTarget(environmentId, { kind: "url", url: rawUrl }, threadId)
  ).resolvedUrl;
}
