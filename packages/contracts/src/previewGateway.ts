import * as Schema from "effect/Schema";
import { EnvironmentId, PortSchema, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const GatewayUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

export const PreviewGatewayIssueInput = Schema.Struct({ threadId: ThreadId, port: PortSchema });
export type PreviewGatewayIssueInput = typeof PreviewGatewayIssueInput.Type;

export const PreviewGatewayIssueResult = Schema.Struct({
  path: GatewayUrl,
  expiresAt: Schema.Number,
});
export type PreviewGatewayIssueResult = typeof PreviewGatewayIssueResult.Type;

export const PreviewGatewayRegisterInput = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  port: PortSchema,
  gatewayUrl: GatewayUrl,
  expiresAt: Schema.Number,
});
export type PreviewGatewayRegisterInput = typeof PreviewGatewayRegisterInput.Type;

export const PreviewGatewayRegisterResult = Schema.Struct({
  origin: GatewayUrl,
  expiresAt: Schema.Number,
});
export type PreviewGatewayRegisterResult = typeof PreviewGatewayRegisterResult.Type;

export const PreviewGatewayRevokeInput = Schema.Struct({ origin: GatewayUrl });
export type PreviewGatewayRevokeInput = typeof PreviewGatewayRevokeInput.Type;

export class PreviewGatewayError extends Schema.TaggedError<PreviewGatewayError>()(
  "PreviewGatewayError",
  {
    reason: Schema.Literals([
      "unsupported-runtime",
      "invalid-target",
      "thread-unavailable",
      "capacity",
      "expired",
    ]),
    message: Schema.String,
  },
) {}
