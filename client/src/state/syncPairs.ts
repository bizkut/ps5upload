import { create } from "zustand";
import { jobCancel, jobStatus, startSync, humanizeJobErrorReason } from "../api/ps5";
import type { JobSnapshot, SyncSummary } from "../api/ps5";
import { hostOf, transferAddr } from "../lib/addr";
import { safeGetItem, safeSetItem } from "../lib/safeStorage";
import { trStatic } from "../lib/trStatic";

const KEY = "ps5upload.sync_pairs.v1";
// Match the upload queue's status cadence without overlapping requests.
const POLL_INTERVAL_MS = 500;

export type SyncPairResult =
  | {
      status: "done";
      files_sent: number;
      bytes_sent: number;
      skipped_files: number;
      skipped_bytes: number;
      sync?: SyncSummary;
    }
  | { status: "failed"; error: string };

export interface SyncPairFields {
  name: string;
  srcDir: string;
  destRoot: string;
  excludes: string[];
}

export interface SyncPair extends SyncPairFields {
  id: string;
  host: string;
  /** Completion time of the most recent attempt, successful or failed. */
  lastSyncAtMs?: number;
  lastResult?: SyncPairResult;
}

export interface SyncRun {
  host: string;
  jobId?: string;
  snapshot?: JobSnapshot;
  cancelling: boolean;
  /** A status/cancel request error is not a terminal engine-job failure. */
  error?: string;
  cancelError?: string;
}

type PairsByHost = Record<string, SyncPair[]>;

interface SyncPairsState {
  pairsByHost: PairsByHost;
  /** Session-only runs live outside the screen so navigation cannot lose them. */
  runs: Record<string, SyncRun>;
  addPair: (host: string, fields: SyncPairFields) => void;
  updatePair: (host: string, id: string, fields: SyncPairFields) => void;
  removePair: (host: string, id: string) => void;
  recordResult: (host: string, id: string, result: SyncPairResult) => void;
  startRun: (
    host: string,
    id: string,
    approvedDeletes: string[],
    verify: boolean,
    bandwidthCapMbps?: number,
    streams?: number,
  ) => Promise<void>;
  cancelRun: (host: string, id: string) => Promise<void>;
}

export function syncPairRunKey(host: string, id: string): string {
  return `${hostOf(host.trim())}\0${id}`;
}

/** Sync reads the engine host's filesystem, not a saved server or PS5 URI. */
export function isLocalSyncPath(path: string): boolean {
  return !!path.trim() && !/^[a-z][a-z\d+.-]*:\/\//i.test(path.trim());
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validSummary(value: unknown): value is SyncSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<SyncSummary>;
  return isCount(summary.deleted_count) && isCount(summary.deleted_bytes) &&
    isCount(summary.verified_count) && typeof summary.manifest_saved === "boolean" &&
    isStringArray(summary.delete_skipped) && Array.isArray(summary.delete_failed) &&
    summary.delete_failed.every((item) => !!item && typeof item === "object" &&
      typeof item.path === "string" && typeof item.error === "string");
}

function validResult(value: unknown): value is SyncPairResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<SyncPairResult>;
  if (result.status === "failed") return typeof result.error === "string";
  return result.status === "done" && isCount(result.files_sent) && isCount(result.bytes_sent) &&
    isCount(result.skipped_files) && isCount(result.skipped_bytes) &&
    (result.sync === undefined || validSummary(result.sync));
}

function validPair(value: unknown, host: string): value is SyncPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pair = value as Partial<SyncPair>;
  return typeof pair.id === "string" && !!pair.id.trim() &&
    typeof pair.name === "string" && !!pair.name.trim() &&
    typeof pair.host === "string" && hostOf(pair.host.trim()) === host &&
    typeof pair.srcDir === "string" && isLocalSyncPath(pair.srcDir) &&
    typeof pair.destRoot === "string" && pair.destRoot.startsWith("/") &&
    isStringArray(pair.excludes) &&
    (pair.lastSyncAtMs === undefined || isCount(pair.lastSyncAtMs)) &&
    (pair.lastResult === undefined || validResult(pair.lastResult));
}

