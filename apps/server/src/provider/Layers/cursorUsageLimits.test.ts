import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";

import { readCursorUsageLimits } from "./cursorUsageLimits.ts";
import { withCursorUsageLimits } from "./CursorProvider.ts";

const checkedAt = "2026-09-16T00:00:00.000Z";

const probe = (
  response: unknown,
  options: { status?: number; auth?: string; apiKey?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-quota-test-" });
    yield* fs.makeDirectory(path.join(home, "cursor"));
    if (options.auth !== "missing") {
      yield* fs.writeFileString(
        path.join(home, "cursor", "auth.json"),
        options.auth ?? '{"accessToken":"test-token"}',
      );
    }
    const requests: Array<{ url: string; method: string; authorization: string | undefined }> = [];
    const client = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(response, { status: options.status ?? 200 }),
        ),
      );
    });
    const environment = {
      XDG_CONFIG_HOME: home,
      ...(options.apiKey ? { CURSOR_API_KEY: options.apiKey } : {}),
    };
    const limits = yield* readCursorUsageLimits({
      checkedAt,
      environment,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    return { limits, requests };
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

const providerCheck = (auth: "signed-in" | "signed-out") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-quota-test-" });
    yield* fs.makeDirectory(path.join(home, "cursor"));
    yield* fs.writeFileString(
      path.join(home, "cursor", "auth.json"),
      '{"accessToken":"test-token"}',
    );
    let requests = 0;
    const client = HttpClient.make((request) => {
      requests += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ planUsage: { autoPercentUsed: 25, apiPercentUsed: 60 } }),
        ),
      );
    });
    const snapshot: ServerProvider = {
      instanceId: ProviderInstanceId.make("cursor-work"),
      driver: ProviderDriverKind.make("cursor"),
      enabled: true,
      installed: true,
      version: "2026.09.10",
      status: "ready",
      auth: { status: auth === "signed-in" ? "authenticated" : "unauthenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
    };
    const probed = yield* withCursorUsageLimits(snapshot, { XDG_CONFIG_HOME: home }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    return { limits: probed.usageLimits, requests };
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

describe("readCursorUsageLimits", () => {
  it.effect("attaches quota to every signed-in provider check", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* providerCheck("signed-in");
      expect(limits?.windows.map((window) => [window.id, 100 - window.usedPercent])).toEqual([
        ["api", 40],
        ["auto", 75],
      ]);
      expect(requests).toBe(1);
    }),
  );
  it.effect("leaves a signed-out provider check untouched", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* providerCheck("signed-out");
      expect(limits).toBeUndefined();
      expect(requests).toBe(0);
    }),
  );
  it.effect("reads both account allowance pools and the billing reset without model calls", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* probe({
        billingCycleEnd: "1790812800000",
        planUsage: {
          includedSpend: 2000,
          limit: 2000,
          autoPercentUsed: 34,
          apiPercentUsed: 70.8,
          totalPercentUsed: 37,
        },
      });
      expect(limits).toEqual({
        checkedAt,
        windows: [
          {
            id: "api",
            kind: "monthly",
            label: "Other Models",
            usedPercent: 70.8,
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "auto",
            kind: "monthly",
            label: "Cursor Models",
            usedPercent: 34,
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      });
      expect(requests).toEqual([
        {
          url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          method: "POST",
          authorization: "Bearer test-token",
        },
      ]);
    }),
  );

  it.effect("retains zero usage and uses the reported total only when split pools are absent", () =>
    Effect.gen(function* () {
      expect((yield* probe({ planUsage: { totalPercentUsed: 0 } })).limits.windows).toEqual([
        { id: "included", kind: "monthly", label: "Included usage", usedPercent: 0 },
      ]);
    }),
  );

  it.effect("does not calculate allowance from historical spend or on-demand spending caps", () =>
    Effect.gen(function* () {
      const { limits } = yield* probe({
        planUsage: { includedSpend: 20, limit: 100 },
        spendLimitUsage: { individualRemaining: 80 },
      });
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect.each([401, 403, 500])(
    "keeps failed status %s separate from unsupported quotas",
    (status) =>
      Effect.gen(function* () {
        const { limits } = yield* probe({ message: "sensitive upstream detail" }, { status });
        expect(limits.unavailable?.reason).toBe("probeFailed");
        // @effect-diagnostics-next-line preferSchemaOverJson:off - serialises the snapshot to prove nothing leaked.
        const serialized = JSON.stringify(limits);
        expect(serialized).not.toContain("sensitive");
        expect(serialized).not.toContain("test-token");
      }),
  );

  it.effect("rejects malformed allowance payloads without showing full remaining bars", () =>
    Effect.gen(function* () {
      const { limits } = yield* probe({ planUsage: { autoPercentUsed: "broken" } });
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.windows).toEqual([]);
    }),
  );

  it.effect("does not reuse a saved login when an API key overrides the account", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* probe({}, { apiKey: "another-account" });
      expect(requests).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect.each(["missing", "not json"])("does not query the server with %s credentials", (auth) =>
    Effect.gen(function* () {
      const { limits, requests } = yield* probe({}, { auth });
      expect(requests).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );
});
