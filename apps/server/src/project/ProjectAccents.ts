/**
 * ProjectAccents - decorates client-facing project payloads with the accent
 * declared in each checkout's `t3.json`.
 *
 * The accent is read live rather than projected because `t3.json` is a
 * checked-in file the user edits by hand; an event-sourced copy would go stale
 * the moment someone pulls a branch. It rides on the project record instead of
 * on the favicon asset URL so sidebar rows know their accent in the same paint
 * that creates them. Fetching it separately repaints the whole list a round
 * trip later, which reads as a flash.
 *
 * Callers pass the resolver rather than pulling it from context so decorating
 * a payload never widens a handler's requirements.
 *
 * @module ProjectAccents
 */
import type { ProjectAccent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";

type Resolver = ProjectFaviconResolver.ProjectFaviconResolver["Service"];

interface AccentTarget {
  readonly workspaceRoot: string;
}

type WithAccent<T> = T & { readonly accent: ProjectAccent | null };

/**
 * A project whose checkout cannot be read still belongs in the payload, so an
 * unreadable workspace resolves to "no accent" rather than failing the
 * snapshot. The accent is always written, never omitted: clearing `accentColor`
 * in `t3.json` has to clear the row, not leave the previous value in place.
 */
const resolveAccent = (
  resolver: Resolver,
  workspaceRoot: string,
): Effect.Effect<ProjectAccent | null> =>
  resolver.resolveAccent(workspaceRoot).pipe(Effect.orElseSucceed(() => null));

/** Attach `accent` to one project record. */
export const withProjectAccent = <T extends AccentTarget>(
  resolver: Resolver,
  project: T,
): Effect.Effect<WithAccent<T>> =>
  resolveAccent(resolver, project.workspaceRoot).pipe(
    Effect.map((accent) => ({ ...project, accent })),
  );

/**
 * Attach `accent` to every project in a shell snapshot.
 */
export const withProjectAccents = <T extends AccentTarget>(
  resolver: Resolver,
  projects: ReadonlyArray<T>,
): Effect.Effect<ReadonlyArray<WithAccent<T>>> =>
  Effect.forEach(projects, (project) => withProjectAccent(resolver, project), {
    concurrency: 16,
  });
