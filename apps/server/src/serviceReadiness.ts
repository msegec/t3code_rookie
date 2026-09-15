import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { startServerReadinessWatch } from "./serviceLauncher.ts";

export class ServiceReadinessError extends Schema.TaggedError<ServiceReadinessError>()(
  "ServiceReadinessError",
  {
    reason: Schema.Literals(["watch", "read", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `The replacement T3 server did not become ready (${this.reason}).`;
  }
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState));

export const watchServerReadiness = Effect.fn("service.watch_readiness")(function* (
  input: Omit<Parameters<typeof startServerReadinessWatch>[0], "decode" | "startedAt">,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const receipt = yield* Effect.acquireRelease(
    Effect.try({
      try: () => startServerReadinessWatch({ ...input, decode, startedAt }),
      catch: (cause) => new ServiceReadinessError({ reason: "watch", cause }),
    }),
    (receipt) => Effect.promise(receipt.close),
  );
  return {
    awaitReady: Effect.promise(() => receipt.result).pipe(
      Effect.flatMap((result) =>
        "state" in result
          ? Effect.succeed(result.state)
          : Effect.fail(new ServiceReadinessError(result)),
      ),
    ),
  };
});
