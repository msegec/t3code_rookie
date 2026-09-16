import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { readGrokUsageLimits } from "./grokUsageLimits.ts";

const checkedAt = "2026-09-16T00:00:00.000Z";
const credential = {
  auth_mode: "oidc",
  key: "synthetic-access-token",
  expires_at: "2099-01-01T00:00:00Z",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const billing = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-09-15T00:00:00Z",
      end: "2026-09-22T00:00:00Z",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
  },
};

function fixture(
  options: {
    body?: unknown;
    credentials?: unknown;
    status?: number;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const requests: string[] = [];
  const files: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe("Bearer synthetic-access-token");
      expect(request.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
      return HttpClientResponse.fromWeb(
        request,
        Response.json(options.body ?? billing, {
          status: options.status ?? 200,
        }),
      );
    }),
  );
  const fs = FileSystem.makeNoop({
    readFileString: (path) => {
      files.push(path);
      return Effect.succeed(
        encode(
          options.credentials ?? {
            "https://auth.x.ai#client": credential,
          },
        ),
      );
    },
  });
  const read = readGrokUsageLimits({
    checkedAt,
    environment: options.environment ?? { HOME: "/test" },
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provide(Path.layer),
  );
  return { read, requests, files };
}

describe("readGrokUsageLimits", () => {
  it.effect("reads a reported weekly percentage using cached auth without a CLI login", () =>
    Effect.gen(function* () {
      const test = fixture({ body: { config: { ...billing.config, creditUsagePercent: 37 } } });
      const limits = yield* test.read;
      expect(limits.windows).toEqual([
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 37,
          resetsAt: "2026-09-22T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      ]);
      expect(test.requests).toEqual(["https://cli-chat-proxy.grok.com/v1/billing?format=credits"]);
      expect(test.files).toEqual(["/test/.grok/auth.json"]);
    }),
  );

  it.effect("does not turn absent allowance fields or credit balances into a full allowance", () =>
    Effect.gen(function* () {
      const limits = yield* fixture().read;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.message).toBe(
        "Grok did not return remaining allowance for this account.",
      );
    }),
  );

  it.effect("does not refresh expired credentials or start login", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(checkedAt));
      const test = fixture({
        credentials: { "https://auth.x.ai": { ...credential, expires_at: "2020-01-01T00:00:00Z" } },
      });
      const limits = yield* test.read;
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(test.requests).toEqual([]);
    }),
  );

  it.effect("does not select an arbitrary account when multiple scopes are signed in", () =>
    Effect.gen(function* () {
      const test = fixture({
        credentials: { "https://auth.x.ai#one": credential, "https://auth.x.ai#two": credential },
      });
      expect((yield* test.read).unavailable?.reason).toBe("unsupported");
      expect(test.requests).toEqual([]);
    }),
  );

  it.effect("does not use an OAuth credential for an API-key instance", () =>
    Effect.gen(function* () {
      const test = fixture({ environment: { HOME: "/test", XAI_API_KEY: "synthetic-api-key" } });
      expect((yield* test.read).unavailable?.reason).toBe("unsupported");
      expect(test.files).toEqual([]);
      expect(test.requests).toEqual([]);
    }),
  );

  it.effect("keeps upstream error bodies and credentials out of the published failure", () =>
    Effect.gen(function* () {
      const limits = yield* fixture({ status: 401, body: { error: "private upstream details" } })
        .read;
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(encode(limits)).not.toContain("private");
      expect(encode(limits)).not.toContain("synthetic-access-token");
    }),
  );
});
