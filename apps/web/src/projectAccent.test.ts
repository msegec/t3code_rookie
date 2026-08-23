import { describe, expect, it } from "vite-plus/test";

import { projectAccentRowState, projectAccentRowStyle } from "./projectAccent";

describe("projectAccentRowState", () => {
  it("keeps the routed thread and multi-selection as distinct states", () => {
    expect(projectAccentRowState("#1688f0", true, true)).toBe("active");
    expect(projectAccentRowState("#1688f0", false, true)).toBe("selected");
    expect(projectAccentRowState("#1688f0", false, false)).toBe("idle");
  });

  it("does not add a state attribute without project configuration", () => {
    expect(projectAccentRowState(null, true, false)).toBeUndefined();
  });
});

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
