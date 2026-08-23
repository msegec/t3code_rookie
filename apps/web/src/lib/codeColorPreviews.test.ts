import { describe, expect, it } from "vite-plus/test";

import { codeColorPreviewParts, codeColorPreviewTransformers } from "./codeColorPreviews";
import { resolveDiffThemeName } from "./diffRendering";
import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

describe("codeColorPreviewParts", () => {
  it("finds CSS hex colours without changing the surrounding code", () => {
    expect(codeColorPreviewParts('"idle": "#701525",')).toEqual([
      { text: '"idle": "' },
      { text: "#701525", color: "#701525" },
      { text: '",' },
    ]);
  });

  it("supports every CSS hex colour length", () => {
    expect(codeColorPreviewParts("#abc #abcd #a1b2c3 #A1B2C3D4")).toEqual([
      { text: "#abc", color: "#abc" },
      { text: " " },
      { text: "#abcd", color: "#abcd" },
      { text: " " },
      { text: "#a1b2c3", color: "#a1b2c3" },
      { text: " " },
      { text: "#A1B2C3D4", color: "#A1B2C3D4" },
    ]);
  });

  it("ignores invalid lengths and hashes embedded in identifiers", () => {
    const code = "#12 #12345 #123456789 token#abcdef hash-tag#123";
    expect(codeColorPreviewParts(code)).toEqual([{ text: code }]);
  });

  it("ignores identifiers that merely start with a hex run", () => {
    const code = "#define X #fffxyz #fff_value #fff-theme";
    expect(codeColorPreviewParts(code)).toEqual([{ text: code }]);
  });

  it("keeps issue references and private names bare when short forms are off", () => {
    expect(codeColorPreviewParts("// fixes #1904 via this.#abc and #a1b2c3", false)).toEqual([
      { text: "// fixes #1904 via this.#abc and " },
      { text: "#a1b2c3", color: "#a1b2c3" },
    ]);
  });

  it("previews colours only for languages that carry them", () => {
    expect(codeColorPreviewTransformers("css").map((transformer) => transformer.name)).toEqual([
      "t3-code-color-previews",
    ]);
    expect(codeColorPreviewTransformers("json").map((transformer) => transformer.name)).toEqual([
      "t3-code-color-previews-long-hex",
    ]);
    expect(codeColorPreviewTransformers("text")).toEqual([]);
    expect(codeColorPreviewTransformers("c")).toEqual([]);
    expect(codeColorPreviewTransformers("markdown")).toEqual([]);
  });

  it("adds a decorative swatch to highlighted code", async () => {
    const highlighter = await getSyntaxHighlighterPromise("json");
    const html = highlighter.codeToHtml('{"idle":"#701525"}', {
      lang: "json",
      theme: resolveDiffThemeName("dark"),
      transformers: codeColorPreviewTransformers("json"),
    });

    expect(html).toContain('class="chat-markdown-color-literal"');
    expect(html).toContain('class="chat-markdown-color-swatch"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("--chat-markdown-color: #701525");
  });
});
