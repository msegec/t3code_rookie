import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { acquirePreviewGateway } from "./previewGateway.ts";

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const primary = {
  environmentId: EnvironmentId.make("local"),
  httpBaseUrl: "http://127.0.0.1:3773",
};

function fixture(httpBaseUrl: string) {
  return {
    threadRef,
    primary,
    port: 5173,
    httpBaseUrl,
    issue: vi.fn(async () => ({ path: "/api/preview/capability/", expiresAt: 900_000 })),
    register: vi.fn(
      async (_input: Parameters<Parameters<typeof acquirePreviewGateway>[0]["register"]>[0]) => ({
        origin: "http://opaque.localhost:3773",
        expiresAt: 900_000,
      }),
    ),
  };
}

describe("preview gateway connection handoff", () => {
  it.each(["https://environment.relay.t3.codes/", "http://127.0.0.1:48219/"])(
    "reuses the selected connection %s without deriving an app host",
    async (httpBaseUrl) => {
      const input = fixture(httpBaseUrl);
      expect(await acquirePreviewGateway(input)).toEqual({
        origin: "http://opaque.localhost:3773",
        expiresAt: 900_000,
      });
      expect(input.register).toHaveBeenCalledWith({
        ...threadRef,
        port: 5173,
        gatewayUrl: new URL("/api/preview/capability/", httpBaseUrl).toString(),
        expiresAt: 900_000,
      });
    },
  );

  it("keeps identical ports on separate environments distinct", async () => {
    const input = fixture("http://remote:3773");
    await acquirePreviewGateway(input);
    await acquirePreviewGateway({
      ...input,
      threadRef: { ...threadRef, environmentId: EnvironmentId.make("other") },
    });
    expect(input.register.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "remote",
      "other",
    ]);
  });

  it("rejects missing desktop backend before acquiring a remote capability", async () => {
    const input = fixture("https://environment.relay.t3.codes/");
    await expect(acquirePreviewGateway({ ...input, primary: null })).rejects.toThrow(
      "local T3 backend",
    );
    expect(input.issue).not.toHaveBeenCalled();
  });

  it("rejects a nonlocal primary endpoint", async () => {
    const input = fixture("http://remote:3773");
    await expect(
      acquirePreviewGateway({
        ...input,
        primary: { ...primary, httpBaseUrl: "http://remote:3773" },
      }),
    ).rejects.toThrow("local HTTP");
    expect(input.issue).not.toHaveBeenCalled();
  });

  it("rejects remote capability URLs pointing outside the connected environment", async () => {
    const input = fixture("http://remote:3773");
    input.issue.mockResolvedValue({
      path: "http://elsewhere/api/preview/cap/",
      expiresAt: 900_000,
    });
    await expect(acquirePreviewGateway(input)).rejects.toThrow("invalid preview gateway URL");
    expect(input.register).not.toHaveBeenCalled();
  });

  it("propagates unsupported server errors without fallback", async () => {
    const input = fixture("http://remote:3773");
    input.issue.mockRejectedValue(new Error("Preview gateway requires Node"));
    await expect(acquirePreviewGateway(input)).rejects.toThrow("requires Node");
    expect(input.register).not.toHaveBeenCalled();
  });
});
