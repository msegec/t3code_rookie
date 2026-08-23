import type { ShikiTransformer } from "@pierre/diffs";

const CSS_HEX_COLOR_REGEX =
  /(^|[^0-9A-Za-z_-])(#[0-9A-Fa-f]{8}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{4}|#[0-9A-Fa-f]{3})(?![0-9A-Za-z_-])/g;

/** Languages whose hex tokens are plausibly CSS colours. Elsewhere, hashes are
    issue references, directives, or prose, so the swatch stays off. */
const CODE_COLOR_PREVIEW_LANGUAGES = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "stylus",
  "postcss",
  "html",
  "vue",
  "svelte",
  "astro",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "javascript",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "typescript",
  "ts",
  "mts",
  "cts",
  "tsx",
]);

interface CodeColorPreviewPart {
  readonly text: string;
  readonly color?: string;
}

export function codeColorPreviewParts(text: string): CodeColorPreviewPart[] {
  const parts: CodeColorPreviewPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CSS_HEX_COLOR_REGEX)) {
    const color = match[2];
    if (!color || match.index == null) continue;

    const colorStart = match.index + (match[1]?.length ?? 0);
    if (colorStart > cursor) {
      parts.push({ text: text.slice(cursor, colorStart) });
    }
    parts.push({ text: color, color });
    cursor = colorStart + color.length;
  }

  if (cursor < text.length || parts.length === 0) {
    parts.push({ text: text.slice(cursor) });
  }
  return parts;
}

export const codeColorPreviewTransformer: ShikiTransformer = {
  name: "t3-code-color-previews",
  span(hast) {
    const textNode = hast.children.length === 1 ? hast.children[0] : undefined;
    if (textNode?.type !== "text") return;

    const parts = codeColorPreviewParts(textNode.value);
    if (!parts.some((part) => part.color != null)) return;

    hast.children = parts.map((part) => {
      if (!part.color) {
        return { type: "text", value: part.text };
      }
      return {
        type: "element",
        tagName: "span",
        properties: { className: ["chat-markdown-color-literal"] },
        children: [
          { type: "text", value: part.text },
          {
            type: "element",
            tagName: "span",
            properties: {
              className: ["chat-markdown-color-swatch"],
              ariaHidden: "true",
              style: `--chat-markdown-color: ${part.color}`,
            },
            children: [],
          },
        ],
      };
    });
  },
};

export function codeColorPreviewTransformers(language: string): ShikiTransformer[] {
  return CODE_COLOR_PREVIEW_LANGUAGES.has(language) ? [codeColorPreviewTransformer] : [];
}
