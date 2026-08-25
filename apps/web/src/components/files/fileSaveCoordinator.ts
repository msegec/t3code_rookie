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
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private suspended = false;

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
    if (this.latestRevision > 0) void this.persistLatest();
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
    this.suspended = false;
    this.clearTimer();
    this.latestRevision = 0;
    this.options.onPendingChange(false);
  }

  /**
   * Hold pending edits while a rename or delete runs, so a save cannot land
   * mid-mutation. The mutation's outcome decides what follows: discard() on
   * success, resume() on failure.
   */
  suspend(): void {
    this.suspended = true;
    this.clearTimer();
  }

  /** Reinstate saving after a failed rename or delete left the file in place. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.latestRevision > 0) this.schedule(0);
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
    if (this.suspended || this.saving || this.latestRevision === 0) return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.options.onConfirmed(contents);
    }

    this.saving = false;
    if (revision === this.latestRevision) {
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
