import { assert, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { subscribeOrchestrationV2Shell } from "./ws.ts";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-accent"),
  title: "Accent",
  workspaceRoot: "/repo/accent",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
};

const services = Layer.mergeAll(
  Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
        snapshotSequence: 7,
        threads: [],
        archivedThreads: [],
      }),
  }),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
    latestApplicationSequence: Effect.succeed(7),
    streamProjectedApplicationEvents: () => Stream.never,
  }),
  Layer.unwrap(
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<never>();
      return Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        subscribeChanges: PubSub.subscribe(changes),
      });
    }),
  ),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
    resolveAccent: (workspaceRoot) =>
      Effect.succeed(workspaceRoot === project.workspaceRoot ? "#1688f0" : null),
  }),
  SqlitePersistence.layerMemory,
);

it.effect("carries each project's t3.json accent on the initial shell snapshot", () =>
  Effect.gen(function* () {
    const stream = yield* subscribeOrchestrationV2Shell({});
    const [first] = yield* stream.pipe(Stream.take(1), Stream.runCollect);
    assert.strictEqual(first?.kind, "snapshot");
    if (first?.kind !== "snapshot") return;
    assert.deepStrictEqual(
      first.snapshot.projects.map((shell) => [shell.id, shell.accent]),
      [[project.id, "#1688f0"]],
    );
  }).pipe(Effect.scoped, Effect.provide(services)),
);
