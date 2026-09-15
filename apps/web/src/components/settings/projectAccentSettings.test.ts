import { describe, expect, it } from "vite-plus/test";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { editProjectAccent } from "./projectAccentSettings";

describe("editProjectAccent", () => {
  it("creates a missing file and supports simple and advanced accents", () => {
    expect(parseT3ProjectFile(editProjectAccent(null, "#1688f0"))?.accentColor).toBe("#1688f0");
    const palette = { idle: "#112233", active: "#445566", selected: "#778899" };
    expect(parseT3ProjectFile(editProjectAccent("{}", palette))?.accentColor).toEqual(palette);
  });

  it("preserves comments, unknown fields, scripts and icon configuration", () => {
    const source =
      '{\n  // Keep this comment\n  "iconPath": "icon.png",\n  "custom": {"answer":42},\n  "scripts": [{"name":"test", "command":"vp test"}],\n  "accentColor": "#112233",\n}\n';
    const result = editProjectAccent(source, "#abcdef");
    expect(result).toBe(source.replace("#112233", "#abcdef"));
  });

  it("reset removes only the accent", () => {
    const result = editProjectAccent('{"iconPath":"icon.png","accentColor":"#123456"}', null);
    expect(JSON.parse(result)).toEqual({ iconPath: "icon.png" });
    expect(editProjectAccent('{"iconPath":"icon.png"}', null)).toBe('{"iconPath":"icon.png"}');
  });

  it.each([
    "{",
    "[]",
    "null",
    '{"scripts":42}',
    '{"accentColor":"#123456","accentColor":"#abcdef"}',
  ])("refuses invalid or ambiguous configuration: %s", (source) => {
    expect(() => editProjectAccent(source, "#abcdef")).toThrow();
  });

  it("rejects invalid colours at runtime", () => {
    expect(() => editProjectAccent("{}", "red")).toThrow("six-digit hex");
  });
});
