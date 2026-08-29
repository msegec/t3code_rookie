import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private persistedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private suspendCount = 0;
  private generation = 0;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    // After discard() the file is gone from disk; a late editor change (for
    // example the cache-key rotation replacing the contents) must not revive
    // the revision and recreate the file.
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > this.persistedRevision) void this.persistLatest();
  }

  /** Drop unsaved edits without persisting; for files removed out from under the surface. */
  discard(): void {
    this.disposed = true;
    this.reset();
  }

  /**
   * Drop unsaved edits but keep saving alive; for files replaced on disk,
   * where the surface reloads the new contents and editing continues.
   */
  reset(): void {
    // A save already on the wire belongs to the replaced file; bumping the
    // generation makes its completion drop the result instead of advancing
    // the zeroed watermark or confirming stale contents.
    this.generation += 1;
    // Only the settling mutation's own hold is released; an overlapping
    // mutation still writing keeps its hold, so a later edit cannot save
    // mid-mutation and overwrite that writer's result.
    if (this.suspendCount > 0) this.suspendCount -= 1;
    this.clearTimer();
    this.latestRevision = 0;
    this.persistedRevision = 0;
    this.options.onPendingChange(false);
  }

  /**
   * Hold pending edits while a rename, delete, or overwrite upload runs, so a
   * save cannot land mid-mutation. Holds count: overlapping mutations of the
   * same file each take one, and saving stays held until every one has been
   * released by discard(), reset(), or resume().
   */
  suspend(): void {
    this.suspendCount += 1;
    this.clearTimer();
  }

  /**
   * Release one hold after a failed mutation left the file in place. Only
   * edits newer than the last successful save reschedule; a snapshot that
   * already persisted must not overwrite what another writer put on disk
   * since.
   */
  resume(): void {
    if (this.suspendCount === 0) return;
    this.suspendCount -= 1;
    if (this.suspendCount > 0) return;
    if (this.latestRevision > this.persistedRevision) this.schedule(0);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.suspendCount > 0 || this.saving || this.latestRevision <= this.persistedRevision) {
      return;
    }

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const generation = this.generation;
    const result = await this.options.persist(contents);
    // A reset while the write was on the wire replaced the file under this
    // snapshot: the result describes bytes that no longer exist, so it must
    // not advance the watermark or confirm the pre-replacement contents.
    const stale = generation !== this.generation;
    const succeeded = !stale && result._tag === "Success";
    if (succeeded) {
      this.persistedRevision = revision;
      this.options.onConfirmed(contents);
    }

    this.saving = false;
    if (stale && this.latestRevision <= this.persistedRevision) {
      return;
    }
    if (!stale && revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}
