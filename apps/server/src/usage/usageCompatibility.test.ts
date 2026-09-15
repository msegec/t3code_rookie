import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { UsageSummary, UsageSummaryInput, UsageDay } from "@t3tools/contracts";
import * as Legacy from "./usageLegacy.fixture.ts";
import { projectUsageSummary } from "./usageCompatibility.ts";

const day = Schema.decodeSync(UsageDay)("2026-09-14");
const historicalInput = Legacy.UsageSummaryInput;
const historicalSummary = (provider: Schema.Codec<string>) =>
  Schema.Struct({
    ...Legacy.UsageSummary.fields,
    buckets: Schema.Array(Schema.Struct({ ...Legacy.UsageBucket.fields, provider })),
    sources: Schema.Array(
      Schema.Struct({
        ...Legacy.UsageSource.fields,
        fingerprint: Schema.Struct({ ...Legacy.UsageSourceFingerprint.fields, provider }),
      }),
    ),
  });
const decodeBucket = Schema.decodeUnknownSync(UsageSummary.fields.buckets.value);
const decodeSource = Schema.decodeUnknownSync(UsageSummary.fields.sources.value);
const encodeInput = Schema.encodeSync(Schema.fromJsonString(UsageSummaryInput));
const decodeHistoricalInput = Schema.decodeUnknownSync(Schema.fromJsonString(historicalInput));
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(UsageSummary));
const historicalDecoders = [
  Schema.decodeUnknownSync(
    Schema.fromJsonString(historicalSummary(Schema.Literals(["claude", "codex"]))),
  ),
  Schema.decodeUnknownSync(
    Schema.fromJsonString(historicalSummary(Schema.Literals(["claude", "codex", "grok"]))),
  ),
];
const input = { sinceDay: day, untilDay: day, timeZone: "UTC", maxContractVersion: 6 };
const summary: UsageSummary = {
  contractVersion: 6,
  readAt: "2026-09-14T00:00:00Z",
  timeZone: "UTC",
  sinceDay: day,
  untilDay: day,
  buckets: ["claude", "codex", "grok", "opencode", "antigravity", "cursor"].map(
    (provider, sourceIndex) =>
      decodeBucket({
        provider,
        sourceIndex,
        day,
        model: "test",
        totals: {
          uncachedInputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
        },
        costUsd: 0,
        cacheSavingsUsd: 0,
        costSource: "providerReported",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      }),
  ),
  sources: ["claude", "codex", "grok", "opencode", "antigravity", "cursor"].map((provider) =>
    decodeSource({
      fingerprint: { hostId: "host", provider, resolvedHomePath: `/${provider}`, volumeId: "1" },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    }),
  ),
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
  providerCoverage: [{ provider: "cursor", status: "unsupported", reason: "No supported history" }],
};
describe("usage wire version negotiation against ead4ce52a parent v4 and v5 provider addition", () => {
  it("old request decoder ignores new client negotiation", () => {
    const wire = encodeInput(input);
    expect(decodeHistoricalInput(wire)).toEqual({
      sinceDay: day,
      untilDay: day,
      timeZone: "UTC",
    });
  });
  it.each([4, 5])("encodes a response accepted by the v%i provider decoder", (version) => {
    const decode = historicalDecoders[version - 4]!;
    expect(() => decode(encodeSummary(summary))).toThrow();
    const projected = projectUsageSummary(summary, version);
    expect(decode(encodeSummary(projected)).contractVersion).toBe(version);
    expect(projected.buckets).toHaveLength(version === 4 ? 2 : 3);
    expect(projected.buckets.every((bucket) => bucket.sourceIndex === undefined)).toBe(true);
    expect(projected.providerCoverage).toBeUndefined();
  });
  it("uses v4 without negotiation and leaves the shared v6 scan intact", () => {
    expect(projectUsageSummary(summary).contractVersion).toBe(4);
    expect(projectUsageSummary(summary, 6)).toBe(summary);
    expect(summary.buckets).toHaveLength(6);
  });
});
