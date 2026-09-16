import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2";

import { readOpenCodeUsageLimits } from "./openCodeUsageLimits.ts";

const checkedAt = "2026-09-16T01:00:00.000Z";
const resetsAt = "2026-09-16T05:00:00.000Z";
function inventory(id: string, key?: string): ProviderListResponse {
  return {
    connected: [id],
    default: {},
    all: [
      { id, name: id, source: "api", env: [], options: {}, models: {}, ...(key ? { key } : {}) },
    ],
  };
}
const probe = Effect.fn(function* (providers: ProviderListResponse, body: unknown, status = 200) {
  const requests: Array<{ url: string; method: string; authorization: string | undefined }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
  });
  const limits = yield* readOpenCodeUsageLimits(providers, checkedAt).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );
  return { limits, requests };
});

describe("OpenCode upstream quota probes", () => {
  it.effect("keeps OpenRouter and Go allowances separate when both are connected", () =>
    Effect.gen(function* () {
      const router = inventory("openrouter", "router-key");
      const go = inventory("opencode-go", "go-key");
      const { limits, requests } = yield* probe(
        {
          all: [...router.all, ...go.all],
          connected: [...router.connected, ...go.connected],
          default: {},
        },
        {
          data: { limit: 10, limit_remaining: 5, limit_reset: "monthly", is_free_tier: false },
          usage: {
            rolling: { status: "ok", percent: 10, resetsAt },
            weekly: { status: "ok", percent: 20, resetsAt },
            monthly: { status: "ok", percent: 30, resetsAt },
          },
        },
      );
      expect(requests).toHaveLength(2);
      expect(limits.windows.map(({ id }) => id)).toEqual([
        "opencode-go:rolling",
        "opencode-go:weekly",
        "opencode-go:monthly",
        "openrouter:key-cap",
      ]);
    }),
  );

  it.effect("times out an unresponsive quota endpoint without failing provider discovery", () =>
    Effect.gen(function* () {
      const fiber = yield* readOpenCodeUsageLimits(
        inventory("openrouter", "test-key"),
        checkedAt,
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("4 seconds");
      const limits = yield* Fiber.join(fiber);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect(
    "reads the OpenRouter key cap without confusing spend with free request usage",
    Effect.fn(function* () {
      const { limits, requests } = yield* probe(inventory("openrouter", "test-key"), {
        data: {
          limit: 10,
          limit_remaining: 7.125,
          limit_reset: "monthly",
          is_free_tier: false,
          usage: 90,
          usage_daily: 0,
          rate_limit: { requests: 20, interval: "10s" },
        },
      });
      expect(requests).toEqual([
        {
          url: "https://openrouter.ai/api/v1/key",
          method: "GET",
          authorization: "Bearer test-key",
        },
      ]);
      expect(limits.windows).toEqual([
        {
          id: "openrouter:key-cap",
          kind: "monthly",
          label: "OpenRouter key spending cap: USD 7.125 remaining (free requests unknown)",
          usedPercent: expect.closeTo(28.75),
        },
      ]);
      expect(limits.unavailable).toBeUndefined();
    }),
  );
  it.effect(
    "reports an unlimited free-tier key without inventing a free request remainder",
    Effect.fn(function* () {
      const { limits } = yield* probe(inventory("openrouter", "test-key"), {
        data: {
          limit: null,
          limit_remaining: null,
          is_free_tier: true,
          usage_daily: 0,
        },
      });
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable).toEqual({
        reason: "unsupported",
        message:
          "OpenRouter free tier: no key spending cap. Remaining free requests are not exposed by OpenRouter.",
      });
    }),
  );
  it.effect(
    "does not infer the paid free-model allowance from is_free_tier",
    Effect.fn(function* () {
      const { limits } = yield* probe(inventory("openrouter", "test-key"), {
        data: {
          limit: null,
          limit_remaining: null,
          is_free_tier: false,
        },
      });
      expect(limits.unavailable?.message).toBe(
        "OpenRouter: no key spending cap. Remaining free requests are not exposed by OpenRouter.",
      );
    }),
  );
  it.effect(
    "reports a zero spending cap as exhausted, never unlimited",
    Effect.fn(function* () {
      const { limits } = yield* probe(inventory("openrouter", "test-key"), {
        data: {
          limit: 0,
          limit_remaining: 0,
          is_free_tier: false,
        },
      });
      expect(limits.windows[0]?.usedPercent).toBe(100);
    }),
  );
  it.effect(
    "maps Go's authoritative rolling, weekly and monthly windows",
    Effect.fn(function* () {
      const { limits, requests } = yield* probe(inventory("opencode-go", "test-go-key"), {
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt },
          weekly: { status: "rate-limited", percent: 100, resetsAt },
          monthly: { status: "ok", percent: 45, resetsAt },
        },
      });
      expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(
        limits.windows.map(({ id, usedPercent, resetsAt: reset }) => [id, usedPercent, reset]),
      ).toEqual([
        ["opencode-go:rolling", 12, resetsAt],
        ["opencode-go:weekly", 100, resetsAt],
        ["opencode-go:monthly", 45, resetsAt],
      ]);
    }),
  );
  it.effect.each([401, 429, 500])(
    "contains HTTP %i failures without returning response secrets",
    Effect.fn(function* (status) {
      const { limits } = yield* probe(
        inventory("openrouter", "test-key"),
        { secret: "private-value" },
        status,
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - serialises the snapshot to prove nothing leaked.
      const serialized = JSON.stringify(limits);
      expect(serialized).not.toContain("private-value");
      expect(serialized).not.toContain("test-key");
    }),
  );
  it.effect(
    "distinguishes an absent Go subscription",
    Effect.fn(function* () {
      const { limits } = yield* probe(inventory("opencode-go", "test-key"), {}, 403);
      expect(limits.unavailable).toEqual({
        reason: "unsupported",
        message: "OpenCode Go: this key has no Go subscription.",
      });
    }),
  );
  it.effect.each([
    { data: {} },
    { data: { limit: 10, limit_remaining: "7", is_free_tier: false } },
    { data: { limit: null, limit_remaining: 7, is_free_tier: false } },
  ])(
    "rejects malformed key data",
    Effect.fn(function* (body) {
      expect(
        (yield* probe(inventory("openrouter", "test-key"), body)).limits.unavailable?.reason,
      ).toBe("probeFailed");
    }),
  );
  it.effect(
    "rejects malformed Go windows rather than manufacturing zero usage",
    Effect.fn(function* () {
      expect(
        (yield* probe(inventory("opencode-go", "test-key"), {
          usage: { rolling: { percent: "bad" } },
        })).limits.unavailable?.reason,
      ).toBe("probeFailed");
    }),
  );
  it.effect(
    "uses the resolved config key before the inventory fallback key",
    Effect.fn(function* () {
      const providers = inventory("openrouter", "old-key");
      providers.all[0]!.options.apiKey = "configured-key";
      expect((yield* probe(providers, {})).requests[0]?.authorization).toBe(
        "Bearer configured-key",
      );
    }),
  );
  it.effect(
    "does not probe disconnected providers or move proxy credentials to an official host",
    Effect.fn(function* () {
      const providers = inventory("openrouter", "test-key");
      providers.connected = [];
      expect((yield* probe(providers, {})).requests).toEqual([]);
      providers.connected = ["openrouter"];
      providers.all[0]!.options.baseURL = "https://proxy.example/api/v1";
      expect((yield* probe(providers, {})).requests).toEqual([]);
    }),
  );
  it.effect(
    "reports Zen free-model quota as unknown without making requests",
    Effect.fn(function* () {
      const { limits, requests } = yield* probe(inventory("opencode"), {});
      expect(requests).toEqual([]);
      expect(limits.unavailable?.message).toContain("Zen");
      expect(limits.unavailable?.message).toContain("not exposed");
    }),
  );
});
