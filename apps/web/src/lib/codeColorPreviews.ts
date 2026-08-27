import type { ShikiTransformer } from "@pierre/diffs";

const CSS_HEX_COLOR_REGEX =
  /(^|[^0-9A-Za-z_-])(#[0-9A-Fa-f]{8}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{4}|#[0-9A-Fa-f]{3})(?![0-9A-Za-z_-])/g;
const CSS_LONG_HEX_COLOR_REGEX =
  /(^|[^0-9A-Za-z_-])(#[0-9A-Fa-f]{8}|#[0-9A-Fa-f]{6})(?![0-9A-Za-z_-])/g;

/** Style languages keep the #rgb/#rgba short forms. In data and script
    languages a short hex run is usually an issue reference or a JS private
    name, so only #rrggbb/#rrggbbaa get a swatch there. Elsewhere hashes are
    directives or prose, so the swatch stays off entirely. */
const STYLE_LANGUAGES = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "stylus",
  "postcss",
  "html",
  "angular-html",
  "vue",
  "svelte",
  "astro",
]);
const LONG_HEX_LANGUAGES = new Set([
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
  "angular-ts",
]);

interface CodeColorPreviewPart {
  readonly text: string;
  readonly color?: string;
}

function allowShortColorForms(language: string): boolean | null {
  if (STYLE_LANGUAGES.has(language)) return true;
  if (LONG_HEX_LANGUAGES.has(language)) return false;
  return null;
}

export function codeColorPreviewParts(
  text: string,
  allowShortForms = true,
): CodeColorPreviewPart[] {
  const regex = allowShortForms ? CSS_HEX_COLOR_REGEX : CSS_LONG_HEX_COLOR_REGEX;
  const parts: CodeColorPreviewPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(regex)) {
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

/** Rewrites highlighted tokens in place, so only call it on read-only
    surfaces. On a contentEditable surface it would rewrite the token under
    the user's caret. */
export function applyCodeColorPreviews(root: ParentNode, language: string): void {
  const allowShortForms = allowShortColorForms(language);
  if (allowShortForms === null) return;

  for (const token of root.querySelectorAll<HTMLElement>("[data-line] span")) {
    if (token.childElementCount > 0 || token.classList.contains("chat-markdown-color-literal")) {
      continue;
    }

    const parts = codeColorPreviewParts(token.textContent ?? "", allowShortForms);
    if (parts.some((part) => part.color != null)) {
      const children = parts.map((part) => {
        if (!part.color) return token.ownerDocument.createTextNode(part.text);

        const literal = token.ownerDocument.createElement("span");
        literal.className = "chat-markdown-color-literal";
        literal.toggleAttribute("data-code-color-preview", true);
        literal.style.setProperty("--code-color-preview", part.color);
        literal.textContent = part.text;
        return literal;
      });
      token.toggleAttribute("data-code-color-preview", false);
      token.style.removeProperty("--code-color-preview");
      token.replaceChildren(...children);
    } else {
      if (token.hasAttribute("data-code-color-preview")) {
        token.toggleAttribute("data-code-color-preview", false);
      }
      if (token.style.getPropertyValue("--code-color-preview")) {
        token.style.removeProperty("--code-color-preview");
      }
    }
  }
}

function createCodeColorPreviewTransformer(
  name: string,
  allowShortForms: boolean,
): ShikiTransformer {
  return {
    name,
    span(hast) {
      const textNode = hast.children.length === 1 ? hast.children[0] : undefined;
      if (textNode?.type !== "text") return;

      const parts = codeColorPreviewParts(textNode.value, allowShortForms);
      if (!parts.some((part) => part.color != null)) return;

      hast.children = parts.map((part) => {
        if (!part.color) {
          return { type: "text", value: part.text };
        }
        return {
          type: "element",
          tagName: "span",
          properties: {
            className: ["chat-markdown-color-literal"],
            "data-code-color-preview": "",
            style: `--code-color-preview: ${part.color}`,
          },
          children: [{ type: "text", value: part.text }],
        };
      });
    },
  };
}

const styleTransformer = createCodeColorPreviewTransformer("t3-code-color-previews", true);
const longHexTransformer = createCodeColorPreviewTransformer(
  "t3-code-color-previews-long-hex",
  false,
);

export function codeColorPreviewTransformers(language: string): ShikiTransformer[] {
  const allowShortForms = allowShortColorForms(language);
  if (allowShortForms === null) return [];
  return [allowShortForms ? styleTransformer : longHexTransformer];
}
