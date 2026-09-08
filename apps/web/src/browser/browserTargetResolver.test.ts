import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const resolvePreviewGateway = vi.fn();
const previewGatewayTargetPort = vi.fn();
vi.mock("./previewGateway", () => ({
  resolvePreviewGateway,
  previewGatewayTargetPort,
}));
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

describe("browser target resolver", () => {
  beforeEach(() => {
    previewGatewayTargetPort.mockReset().mockReturnValue(null);
    resolvePreviewGateway.mockReset().mockResolvedValue("http://opaque.localhost:3773");
  });

  it("routes environment ports through the existing T3 gateway", async () => {
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      await resolveBrowserNavigationTarget(
        environmentId,
        {
          kind: "environment-port",
          port: 5173,
          path: "/dashboard?x=1#result",
        },
        threadId,
      ),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard?x=1#result",
      resolvedUrl: "http://opaque.localhost:3773/dashboard?x=1#result",
      resolutionKind: "gateway",
      environmentId,
    });
    expect(resolvePreviewGateway).toHaveBeenCalledWith({ environmentId, threadId }, 5173);
  });

  it.each([
    "localhost:3000/app",
    "http://127.0.0.1:3000/app",
    "http://0.0.0.0:3000/app",
    "http://[::1]:3000/app",
  ])("routes loopback URL %s in its actual thread environment", async (url) => {
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      (await resolveBrowserNavigationTarget(environmentId, { kind: "url", url }, threadId))
        .resolvedUrl,
    ).toBe("http://opaque.localhost:3773/app");
    expect(resolvePreviewGateway).toHaveBeenCalledWith({ environmentId, threadId }, 3000);
  });

  it("preserves the application port when navigating an owned gateway origin", async () => {
    previewGatewayTargetPort.mockReturnValue(5173);
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    const result = await resolveBrowserNavigationTarget(
      environmentId,
      {
        kind: "url",
        url: "http://opaque.localhost:3773/settings?mode=edit#profile",
      },
      threadId,
    );
    expect(resolvePreviewGateway).toHaveBeenCalledWith({ environmentId, threadId }, 5173);
    expect(result.resolvedUrl).toBe("http://opaque.localhost:3773/settings?mode=edit#profile");
  });

  it("rejects a gateway URL owned by another browser host", async () => {
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    await expect(
      resolveBrowserNavigationTarget(
        environmentId,
        { kind: "url", url: "http://unknown.localhost:3773/app" },
        threadId,
      ),
    ).rejects.toThrow("no longer owned");
    expect(resolvePreviewGateway).not.toHaveBeenCalled();
  });

  it("keeps public URLs direct", async () => {
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      (
        await resolveBrowserNavigationTarget(
          environmentId,
          { kind: "url", url: "https://example.com/app" },
          threadId,
        )
      ).resolvedUrl,
    ).toBe("https://example.com/app");
    expect(resolvePreviewGateway).not.toHaveBeenCalled();
  });

  it("does not fall back to exposed ports when the gateway fails", async () => {
    resolvePreviewGateway.mockRejectedValue(new Error("Environment disconnected"));
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    await expect(
      resolveDiscoveredServerUrl(environmentId, "localhost:5173", threadId),
    ).rejects.toThrow("Environment disconnected");
  });

  it.each(["https://localhost:5173", "http://user:secret@localhost:5173"])(
    "rejects unsupported dynamic target %s",
    async (url) => {
      const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
      await expect(
        resolveBrowserNavigationTarget(environmentId, { kind: "url", url }, threadId),
      ).rejects.toThrow();
      expect(resolvePreviewGateway).not.toHaveBeenCalled();
    },
  );

  it("classifies exact private IPv4 and IPv6 boundaries", async () => {
    const { isPrivateNetworkHost } = await import("./browserTargetResolver");
    const privateHosts = [
      "0.0.0.0",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.0",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "fc00::",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.168.1.1",
      "localhost.",
      "localhost..",
      "devbox.",
      "devbox..",
      "printer.local.",
      "printer.local..",
      "printer.home.arpa.",
      "printer.home.arpa..",
      "devbox.example.ts.net.",
      "devbox.example.ts.net..",
    ];
    const publicHosts = [
      "1.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "fbff:ffff::",
      "fec0::",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "example.com.",
    ];
    expect(privateHosts.filter((host) => !isPrivateNetworkHost(host))).toEqual([]);
    expect(publicHosts.filter(isPrivateNetworkHost)).toEqual([]);
  });

  it("allows only globally routable hosts to reach a public favicon provider", async () => {
    const { isPublicFaviconHost } = await import("./browserTargetResolver");
    const nonPublic = [
      "192.0.0.0",
      "192.0.0.255",
      "192.0.2.0",
      "192.0.2.255",
      "192.88.99.0",
      "192.88.99.255",
      "198.51.100.0",
      "198.51.100.255",
      "203.0.113.0",
      "203.0.113.255",
      "224.0.0.0",
      "255.255.255.255",
      "::2",
      "100::",
      "100::ffff:ffff:ffff:ffff",
      "100:0:0:1::",
      "100:0:0:1:ffff:ffff:ffff:ffff",
      "64:ff9b:1::1",
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::c0a8:101",
      "64:ff9b::c000:201",
      "2001:5::1",
      "2001:2::",
      "2001:2:0:ffff:ffff:ffff:ffff:ffff",
      "2001:db8::",
      "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff::",
      "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "5f00::1",
      "fec0::",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.0.2.1",
      "app.test",
      "app.test..",
      "printer.local..",
      "printer.home.arpa..",
      "devbox.example.ts.net..",
      "127.0.0.1..",
      "127.1..",
      "10.1..",
      "172.16.1..",
      "192.168.1..",
      "service.internal",
      "hidden.onion",
    ];
    const publicHosts = [
      "191.255.255.255",
      "192.0.1.255",
      "192.0.3.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "1.1.1.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "64:ff9b::808:808",
      "2001:1::1",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
      "::ffff:8.8.8.8",
      "example.com",
      "example.com.",
    ];
    expect(nonPublic.filter(isPublicFaviconHost)).toEqual([]);
    expect(publicHosts.filter((host) => !isPublicFaviconHost(host))).toEqual([]);
  });
});
