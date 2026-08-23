import type { ProjectAccent } from "@t3tools/contracts";
import type { CSSProperties } from "react";

export interface ProjectAccentRowStyle extends CSSProperties {
  "--project-accent-color"?: string;
  "--project-accent-idle"?: string;
  "--project-accent-hover"?: string;
  "--project-accent-selected"?: string;
}

export function projectAccentRowStyle(
  accent: ProjectAccent | null,
): ProjectAccentRowStyle | undefined {
  if (accent === null) return undefined;
  return typeof accent === "string"
    ? { "--project-accent-color": accent }
    : {
        "--project-accent-idle": accent.idle,
        "--project-accent-hover": accent.hover,
        "--project-accent-selected": accent.selected,
      };
}
