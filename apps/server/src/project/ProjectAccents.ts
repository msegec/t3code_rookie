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
 * @module ProjectAccents
 */
import type { ProjectAccent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";

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
const resolveAccent = Effect.fn("ProjectAccents.resolveAccent")(function* (workspaceRoot: string) {
  const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  return yield* resolver.resolveAccent(workspaceRoot).pipe(Effect.orElseSucceed(() => null));
});

/** Attach `accent` to one project record. */
export const withProjectAccent = Effect.fn("ProjectAccents.withProjectAccent")(function* <
  T extends AccentTarget,
>(project: T) {
  const accent = yield* resolveAccent(project.workspaceRoot);
  return { ...project, accent } as WithAccent<T>;
});

/**
 * Attach `accent` to every project in a shell snapshot.
 */
export const withProjectAccents = <T extends AccentTarget>(projects: ReadonlyArray<T>) =>
  Effect.forEach(projects, withProjectAccent, {
    concurrency: 16,
  });
