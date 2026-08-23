import { describe, expect, it } from "vite-plus/test";

import { projectAccentRowStyle } from "./projectAccent";

describe("projectAccentRowStyle", () => {
  it("sets one source color for generated state tints", () => {
    expect(projectAccentRowStyle("#1688f0")).toEqual({
      "--project-accent-color": "#1688f0",
    });
  });

  it("sets exact colors for every advanced state", () => {
    expect(
      projectAccentRowStyle({
        idle: "#071525",
        hover: "#102b46",
        selected: "#173b60",
      }),
    ).toEqual({
      "--project-accent-idle": "#071525",
      "--project-accent-hover": "#102b46",
      "--project-accent-selected": "#173b60",
    });
  });

  it("does not add accent styles without project configuration", () => {
    expect(projectAccentRowStyle(null)).toBeUndefined();
  });
});