function loadPairs(): PairsByHost {
  try {
    const raw = safeGetItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = new Map<string, SyncPair[]>();
    const ids = new Set<string>();
    for (const [key, values] of Object.entries(parsed)) {
      const host = hostOf(key.trim());
      if (!host || !Array.isArray(values)) continue;
      for (const value of values) {
        if (!validPair(value, host)) continue;
        const id = syncPairRunKey(host, value.id);
        if (ids.has(id)) continue;
        ids.add(id);
        const pairs = entries.get(host) ?? [];
        pairs.push({
          id: value.id,
          name: value.name,
          host,
          srcDir: value.srcDir,
          destRoot: value.destRoot,
          excludes: value.excludes,
          lastSyncAtMs: value.lastSyncAtMs,
          lastResult: value.lastResult,
        });
        entries.set(host, pairs);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    // Broken JSON or blocked storage must not prevent the screen opening.
    return {};
  }
}

function persist(pairsByHost: PairsByHost): void {
  safeSetItem(KEY, JSON.stringify(pairsByHost));
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const useSyncPairsStore = create<SyncPairsState>((set, get) => {
  const patchRun = (key: string, patch: Partial<SyncRun>) => {
    set((state) => {
      const run = state.runs[key];
      return run ? { runs: { ...state.runs, [key]: { ...run, ...patch } } } : state;
    });
  };

  const finishRun = (host: string, id: string, result: SyncPairResult) => {
    get().recordResult(host, id, result);
    set((state) => {
      const runs = { ...state.runs };
      delete runs[syncPairRunKey(host, id)];
      return { runs };
    });
  };

  const monitorRun = async (host: string, id: string, jobId: string) => {
    const key = syncPairRunKey(host, id);
    while (get().runs[key]?.jobId === jobId) {
      try {
        const snapshot = await jobStatus(jobId);
        if (get().runs[key]?.jobId !== jobId) return;
        if (snapshot.status === "done") {
          finishRun(host, id, {
            status: "done",
            files_sent: snapshot.files_sent ?? 0,
            bytes_sent: snapshot.bytes_sent ?? 0,
            skipped_files: snapshot.skipped_files ?? 0,
            skipped_bytes: snapshot.skipped_bytes ?? 0,
            sync: snapshot.sync,
          });
          return;
        }
        if (snapshot.status === "failed") {
          const message = humanizeJobErrorReason(snapshot.error_reason) ?? snapshot.error ??
            trStatic("sync_failed", "Sync failed");
          finishRun(host, id, {
            status: "failed",
            error: snapshot.error_detail ? `${message}\n${snapshot.error_detail}` : message,
          });
          return;
        }
        patchRun(key, { snapshot, error: undefined });
      } catch (error) {
        // Keep ownership and cancellation available: a failed status request
        // does not mean the engine stopped changing the destination.
        patchRun(key, { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  return {
    pairsByHost: loadPairs(),
    runs: {},
    addPair: (rawHost, fields) => {
      const host = hostOf(rawHost.trim());
      if (!host) return;
      const pair: SyncPair = { ...fields, id: newId(), host, excludes: [...fields.excludes] };
      const pairsByHost = { ...get().pairsByHost, [host]: [...(get().pairsByHost[host] ?? []), pair] };
      persist(pairsByHost);
      set({ pairsByHost });
    },
    updatePair: (rawHost, id, fields) => {
      const host = hostOf(rawHost.trim());
      if (get().runs[syncPairRunKey(host, id)]) return;
      const pairsByHost = {
        ...get().pairsByHost,
        [host]: (get().pairsByHost[host] ?? []).map((pair) => {
          if (pair.id !== id) return pair;
          const changed = pair.srcDir !== fields.srcDir || pair.destRoot !== fields.destRoot ||
            pair.excludes.length !== fields.excludes.length ||
            pair.excludes.some((pattern, index) => pattern !== fields.excludes[index]);
          return {
            ...pair,
            ...fields,
            excludes: [...fields.excludes],
            ...(changed ? { lastSyncAtMs: undefined, lastResult: undefined } : {}),
          };
        }),
      };
      persist(pairsByHost);
      set({ pairsByHost });
    },
    removePair: (rawHost, id) => {
      const host = hostOf(rawHost.trim());
      if (get().runs[syncPairRunKey(host, id)]) return;
      const pairsByHost = {
        ...get().pairsByHost,
        [host]: (get().pairsByHost[host] ?? []).filter((pair) => pair.id !== id),
      };
      persist(pairsByHost);
      set({ pairsByHost });
    },
    recordResult: (rawHost, id, lastResult) => {
      const host = hostOf(rawHost.trim());
      const lastSyncAtMs = Date.now();
      const pairsByHost = {
        ...get().pairsByHost,
        [host]: (get().pairsByHost[host] ?? []).map((pair) =>
          pair.id === id ? { ...pair, lastSyncAtMs, lastResult } : pair),
      };
      persist(pairsByHost);
      set({ pairsByHost });
    },
    startRun: async (rawHost, id, approvedDeletes, verify, bandwidthCapMbps, streams) => {
      const host = hostOf(rawHost.trim());
      const pair = get().pairsByHost[host]?.find((entry) => entry.id === id);
      if (!pair || Object.values(get().runs).some((run) => run.host === host)) return;
      const key = syncPairRunKey(host, id);
      set((state) => ({ runs: { ...state.runs, [key]: { host, cancelling: false } } }));
      let jobId: string;
      try {
        jobId = await startSync(
          pair.srcDir, pair.destRoot, transferAddr(host), approvedDeletes,
          pair.excludes, verify, bandwidthCapMbps, streams,
        );
      } catch (error) {
        finishRun(host, id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      patchRun(key, { jobId });
      // Cancel can be requested before the start request returns its job id.
      if (get().runs[key]?.cancelling) await get().cancelRun(host, id);
      await monitorRun(host, id, jobId);
    },
    cancelRun: async (host, id) => {
      const key = syncPairRunKey(host, id);
      const run = get().runs[key];
      if (!run) return;
      patchRun(key, { cancelling: true, cancelError: undefined });
      if (!run.jobId) return;
      try {
        await jobCancel(run.jobId);
      } catch (error) {
        patchRun(key, {
          cancelling: false,
          cancelError: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
});
