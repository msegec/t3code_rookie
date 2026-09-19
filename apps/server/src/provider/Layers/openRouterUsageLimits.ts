import type { ProviderListResponse } from "@opencode-ai/sdk/v2";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
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
    limit_reset: Schema.optionalKey(Schema.NullOr(Schema.String)),
    is_free_tier: Schema.Boolean,
  }),
});
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

export const readOpenRouterUsageLimits = Effect.fn("readOpenRouterUsageLimits")(function* (
  inventory: ProviderListResponse,
  checkedAt: string,
) {
  const unsupported = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message });
  if (!inventory.connected.includes("openrouter")) {
    return unsupported(
      inventory.connected.includes("opencode")
        ? "OpenCode Zen: remaining credits and free-model requests are not exposed by its API."
        : "OpenCode's connected providers do not expose supported usage limits.",
    );
  }
  const provider = inventory.all.find((candidate) => candidate.id === "openrouter");
  const name = "OpenRouter";
  const baseUrl = "https://openrouter.ai/api/v1";
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
    return unsupported(`${name}: OpenCode did not expose the connected API key for a usage probe.`);
  }
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${baseUrl}/key`).pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
    );
    yield* HttpClientResponse.filterStatusOk(response);
    const body = yield* HttpClientResponse.schemaBodyJson(OpenRouterKey)(response);
    return openRouterLimits(body.data, checkedAt);
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(65_536)),
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
});

export function mergeOpenCodeUsageLimits(
  go: ServerProviderUsageLimits,
  router: ServerProviderUsageLimits | undefined,
): ServerProviderUsageLimits {
  if (go.windows.length > 0) {
    return makeUsageLimits({
      checkedAt: go.checkedAt,
      windows: [...go.windows, ...(router?.windows ?? [])],
    });
  }
  if (router?.windows.length) return router;
  if (go.unavailable?.reason === "probeFailed") return go;
  return router ?? go;
}
