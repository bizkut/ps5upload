import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest's node env has no `window`; the stores persist through
// `window.localStorage`, so give them the same in-memory stub the other
// store tests use.
const mem = new globalThis.Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  // engine.ts reads the page origin when it loads in browser mode.
  location: { origin: "http://127.0.0.1:19113" },
};

const engine = vi.hoisted(() => ({
  start: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  keepAwake: vi.fn(),
}));
vi.mock("../api/ps5", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startSync: engine.start,
  jobStatus: engine.status,
  jobCancel: engine.cancel,
}));
vi.mock("../lib/keepAwakeHold", () => ({ setTransferKeepAwake: engine.keepAwake }));

// Dynamic imports: the stores read `window` while loading, so they must load
// after the stub above (same reason as libraryTaskBridge.test.ts).
const { useSyncPairsStore } = await import("./syncPairs");
const { useTaskStore } = await import("./tasks");
const { useActivityHistoryStore } = await import("./activityHistory");
const { installTaskWiring } = await import("./taskWiring");
const { installActivityWiring } = await import("./activityWiring");
const { commandTask, taskCapabilities } = await import("./taskControls");

const HOST = "10.0.0.7";
let n = 0;

function addPair(): { id: string; name: string } {
  n += 1;
  const name = `Game ${n}`;
  useSyncPairsStore.getState().addPair(HOST, {
    name, srcDir: "/PC/Game", destRoot: "/data/homebrew/Game", excludes: [],
  });
  const pairs = useSyncPairsStore.getState().pairsByHost[HOST];
  return { id: pairs[pairs.length - 1].id, name };
}

const task = (name: string) => useTaskStore.getState().tasks.find((t) => t.label === `Sync: ${name}`);
const entry = (name: string) =>
  useActivityHistoryStore.getState().entries.find((e) => e.label === `Sync: ${name}`);
const lastKeepAwake = () => {
  const calls = engine.keepAwake.mock.calls;
  return calls[calls.length - 1]?.[0];
};

beforeEach(() => {
  installTaskWiring();
  installActivityWiring();
  for (const mock of Object.values(engine)) mock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("folder sync in Tasks and History", () => {
  it("shows a running sync with its stage and bytes, then records it as done", async () => {
    const { id, name } = addPair();
    engine.start.mockResolvedValue("job-1");
    engine.status
      .mockResolvedValueOnce({ status: "running", stage: { id: "upload", index: 1, count: 3, done: 5, total: 50 } })
      .mockResolvedValueOnce({ status: "done", files_sent: 2, bytes_sent: 50, skipped_files: 0, skipped_bytes: 0 });
    const running = useSyncPairsStore.getState().startRun(HOST, id, [], false);
    await vi.advanceTimersByTimeAsync(0);

    expect(task(name)).toMatchObject({
      kind: "folder-sync",
      status: "running",
      consoleId: HOST,
      engineJobId: "job-1",
      stage: "Uploading",
      progress: { current: 5, total: 50, unit: "bytes" },
      control: { owner: "folder-sync", host: HOST, pairId: id },
    });
    expect(entry(name)).toMatchObject({ kind: "folder-sync", outcome: "running", bytes: 5, totalBytes: 50 });
    // A sync is a transfer: the computer must not sleep under it.
    expect(lastKeepAwake()).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(task(name)).toMatchObject({ status: "done", progress: { current: 50, total: 50, unit: "bytes" } });
    expect(entry(name)).toMatchObject({ outcome: "done", bytes: 50 });
    expect(lastKeepAwake()).toBe(false);
  });

  it("counts plan-stage progress in files, not bytes", async () => {
    const { id, name } = addPair();
    engine.start.mockResolvedValue("job-2");
    engine.status
      .mockResolvedValueOnce({ status: "running", stage: { id: "plan", index: 0, count: 3, done: 3, total: 10 } })
      .mockResolvedValueOnce({ status: "done", files_sent: 0, bytes_sent: 0, skipped_files: 10, skipped_bytes: 0 });
    const running = useSyncPairsStore.getState().startRun(HOST, id, [], false);
    await vi.advanceTimersByTimeAsync(0);
    expect(task(name)?.progress).toEqual({ current: 3, total: 10, unit: "files" });
    // History rows render bytes, so plan counters stay out of them.
    expect(entry(name)?.bytes).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await running;
  });

  it("records a failed sync with the engine's reason", async () => {
    const { id, name } = addPair();
    engine.start.mockResolvedValue("job-3");
    engine.status.mockResolvedValue({ status: "failed", error: "sync_source_empty" });
    await useSyncPairsStore.getState().startRun(HOST, id, [], false);
    expect(task(name)).toMatchObject({
      status: "failed",
      lastError: { code: "SYNC_FAILED", message: "sync_source_empty" },
    });
    expect(entry(name)).toMatchObject({ outcome: "failed", error: "sync_source_empty" });
  });

  it("cancels from the Tasks row through the sync store and ends as cancelled", async () => {
    const { id, name } = addPair();
    engine.start.mockResolvedValue("job-4");
    engine.cancel.mockResolvedValue(undefined);
    engine.status
      .mockResolvedValueOnce({ status: "running", stage: { id: "upload", index: 1, count: 3, done: 1, total: 9 } })
      .mockResolvedValueOnce({ status: "failed", error: "cancelled" });
    const running = useSyncPairsStore.getState().startRun(HOST, id, [], false);
    await vi.advanceTimersByTimeAsync(0);

    const row = task(name)!;
    expect(taskCapabilities(row).canCancel).toBe(true);
    expect(await commandTask(row, "cancel")).toBe(true);
    expect(engine.cancel).toHaveBeenCalledWith("job-4");
    // A second cancel while the first is in flight is not offered.
    expect(taskCapabilities(task(name)!).canCancel).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(task(name)?.status).toBe("cancelled");
    expect(entry(name)?.outcome).toBe("stopped");
  });
});
