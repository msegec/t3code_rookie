import type { ProviderListResponse } from "@opencode-ai/sdk/v2";
import { IsoDateTime, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpIncomingMessage,
} from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const FiniteNumber = Schema.Number.check(Schema.isFinite());
const OpenRouterKey = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.NullOr(FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0))),
    limit_remaining: Schema.NullOr(FiniteNumber),
    limit_reset: Schema.optional(Schema.NullOr(Schema.String)),
    is_free_tier: Schema.Boolean,
  }),
});
const GoWindow = Schema.Struct({
  status: Schema.Literals(["ok", "rate-limited"]),
  percent: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
  resetsAt: IsoDateTime,
});
const GoUsage = Schema.Struct({
  usage: Schema.Struct({ rolling: GoWindow, weekly: GoWindow, monthly: GoWindow }),
});
const GO_WINDOWS = [
  { id: "rolling", kind: "session", label: "OpenCode Go five-hour", windowDurationMins: 300 },
  { id: "weekly", kind: "weekly", label: "OpenCode Go weekly", windowDurationMins: 10080 },
  { id: "monthly", kind: "monthly", label: "OpenCode Go monthly" },
] as const;

function openRouterLimits(
  data: typeof OpenRouterKey.Type.data,
  checkedAt: string,
): ServerProviderUsageLimits {
  if ((data.limit === null) !== (data.limit_remaining === null)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "OpenRouter returned inconsistent key limits.",
    });
  }
  if (data.limit === null || data.limit_remaining === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: `${data.is_free_tier ? "OpenRouter free tier" : "OpenRouter"}: no key spending cap. Remaining free requests are not exposed by OpenRouter.`,
    });
  }
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        id: "openrouter:key-cap",
        kind:
          data.limit_reset === "weekly" || data.limit_reset === "monthly"
            ? data.limit_reset
            : "other",
        label: `OpenRouter key spending cap: USD ${data.limit_remaining} remaining (free requests unknown)`,
        usedPercent:
          data.limit === 0
            ? 100
            : clampPercent(((data.limit - data.limit_remaining) / data.limit) * 100),
      },
    ],
  });
}

export const readOpenCodeUsageLimits = Effect.fn("readOpenCodeUsageLimits")(function* (
  inventory: ProviderListResponse,
  checkedAt: string,
) {
  const client = yield* HttpClient.HttpClient;
  const unsupported = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message });
  const results = yield* Effect.forEach(
    ["openrouter", "opencode-go"] as const,
    (id) =>
      Effect.gen(function* () {
        if (!inventory.connected.includes(id)) return undefined;
        const provider = inventory.all.find((candidate) => candidate.id === id);
        const name = id === "openrouter" ? "OpenRouter" : "OpenCode Go";
        const baseUrl =
          id === "openrouter" ? "https://openrouter.ai/api/v1" : "https://opencode.ai/zen/go/v1";
        if (
          provider?.options.baseURL !== undefined &&
          provider.options.baseURL !== baseUrl &&
          provider.options.baseURL !== `${baseUrl}/`
        ) {
          return unsupported(`${name}: usage limits are unavailable for a custom API endpoint.`);
        }
        const key =
          typeof provider?.options.apiKey === "string" ? provider.options.apiKey : provider?.key;
        if (!key?.trim() || key === "public") {
          return unsupported(
            `${name}: OpenCode did not expose the connected API key for a usage probe.`,
          );
        }
        return yield* Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.get(`${baseUrl}/${id === "openrouter" ? "key" : "usage"}`).pipe(
              HttpClientRequest.bearerToken(key),
              HttpClientRequest.setHeader("accept", "application/json"),
            ),
          );
          if (id === "opencode-go" && response.status === 403) {
            return unsupported("OpenCode Go: this key has no Go subscription.");
          }
          yield* HttpClientResponse.filterStatusOk(response);
          if (id === "openrouter") {
            const body = yield* HttpClientResponse.schemaBodyJson(OpenRouterKey)(response);
            return openRouterLimits(body.data, checkedAt);
          }
          const body = yield* HttpClientResponse.schemaBodyJson(GoUsage)(response);
          return makeUsageLimits({
            checkedAt,
            windows: GO_WINDOWS.map(({ id: windowId, ...window }) => ({
              ...window,
              id: `opencode-go:${windowId}`,
              usedPercent: clampPercent(body.usage[windowId].percent),
              resetsAt: body.usage[windowId].resetsAt,
            })),
          });
        }).pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(65_536)),
          Effect.timeout("4 seconds"),
          Effect.catch(() =>
            Effect.succeed(
              makeUnavailableUsageLimits({
                checkedAt,
                reason: "probeFailed",
                message: `${name}: could not read usage limits. Refresh to retry.`,
              }),
            ),
          ),
        );
      }),
    { concurrency: 2 },
  );
  const limits = results.filter((result) => result !== undefined);
  const windows = limits.flatMap((result) => result.windows);
  if (windows.length > 0) return makeUsageLimits({ checkedAt, windows });
  const messages = limits.flatMap((result) =>
    result.unavailable?.message ? [result.unavailable.message] : [],
  );
  if (inventory.connected.includes("opencode")) {
    messages.push(
      "OpenCode Zen: remaining credits and free-model requests are not exposed by its API.",
    );
  }
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: limits.some((result) => result.unavailable?.reason === "probeFailed")
      ? "probeFailed"
      : "unsupported",
    message:
      messages.join(" ") || "OpenCode's connected providers do not expose supported usage limits.",
  });
});
