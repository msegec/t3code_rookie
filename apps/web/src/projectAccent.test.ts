import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { projectAccentRowState, projectAccentRowStyle } from "./projectAccent";

const readAppStyles = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stylesheetPath = yield* path.fromFileUrl(new URL("./index.css", import.meta.url));
  return yield* fileSystem.readFileString(stylesheetPath);
});

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

it.layer(NodeServices.layer)("project accent row interaction", (it) => {
  it.effect("uses distinct exact colors for active and selected rows", () =>
    Effect.gen(function* () {
      const appStyles = yield* readAppStyles;

      expect(appStyles).toMatch(
        /data-project-accent-state="active"[\s\S]*?var\(\s*--project-accent-active/,
      );
      expect(appStyles).toMatch(
        /data-project-accent-state="selected"[\s\S]*?var\(\s*--project-accent-selected/,
      );
    }),
  );

  it.effect("keeps the accent gradient stable while a row is hovered", () =>
    Effect.gen(function* () {
      const appStyles = yield* readAppStyles;

      expect(appStyles).not.toMatch(/\[data-project-accent\][^,{]*:hover/);
    }),
  );
});
