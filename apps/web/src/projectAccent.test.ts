import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";

import { projectAccentRowState, projectAccentRowStyle } from "./projectAccent";

const appStyles = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");

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
        active: "#245181",
        selected: "#173b60",
      }),
    ).toEqual({
      "--project-accent-idle": "#071525",
      "--project-accent-active": "#245181",
      "--project-accent-selected": "#173b60",
    });
  });

  it("does not add accent styles without project configuration", () => {
    expect(projectAccentRowStyle(null)).toBeUndefined();
  });
});

describe("project accent row interaction", () => {
  it("uses distinct exact colors for active and selected rows", () => {
    expect(appStyles).toMatch(
      /data-project-accent-state="active"[\s\S]*?var\(\s*--project-accent-active/,
    );
    expect(appStyles).toMatch(
      /data-project-accent-state="selected"[\s\S]*?var\(\s*--project-accent-selected/,
    );
  });

  it("keeps the accent gradient stable while a row is hovered", () => {
    expect(appStyles).not.toMatch(/\[data-project-accent\][^,{]*:hover/);
  });
});
