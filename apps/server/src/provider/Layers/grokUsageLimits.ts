import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const Credential = Schema.Struct({
  auth_mode: Schema.String,
  key: Schema.String,
  expires_at: Schema.String,
});
const decodeCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeCredential = Schema.decodeUnknownOption(Credential);
const decodeBilling = Schema.decodeUnknownEffect(
  Schema.Struct({
    config: Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.NullOr(Schema.Number)),
      currentPeriod: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            type: Schema.String,
            start: Schema.optional(Schema.String),
            end: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  }),
);

function isGrokScope(scope: string) {
  try {
    const url = new URL(scope);
    return (
      url.origin === "https://auth.x.ai" &&
      !url.username &&
      !url.password &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

export const readGrokUsageLimits = Effect.fn("readGrokUsageLimits")(function* (input: {
  readonly checkedAt: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  ServerProviderUsageLimits,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const unavailable = (reason: "unsupported" | "probeFailed", message: string) =>
    makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason, message });
  if (input.environment.XAI_API_KEY?.trim()) {
    return unavailable("unsupported", "Remaining quota is not available for xAI API-key accounts.");
  }
  if (input.environment.GROK_AUTH_PATH || input.environment.GROK_CLI_CHAT_PROXY_BASE_URL) {
    return unavailable(
      "unsupported",
      "Remaining quota is not available for this custom Grok connection.",
    );
  }
  const read = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = input.environment.HOME || input.environment.USERPROFILE;
    if (!input.environment.GROK_AUTH && !input.environment.GROK_HOME && !home) {
      return unavailable("probeFailed", "The Grok account location could not be resolved.");
    }
    const contents =
      input.environment.GROK_AUTH ??
      (yield* fs.readFileString(
        path.join(input.environment.GROK_HOME || path.join(home!, ".grok"), "auth.json"),
      ));
    const credentials = yield* decodeCredentials(contents);
    const candidates = Object.entries(credentials).flatMap(([scope, value]) => {
      const decoded = decodeCredential(value);
      return isGrokScope(scope) &&
        Option.isSome(decoded) &&
        decoded.value.auth_mode === "oidc" &&
        decoded.value.key.trim()
        ? [decoded.value]
        : [];
    });
    if (candidates.length !== 1) {
      return unavailable(
        "unsupported",
        "Grok remaining quota requires one signed-in Grok account.",
      );
    }
    const credential = candidates[0]!;
    const expiresAt = DateTime.make(credential.expires_at);
    const now = yield* DateTime.now;
    if (
      Option.isNone(expiresAt) ||
      DateTime.toEpochMillis(expiresAt.value) <= DateTime.toEpochMillis(now)
    ) {
      return unavailable(
        "probeFailed",
        "Grok sign-in has expired. Sign in through Grok and refresh Limits.",
      );
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://cli-chat-proxy.grok.com/v1/billing?format=credits").pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${credential.key}`,
          "X-XAI-Token-Auth": "xai-grok-cli",
        }),
      ),
    );
    yield* HttpClientResponse.filterStatusOk(response);
    const billing = yield* decodeBilling(yield* response.json);
    const usedPercent = billing.config.creditUsagePercent;
    const period = billing.config.currentPeriod;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || !period) {
      return unavailable(
        "unsupported",
        "Grok did not return remaining allowance for this account.",
      );
    }
    const kind =
      period.type === "USAGE_PERIOD_TYPE_WEEKLY"
        ? "weekly"
        : period.type === "USAGE_PERIOD_TYPE_MONTHLY"
          ? "monthly"
          : "other";
    const reset = period.end ? DateTime.make(period.end) : Option.none();
    const start = period.start ? DateTime.make(period.start) : Option.none();
    const duration =
      Option.isSome(start) && Option.isSome(reset)
        ? Math.round(
            (DateTime.toEpochMillis(reset.value) - DateTime.toEpochMillis(start.value)) / 60000,
          )
        : undefined;
    return makeUsageLimits({
      checkedAt: input.checkedAt,
      windows: [
        {
          id: kind,
          kind,
          label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Allowance",
          usedPercent: clampPercent(usedPercent),
          ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
          ...(duration !== undefined && duration > 0 ? { windowDurationMins: duration } : {}),
        },
      ],
    });
  });
  return yield* read.pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      unavailable(
        "probeFailed",
        "Grok remaining allowance could not be read. Refresh Limits to try again.",
      ),
    ),
  );
});
