import type { ProjectAccent } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { applyEdits, modify, parseTree, type ParseError } from "jsonc-parser";

export function editProjectAccent(contents: string | null, accent: ProjectAccent | null): string {
  const source = contents ?? "{}\n";
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || tree?.type !== "object" || parseT3ProjectFile(source) === null) {
    throw new Error("Fix the invalid t3.json before changing its sidebar accent.");
  }
  if (
    (tree.children?.filter((child) => child.children?.[0]?.value === "accentColor").length ?? 0) > 1
  ) {
    throw new Error("Remove duplicate accentColor fields from t3.json before changing its accent.");
  }
  const updated = applyEdits(
    source,
    modify(source, ["accentColor"], accent ?? undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  if (parseT3ProjectFile(updated) === null) {
    throw new Error("Use six-digit hex colours for the sidebar accent.");
  }
  return updated;
}
