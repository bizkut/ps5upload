import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalSyncPath } from "./syncPairs";
import type { SyncPairFields } from "./syncPairs";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../lib/safeStorage", () => ({ safeGetItem: mocks.read, safeSetItem: mocks.write }));
vi.mock("../api/ps5", () => ({
  startSync: mocks.start,
  jobStatus: mocks.status,
  jobCancel: mocks.cancel,
  humanizeJobErrorReason: () => null,
}));
vi.mock("../lib/trStatic", () => ({ trStatic: (_key: string, fallback: string) => fallback }));

const fields: SyncPairFields = {
  name: "Game", srcDir: "/PC/Game", destRoot: "/data/homebrew/Game", excludes: ["fakelib", "saves"],
};
const done = {
  status: "done",
  files_sent: 2,
  bytes_sent: 50,
  skipped_files: 8,
  skipped_bytes: 200,
  sync: {
    deleted_count: 1,
    deleted_bytes: 10,
    delete_skipped: ["new/old.bin"],
    delete_failed: [{ path: "locked.bin", error: "Permission denied" }],
    verified_count: 3,
    manifest_saved: false,
  },
};

async function load(raw: string | null = null) {
  // Loading is the boundary under test: a static import would initialize the
  // store before this test's persisted document can be supplied.
  vi.resetModules();
  mocks.read.mockReturnValue(raw);
  return (await import("./syncPairs")).useSyncPairsStore;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("saved sync pairs", () => {
  it("drops malformed entries and canonicalizes console keys without losing valid siblings", async () => {
    const pair = { ...fields, id: "valid", host: "10.0.0.2", lastSyncAtMs: 100, lastResult: done };
    const store = await load(JSON.stringify({
      "10.0.0.2:9113": [
        pair,
        { ...pair, id: "wrong-host", host: "10.0.0.3" },
        { ...pair, id: "remote", srcDir: "remote://nas/G" },
        { ...pair, id: "console", srcDir: "ps5://10.0.0.2/data/G" },
        { ...pair, id: "no-excludes", excludes: null },
        { ...pair, id: "bad-time", lastSyncAtMs: -1 },
        { ...pair, id: "bad-result", lastResult: { ...done, sync: { ...done.sync, manifest_saved: "false" } } },
      ],
      "10.0.0.2": [pair],
      "10.0.0.3": "not a list",
    }));
    expect(store.getState().pairsByHost).toEqual({ "10.0.0.2": [pair] });
  });

  it("treats broken JSON and non-object documents as an empty store", async () => {
    for (const raw of ["{", "null", "[]", '"pair"']) {
      expect((await load(raw)).getState().pairsByHost).toEqual({});
    }
  });

  it("persists CRUD per console and does not edit a different console's pairs", async () => {
    const store = await load();
    store.getState().addPair("10.0.0.2:9113", fields);
    store.getState().addPair("10.0.0.3", fields);
    const id = store.getState().pairsByHost["10.0.0.2"][0].id;
    store.getState().updatePair("10.0.0.2", id, { ...fields, name: "Updated" });
    expect(store.getState().pairsByHost["10.0.0.2"][0].name).toBe("Updated");
    expect(store.getState().pairsByHost["10.0.0.3"][0].name).toBe("Game");
    store.getState().removePair("10.0.0.2", id);
    expect(store.getState().pairsByHost["10.0.0.2"]).toEqual([]);
    const calls = mocks.write.mock.calls;
    const reloaded = await load(calls[calls.length - 1][1]);
    const after = reloaded.getState().pairsByHost;
    expect(after["10.0.0.2"] ?? []).toEqual([]);
    expect(after["10.0.0.3"]).toMatchObject([{ ...fields, host: "10.0.0.3", name: "Game" }]);
  });

  it("keeps results on a rename but clears stale results when the sync mapping changes", async () => {
    const store = await load();
    store.getState().addPair("10.0.0.2", fields);
    const id = store.getState().pairsByHost["10.0.0.2"][0].id;
    store.getState().recordResult("10.0.0.2", id, { status: "failed", error: "offline" });
    store.getState().updatePair("10.0.0.2", id, { ...fields, name: "Renamed" });
    expect(store.getState().pairsByHost["10.0.0.2"][0].lastResult).toEqual({ status: "failed", error: "offline" });
    store.getState().updatePair("10.0.0.2", id, { ...fields, destRoot: "/data/homebrew/NewGame" });
    expect(store.getState().pairsByHost["10.0.0.2"][0].lastResult).toBeUndefined();
    expect(store.getState().pairsByHost["10.0.0.2"][0].lastSyncAtMs).toBeUndefined();
  });

  it("only accepts local device paths, including Windows and UNC paths", async () => {
    expect(isLocalSyncPath("/PC/Game")).toBe(true);
    expect(isLocalSyncPath("C:\\Games\\Game")).toBe(true);
    expect(isLocalSyncPath("\\\\PC\\Games\\Game")).toBe(true);
    for (const path of ["", "  ", "remote://nas/Game", "ps5://10.0.0.2/data/G", "content://folder"]) {
      expect(isLocalSyncPath(path)).toBe(false);
    }
  });
});

describe("sync job ownership and completion", () => {
  it("forwards exact approved paths and records the finished job on the pair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = await load();
    store.getState().addPair("10.0.0.2", fields);
    const pair = store.getState().pairsByHost["10.0.0.2"][0];
    mocks.start.mockResolvedValue("job-sync");
    mocks.status.mockResolvedValueOnce({ status: "running", stage: { id: "upload", done: 5, total: 50 } }).mockResolvedValueOnce(done);
    const running = store.getState().startRun(pair.host, pair.id, ["old.dir", "sub/old.bin"], true, 20, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.start).toHaveBeenCalledWith(fields.srcDir, fields.destRoot, "10.0.0.2:9113", ["old.dir", "sub/old.bin"], fields.excludes, true, 20, 2);
    await vi.advanceTimersByTimeAsync(500);
    await running;
    const saved = store.getState().pairsByHost[pair.host][0];
    expect(saved.lastSyncAtMs).toBe(1500);
    expect(saved.lastResult).toEqual(done);
    expect(store.getState().runs).toEqual({});
    const calls = mocks.write.mock.calls;
    expect(JSON.parse(calls[calls.length - 1][1])[pair.host][0].lastResult).toEqual(done);
  });

  it("records failed engine jobs and releases the console", async () => {
    const store = await load();
    store.getState().addPair("10.0.0.2", fields);
    const pair = store.getState().pairsByHost["10.0.0.2"][0];
    mocks.start.mockResolvedValue("job-sync");
    mocks.status.mockResolvedValue({ status: "failed", error: "sync_source_empty" });
    await store.getState().startRun(pair.host, pair.id, [], false);
    expect(store.getState().pairsByHost[pair.host][0].lastResult).toEqual({ status: "failed", error: "sync_source_empty" });
    expect(store.getState().runs).toEqual({});
  });

  it("keeps job ownership on a polling error rather than reporting a false failure", async () => {
    vi.useFakeTimers();
    const store = await load();
    store.getState().addPair("10.0.0.2", fields);
    const pair = store.getState().pairsByHost["10.0.0.2"][0];
    mocks.start.mockResolvedValue("job-sync");
    mocks.status.mockRejectedValueOnce(new Error("status offline")).mockResolvedValueOnce(done);
    const running = store.getState().startRun(pair.host, pair.id, [], false);
    await vi.advanceTimersByTimeAsync(0);
    const run = Object.values(store.getState().runs)[0];
    expect(run.error).toBe("status offline");
    expect(run.jobId).toBe("job-sync");
    expect(store.getState().pairsByHost[pair.host][0].lastResult).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(store.getState().pairsByHost[pair.host][0].lastResult?.status).toBe("done");
  });

  it("blocks edits and another sync on the same console, and honours cancellation before the job id arrives", async () => {
    const store = await load();
    store.getState().addPair("10.0.0.2", fields);
    store.getState().addPair("10.0.0.2", { ...fields, name: "Other", srcDir: "/PC/Other" });
    const [pair, other] = store.getState().pairsByHost["10.0.0.2"];
    let resolveStart!: (jobId: string) => void;
    mocks.start.mockReturnValue(new Promise<string>((resolve) => { resolveStart = resolve; }));
    mocks.cancel.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ status: "failed", error: "cancelled" });
    const running = store.getState().startRun(pair.host, pair.id, [], false);
    store.getState().updatePair(pair.host, pair.id, { ...fields, name: "Changed" });
    store.getState().removePair(pair.host, pair.id);
    await store.getState().startRun(other.host, other.id, [], false);
    await store.getState().cancelRun(pair.host, pair.id);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(store.getState().pairsByHost[pair.host][0].name).toBe("Game");
    resolveStart("job-sync");
    await running;
    expect(mocks.cancel).toHaveBeenCalledWith("job-sync");
    expect(store.getState().pairsByHost[pair.host][0].lastResult).toEqual({ status: "failed", error: "cancelled" });
  });
});
