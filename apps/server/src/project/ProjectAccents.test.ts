import type { ProjectAccent } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ProjectAccents from "./ProjectAccents.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";

const resolverReturning = (
  accentByRoot: Readonly<Record<string, ProjectAccent>>,
): ProjectFaviconResolver.ProjectFaviconResolver["Service"] =>
  ProjectFaviconResolver.ProjectFaviconResolver.of({
    resolvePath: () => Effect.succeed(null),
    resolveAccent: (cwd) => Effect.succeed(accentByRoot[cwd] ?? null),
  });

const failingResolver: ProjectFaviconResolver.ProjectFaviconResolver["Service"] =
  ProjectFaviconResolver.ProjectFaviconResolver.of({
    resolvePath: () => Effect.succeed(null),
    resolveAccent: (cwd) =>
      Effect.fail(
        new ProjectFaviconResolver.ProjectFaviconResolutionError({
          operation: "normalize-workspace",
          workspaceRoot: cwd,
          cause: new Error("unreadable checkout"),
        }),
      ),
  });

describe("ProjectAccents", () => {
  it.effect("attaches each project's accent to the payload that creates its rows", () =>
    Effect.gen(function* () {
      const projects = [
        { id: "a", workspaceRoot: "/repos/one" },
        { id: "b", workspaceRoot: "/repos/two" },
        { id: "c", workspaceRoot: "/repos/three" },
      ];

      const decorated = yield* ProjectAccents.withProjectAccents(
        resolverReturning({
          "/repos/one": "#1688f0",
          "/repos/two": { idle: "#071525", selected: "#173b60" },
        }),
        projects,
      );

      expect(decorated).toEqual([
        { id: "a", workspaceRoot: "/repos/one", accent: "#1688f0" },
        {
          id: "b",
          workspaceRoot: "/repos/two",
          accent: { idle: "#071525", selected: "#173b60" },
        },
        // Written as an explicit null, never omitted: clearing accentColor in
        // t3.json has to clear the row rather than leave the old value.
        { id: "c", workspaceRoot: "/repos/three", accent: null },
      ]);
    }),
  );

  it.effect("keeps an unreadable checkout in the snapshot without an accent", () =>
    Effect.gen(function* () {
      const decorated = yield* ProjectAccents.withProjectAccents(failingResolver, [
        { id: "a", workspaceRoot: "/repos/gone" },
      ]);

      expect(decorated).toEqual([{ id: "a", workspaceRoot: "/repos/gone", accent: null }]);
    }),
  );

  it.effect("decorates a single project the same way", () =>
    Effect.gen(function* () {
      const decorated = yield* ProjectAccents.withProjectAccent(
        resolverReturning({ "/repos/one": "#1688f0" }),
        { id: "a", workspaceRoot: "/repos/one" },
      );

      expect(decorated).toEqual({ id: "a", workspaceRoot: "/repos/one", accent: "#1688f0" });
    }),
  );
});
