import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile, type T3ProjectFile as T3ProjectFileType } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile as never) as (
  input: unknown,
) => T3ProjectFileType;

describe("T3ProjectFile accent colors", () => {
  it("trims a single accent color", () => {
    expect(decode({ accentColor: " #1688f0 " }).accentColor).toBe("#1688f0");
  });

  it("rejects invalid accent colors", () => {
    expect(() => decode({ accentColor: "blue" })).toThrow();
    expect(() => decode({ accentColor: "#1688f0cc" })).toThrow();
  });

  it("accepts exact colors for every accent state", () => {
    expect(
      decode({
        accentColor: {
          idle: "#071525",
          active: "#245181",
          selected: "#173b60",
        },
      }).accentColor,
    ).toEqual({ idle: "#071525", active: "#245181", selected: "#173b60" });
  });

  it("requires every exact accent state", () => {
    expect(() => decode({ accentColor: { idle: "#071525" } })).toThrow();
  });
});
