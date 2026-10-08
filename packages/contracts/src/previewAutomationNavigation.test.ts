import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationHost, PreviewAutomationNavigateInput } from "./previewAutomation.ts";

const decode = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);

describe("preview workspace navigation contract", () => {
  it("accepts legacy hosts and explicit navigation capabilities", () => {
    const decodeHost = Schema.decodeUnknownSync(PreviewAutomationHost);
    const legacy = { clientId: "desktop", environmentId: "environment" };
    expect(decodeHost(legacy)).toEqual(legacy);
    const capable = { ...legacy, supportedNavigationTargets: ["workspace-file"] };
    expect(decodeHost(capable)).toEqual(capable);
    expect(() => decodeHost({ ...legacy, supportedNavigationTargets: ["unknown"] })).toThrow();
  });

  it("accepts a bounded workspace file without a caller-specified thread", () => {
    const input = { target: { kind: "workspace-file", path: "site/design.html" } };
    expect(decode(input)).toEqual(input);
  });

  it.each(["", " ", "a".repeat(1025)])("rejects invalid path %j", (path) => {
    expect(() => decode({ target: { kind: "workspace-file", path } })).toThrow();
  });

  it("requires exactly one logical target or URL", () => {
    expect(() => decode({})).toThrow();
    expect(() =>
      decode({
        url: "https://example.com",
        target: { kind: "workspace-file", path: "design.html" },
      }),
    ).toThrow();
  });
});
