import * as NodeOS from "node:os";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const CursorAuth = Schema.Struct({ accessToken: Schema.NonEmptyString });
const Percent = Schema.Number.check(Schema.isFinite());
const CursorUsage = Schema.Struct({
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      autoPercentUsed: Schema.optional(Percent),
      apiPercentUsed: Schema.optional(Percent),
      totalPercentUsed: Schema.optional(Percent),
    }),
  ),
});

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (input: {
  readonly checkedAt: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  ServerProviderUsageLimits,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const { checkedAt } = input;
  const environment = input.environment ?? process.env;
  const platform = yield* HostProcessPlatform;
  if (environment.CURSOR_API_KEY?.trim() || platform === "darwin") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        platform === "darwin"
          ? "Cursor quota cannot be read from the macOS Keychain login. Check Cursor's usage dashboard."
          : "Cursor quota is unavailable for an API key override. Check Cursor's usage dashboard.",
    });
  }
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
    const authPath =
      platform === "win32"
        ? path.join(
            environment.APPDATA || path.join(home, "AppData", "Roaming"),
            "Cursor",
            "auth.json",
          )
        : path.join(
            environment.XDG_CONFIG_HOME || path.join(home, ".config"),
            "cursor",
            "auth.json",
          );
    const auth = yield* fs
      .readFileString(authPath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CursorAuth))));
    const response = yield* client.execute(
      HttpClientRequest.post(
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      ).pipe(
        HttpClientRequest.bearerToken(auth.accessToken),
        HttpClientRequest.setHeaders({
          "Connect-Protocol-Version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message:
          "Cursor could not refresh account quota. Check your Cursor CLI login and try again.",
      });
    }
    const usage = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CursorUsage)),
    );
    const reset =
      usage.billingCycleEnd === undefined
        ? Option.none()
        : DateTime.make(Number(usage.billingCycleEnd));
    const resetsAt =
      Number(usage.billingCycleEnd) > 0 && Option.isSome(reset)
        ? DateTime.formatIso(reset.value)
        : undefined;
    const windows: ServerProviderUsageWindow[] = [];
    for (const [id, label, usedPercent] of [
      ["auto", "Cursor Models", usage.planUsage?.autoPercentUsed],
      ["api", "Other Models", usage.planUsage?.apiPercentUsed],
    ] as const) {
      if (usedPercent !== undefined)
        windows.push({
          id,
          kind: "monthly",
          label,
          usedPercent: clampPercent(usedPercent),
          ...(resetsAt ? { resetsAt } : {}),
        });
    }
    if (windows.length === 0 && usage.planUsage?.totalPercentUsed !== undefined) {
      windows.push({
        id: "included",
        kind: "monthly",
        label: "Included usage",
        usedPercent: clampPercent(usage.planUsage.totalPercentUsed),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
    return windows.length > 0
      ? makeUsageLimits({ checkedAt, windows })
      : makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message:
            "Cursor does not report subscription allowance for this account. Check Cursor's usage dashboard.",
        });
  }).pipe(
    Effect.timeout("6 seconds"),
    Effect.catch(() =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message:
            "Cursor could not refresh account quota. Check your Cursor CLI login and try again.",
        }),
      ),
    ),
  );
});
