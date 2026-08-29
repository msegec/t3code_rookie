import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: (result: AtomCommandResult<void, never>) => void;
  const promise = new Promise<AtomCommandResult<void, never>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and persists only the latest contents", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("saves an edit made inside the debounce window when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved");
  });

  it("flushes an edit made while a write was in flight when the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("does not rewrite a write that lands while the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("only");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
  });

  it("retries a failed write when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed")))),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores editor changes emitted after disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.dispose();
    coordinator.change("stale contents");
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("discard drops unsaved edits instead of flushing them on dispose", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("doomed");
    coordinator.discard();
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("ignores changes made after discard", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.discard();
    coordinator.change("late editor churn");
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalledWith(true);
  });

  it("reset drops pending edits but later changes still save", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("stale pre-upload edit");
    coordinator.reset();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);

    coordinator.change("fresh edit");
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("fresh edit");
  });

  it("a save resolving after reset neither confirms nor blocks later edits", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed,
    });

    coordinator.change("pre-upload snapshot");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.reset();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(onConfirmed).not.toHaveBeenCalled();

    coordinator.change("post-upload edit");
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("post-upload edit");
    expect(onConfirmed).toHaveBeenCalledWith("post-upload edit");
  });

  it("an edit made after reset saves once the stale write resolves", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed,
    });

    coordinator.change("pre-upload snapshot");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.reset();
    coordinator.change("edited while the stale write was in flight");
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("edited while the stale write was in flight");
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(onConfirmed).toHaveBeenCalledWith("edited while the stale write was in flight");
  });

  it("suspend holds saves and resume persists the held edits", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("held");
    coordinator.suspend();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).not.toHaveBeenCalled();

    coordinator.resume();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("held");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("suspend then discard drops the held edits", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("doomed");
    coordinator.suspend();
    coordinator.discard();
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("does not persist confirmed contents again on disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("temporary edit");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("original contents");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(2);

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("resume does not re-persist a snapshot that already saved", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("saved before the mutation");
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();

    coordinator.suspend();
    coordinator.resume();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("resume persists an edit made after the last successful save", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("saved");
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();

    coordinator.change("edited during the mutation window");
    coordinator.suspend();
    coordinator.resume();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("edited during the mutation window");
  });

  it("overlapping suspends hold saves until the last resume", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("held");
    coordinator.suspend();
    coordinator.suspend();
    coordinator.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).not.toHaveBeenCalled();

    coordinator.resume();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("held");
  });

  it("reset releases only the settling mutation's hold", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.suspend();
    coordinator.suspend();
    coordinator.reset();
    coordinator.change("edited while the other mutation still writes");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).not.toHaveBeenCalled();

    coordinator.resume();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("edited while the other mutation still writes");
  });

  it("dispose while suspended does not flush behind a pending mutation", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unflushed");
    coordinator.suspend();
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
  });
});
