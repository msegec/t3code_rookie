import { USAGE_CONTRACT_VERSION, type UsageSummary } from "@t3tools/contracts";

export function projectUsageSummary(summary: UsageSummary, maximum = 4): UsageSummary {
  if (maximum >= USAGE_CONTRACT_VERSION) return summary;
  const contractVersion = maximum >= 5 ? 5 : 4;
  const supported = (provider: string) =>
    provider === "claude" || provider === "codex" || (contractVersion === 5 && provider === "grok");
  const { providerCoverage: _coverage, ...legacy } = summary;
  return {
    ...legacy,
    contractVersion,
    sources: summary.sources.filter((source) => supported(source.fingerprint.provider)),
    buckets: summary.buckets
      .filter((bucket) => supported(bucket.provider))
      .map(({ sourceIndex: _sourceIndex, ...bucket }) => bucket),
  };
}
