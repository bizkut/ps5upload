import { useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, FolderOpen, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  ConnectionGate,
  EmptyState,
  ErrorCard,
  Input,
  Modal,
  PageHeader,
  ProgressBar,
  Textarea,
  WarningCard,
} from "../../components";
import { useConfirm } from "../../components/ConfirmDialog";
import { syncPreview } from "../../api/ps5";
import type { SyncPreview } from "../../api/ps5";
import { hostOf, transferAddr } from "../../lib/addr";
import { formatBytes } from "../../lib/format";
import { useStaleHostGuard } from "../../lib/staleHostGuard";
import { effectiveUploadStreams } from "../../lib/uploadStreams";
import { useConnectionStore } from "../../state/connection";
import { useTr, type Translator } from "../../state/lang";
import { pickLocalPath } from "../../state/localPicker";
import { isLocalSyncPath, syncPairRunKey, syncRunStage, useSyncPairsStore } from "../../state/syncPairs";
import type { SyncPair, SyncPairResult, SyncRun } from "../../state/syncPairs";
import { useUploadQueueStore } from "../../state/uploadQueue";
import { useUploadSettingsStore } from "../../state/uploadSettings";

type PairDraft = {
  id?: string;
  name: string;
  srcDir: string;
  destRoot: string;
  excludes: string;
};

function PreviewDetails({ preview }: { preview: SyncPreview }) {
  const tr = useTr();
  return (
    <div className="space-y-3 border-t border-[var(--color-border)] pt-4 text-sm">
      <h3 className="font-semibold">{tr("sync_preview_title", undefined, "Preview — no changes made")}</h3>
      <p className="text-xs text-[var(--color-muted)]">
        {preview.has_manifest
          ? tr("sync_manifest_available", undefined, "A previous sync manifest is available.")
          : tr("sync_first_run", undefined, "First sync: same-size files will be verified before deciding what to upload.")}
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-[var(--color-muted)]">{tr("sync_to_send", undefined, "To upload")}</dt>
          <dd>{tr("sync_file_bytes", { count: preview.to_send_count, bytes: formatBytes(preview.to_send_bytes) }, "{count} files · {bytes}")}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted)]">{tr("sync_to_verify", undefined, "To verify")}</dt>
          <dd>{tr("sync_file_bytes", { count: preview.to_verify_count, bytes: formatBytes(preview.to_verify_bytes) }, "{count} files · {bytes}")}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted)]">{tr("sync_unchanged", undefined, "Unchanged")}</dt>
          <dd>{tr("sync_file_bytes", { count: preview.unchanged_count, bytes: formatBytes(preview.unchanged_bytes) }, "{count} files · {bytes}")}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted)]">{tr("sync_to_delete", undefined, "To delete on PS5")}</dt>
          <dd>{tr("sync_delete_totals", { entries: preview.to_delete.length, files: preview.delete_files, bytes: formatBytes(preview.delete_bytes) }, "{entries} entries · {files} files · {bytes}")}</dd>
        </div>
      </dl>
      <p className="text-xs text-[var(--color-muted)]">
        {tr("sync_kept", { count: preview.kept_count }, "{count} protected PS5 entries kept")}
      </p>
      {preview.to_verify_count > 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          {tr("sync_verify_preview_hint", undefined, "Preview does not hash files. Verification during sync may find more files to upload.")}
        </p>
      )}
      {preview.blocked?.length ? (
        <WarningCard
          title={tr("sync_blocked_title", undefined, "Protected PS5 entries are blocking this sync.")}
          detail={
            <div className="space-y-2">
              <p>{tr("sync_blocked_hint", undefined, "Remove or rename these on the PS5, or adjust excludes, then Preview again.")}</p>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {preview.blocked.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}
              </ul>
            </div>
          }
        />
      ) : null}
      {preview.sample_to_send.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium">{tr("sync_send_sample", undefined, "Files to upload (sample)")}</summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
            {preview.sample_to_send.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}
          </ul>
        </details>
      )}
      {preview.to_delete.length > 0 ? (
        <details open>
          <summary className="cursor-pointer text-xs font-medium text-[var(--color-warn)]">
            {tr("sync_delete_list", { count: preview.to_delete.length }, "PS5 entries to delete ({count})")}
          </summary>
          <ul className="mt-2 max-h-60 space-y-2 overflow-y-auto text-xs">
            {preview.to_delete.map((entry) => (
              <li key={entry.path} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0 break-all font-mono">
                  {entry.kind === "dir" ? `${entry.path}/` : entry.path}
                  {entry.blocks_upload && (
                    <span className="ml-2 font-sans text-[var(--color-warn)]">
                      {tr("sync_conflict_marker", undefined, "(replaced by a file/folder from your PC)")}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[var(--color-muted)]">
                  {tr("sync_file_bytes", { count: entry.files, bytes: formatBytes(entry.bytes) }, "{count} files · {bytes}")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">{tr("sync_no_deletes", undefined, "No PS5 deletions planned.")}</p>
      )}
    </div>
  );
}

function SyncProgress({ run, onCancel }: { run: SyncRun; onCancel: () => void }) {
  const tr = useTr();
  const { id, done, total } = syncRunStage(run);
  const label = id === "start"
    ? tr("sync_starting", undefined, "Starting sync…")
    : id === "upload"
      ? tr("sync_stage_upload", undefined, "Uploading")
      : id === "delete"
        ? tr("sync_stage_delete", undefined, "Deleting")
        : tr("sync_stage_plan", undefined, "Planning / Verifying");
  const detail = id === "upload"
    ? tr("sync_byte_progress", { done: formatBytes(done), total: formatBytes(total) }, "{done} / {total}")
    : id === "delete"
      ? tr("sync_delete_progress", { done, total }, "{done} / {total} entries")
      : total > 0
        ? tr("sync_verify_progress", { done, total }, "{done} / {total} files verified")
        : tr("sync_scanning", undefined, "Scanning PC and PS5 folders…");
  return (
    <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <p className="font-semibold" role="status">{label}</p>
          <p className="mt-1 text-xs tabular-nums text-[var(--color-muted)]">{detail}</p>
        </div>
        <Button variant="danger" onClick={onCancel} disabled={run.cancelling} loading={run.cancelling}>
          {run.cancelling ? tr("sync_cancelling", undefined, "Cancelling…") : tr("cancel", undefined, "Cancel")}
        </Button>
      </div>
      <ProgressBar label={label} value={total > 0 ? done / total : undefined} />
      {run.error && (
        <ErrorCard title={tr("sync_status_error", undefined, "Can't read sync status. The job may still be running.")} detail={run.error} />
      )}
      {run.cancelError && (
        <ErrorCard title={tr("sync_cancel_error", undefined, "Couldn't cancel sync. Try Cancel again.")} detail={run.cancelError} />
      )}
    </div>
  );
}

/** Engine sync refusals carry a stable code; preview and run failures share it. */
function humanizeSyncError(tr: Translator, message: string): string {
  if (message.includes("sync_dest_too_broad")) {
    return tr("sync_error_dest", undefined, "Choose a specific PS5 folder, not / or a storage root such as /data or /mnt/usb0.");
  }
  if (message.includes("sync_source_empty")) {
    return tr("sync_error_empty", undefined, "The PC folder has no regular files. Sync stopped without changing the PS5; check the folder and excludes.");
  }
  if (message.includes("sync_conflict_not_approved")) {
    return tr("sync_error_conflict", undefined, "The PS5 now has a file/folder conflict that wasn't approved. Preview again and confirm the replacements before syncing.");
  }
  if (message.includes("sync_conflict_protected")) {
    return tr("sync_error_protected", undefined, "Protected PS5 entries are blocking PC files. Remove or rename them on the PS5, or adjust excludes, then Preview again.");
  }
  return message;
}

function SyncResult({ result }: { result: SyncPairResult }) {
  const tr = useTr();
  if (result.status === "failed") {
    const message = humanizeSyncError(tr, result.error);
    return (
      <ErrorCard
        title={tr("sync_failed", undefined, "Sync failed")}
        detail={<div className="space-y-2"><p>{message}</p>{message !== result.error && <p className="break-all font-mono">{result.error}</p>}</div>}
      />
    );
  }
  const summary = result.sync;
  const hasWarnings = !summary || !summary.manifest_saved ||
    summary.delete_failed.length > 0 || summary.delete_skipped.length > 0;
  return (
    <div className="space-y-3 border-t border-[var(--color-border)] pt-4 text-sm">
      <p className={`font-semibold ${hasWarnings ? "text-[var(--color-warn)]" : "text-[var(--color-good)]"}`} role="status">
        {hasWarnings
          ? tr("sync_done_warnings", undefined, "Sync finished with warnings")
          : tr("sync_done", undefined, "Sync finished")}
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--color-muted)]">{tr("sync_sent", undefined, "Sent")}</dt>
          <dd>{tr("sync_file_bytes", { count: result.files_sent, bytes: formatBytes(result.bytes_sent) }, "{count} files · {bytes}")}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-muted)]">{tr("sync_unchanged", undefined, "Unchanged")}</dt>
          <dd>{tr("sync_file_bytes", { count: result.skipped_files, bytes: formatBytes(result.skipped_bytes) }, "{count} files · {bytes}")}</dd>
        </div>
        {summary && (
          <>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">{tr("sync_deleted", undefined, "Deleted on PS5")}</dt>
              <dd>{tr("sync_entry_bytes", { count: summary.deleted_count, bytes: formatBytes(summary.deleted_bytes) }, "{count} entries · {bytes}")}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">{tr("sync_verified", undefined, "Verified")}</dt>
              <dd>{tr("sync_file_count", { count: summary.verified_count }, "{count} files")}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">{tr("sync_delete_skipped", undefined, "Deletions skipped (not approved)")}</dt>
              <dd>{summary.delete_skipped.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">{tr("sync_delete_failed", undefined, "Deletions failed")}</dt>
              <dd>{summary.delete_failed.length}</dd>
            </div>
          </>
        )}
      </dl>
      {summary?.delete_skipped.length ? (
        <details>
          <summary className="cursor-pointer text-xs text-[var(--color-warn)]">{tr("sync_skipped_paths", undefined, "PS5 paths kept because they weren't approved")}</summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
            {summary.delete_skipped.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}
          </ul>
        </details>
      ) : null}
      {summary?.delete_failed.length ? (
        <details open>
          <summary className="cursor-pointer text-xs text-[var(--color-warn)]">{tr("sync_failed_paths", undefined, "PS5 paths that couldn't be deleted")}</summary>
          <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto text-xs">
            {summary.delete_failed.map((entry) => (
              <li key={entry.path}>
                <p className="break-all font-mono">{entry.path}</p>
                <p className="break-all text-[var(--color-muted)]">{entry.error}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {summary?.manifest_saved === false && (
        <WarningCard title={tr("sync_manifest_warning", undefined, "The sync manifest wasn't saved.")} detail={tr("sync_manifest_warning_detail", undefined, "The files were synced, but the next run may need to verify them again.")} />
      )}
      {!summary && <WarningCard title={tr("sync_summary_missing", undefined, "The engine didn't return deletion or manifest details for this run.")} />}
    </div>
  );
}

/** Saved, manual syncs only. Destructive approval belongs to one fresh preview,
 *  never to the saved pair or a previous run. */
export default function SyncScreen() {
  const tr = useTr();
  const selectedHost = useConnectionStore((state) => state.host);
  const host = hostOf(selectedHost.trim());
  const payloadStatus = useConnectionStore((state) => state.payloadStatus);
  const engineStatus = useConnectionStore((state) => state.engineStatus);
  const ready = !!host && payloadStatus === "up" && engineStatus !== "down";
  const pairsByHost = useSyncPairsStore((state) => state.pairsByHost);
  const runs = useSyncPairsStore((state) => state.runs);
  const pairs = pairsByHost[host] ?? [];
  const consoleRunning = Object.values(runs).some((run) => run.host === host);
  const queueRunning = useUploadQueueStore((state) => !!state.runningHosts[host]);
  const guard = useStaleHostGuard();
  const { confirm, dialog } = useConfirm();
  const [editor, setEditor] = useState<PairDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [fullVerify, setFullVerify] = useState(false);
  const [busyPair, setBusyPair] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, SyncPreview>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function openEditor(pair?: SyncPair) {
    setEditorError(null);
    setEditor(pair ? {
      id: pair.id, name: pair.name, srcDir: pair.srcDir,
      destRoot: pair.destRoot, excludes: pair.excludes.join("\n"),
    } : { name: "", srcDir: "", destRoot: "", excludes: "" });
  }

  async function browseFolder(field: "srcDir" | "destRoot") {
    const probe = guard.capture();
    setPicking(true);
    setEditorError(null);
    try {
      const path = await pickLocalPath({
        mode: "folder",
        source: field === "srcDir" ? "local" : { console: probe.host },
        title: field === "srcDir"
          ? tr("sync_pick_local", undefined, "Choose the PC folder")
          : tr("sync_pick_ps5", undefined, "Choose the PS5 destination folder"),
      });
      if (!path || !mountedRef.current || probe.isStale()) return;
      let value = path;
      if (field === "srcDir") {
        if (!isLocalSyncPath(path)) throw new Error(tr("sync_local_only", undefined, "Choose a folder on this device. Saved-server and PS5 paths can't be used as the PC source."));
      } else {
        const prefix = `ps5://${hostOf(probe.host.trim())}`;
        if (!path.startsWith(`${prefix}/`)) throw new Error(tr("sync_wrong_console", undefined, "Choose a destination on the selected PS5."));
        value = path.slice(prefix.length);
      }
      setEditor((current) => current ? { ...current, [field]: value } : null);
    } catch (err) {
      if (mountedRef.current && !probe.isStale()) setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && !probe.isStale()) setPicking(false);
    }
  }

  function savePair() {
    if (!editor || !host) return;
    const fields = {
      name: editor.name.trim(), srcDir: editor.srcDir.trim(), destRoot: editor.destRoot.trim(),
      excludes: editor.excludes.split(/[,\n]/).map((pattern) => pattern.trim()).filter(Boolean),
    };
    if (!fields.name || !fields.srcDir || !fields.destRoot) {
      setEditorError(tr("sync_required", undefined, "Enter a name, PC folder, and PS5 destination folder."));
      return;
    }
    if (!isLocalSyncPath(fields.srcDir)) {
      setEditorError(tr("sync_local_only", undefined, "Choose a folder on this device. Saved-server and PS5 paths can't be used as the PC source."));
      return;
    }
    if (!fields.destRoot.startsWith("/")) {
      setEditorError(tr("sync_dest_absolute", undefined, "Enter an absolute PS5 path, such as /data/homebrew/MyGame."));
      return;
    }
    const store = useSyncPairsStore.getState();
    if (editor.id) {
      if (store.runs[syncPairRunKey(host, editor.id)]) return;
      store.updatePair(host, editor.id, fields);
      setPreviews((current) => {
        const next = { ...current };
        delete next[editor.id!];
        return next;
      });
    } else {
      store.addPair(host, fields);
    }
    setEditor(null);
  }

  async function previewPair(pair: SyncPair, sync: boolean) {
    if (!ready || busyRef.current || consoleRunning) return;
    if (sync && useUploadQueueStore.getState().runningHosts[pair.host]) return;
    const probe = guard.capture();
    if (hostOf(probe.host.trim()) !== pair.host) return;
    busyRef.current = pair.id;
    setBusyPair(pair.id);
    setNotice(null);
    setError(null);
    try {
      const preview = await syncPreview(pair.srcDir, pair.destRoot, transferAddr(pair.host), pair.excludes, fullVerify);
      if (!mountedRef.current || probe.isStale()) return;
      if (preview.busy) {
        setPreviews((current) => {
          const next = { ...current };
          delete next[pair.id];
          return next;
        });
        setNotice(tr("sync_busy", undefined, "This folder is already being planned or synced. Wait for it to finish, then try again."));
        return;
      }
      setPreviews((current) => ({ ...current, [pair.id]: preview }));
      if (!sync || preview.blocked?.length) return;
      let approvedDeletes: string[] = [];
      if (preview.to_delete.length > 0) {
        const paths = preview.to_delete.slice(0, 20).map((entry) =>
          `${entry.path}${entry.kind === "dir" ? "/" : ""}${entry.blocks_upload ? ` ${tr("sync_conflict_marker", undefined, "(replaced by a file/folder from your PC)")}` : ""}`);
        if (preview.to_delete.length > 20) paths.push(tr("sync_and_more", { count: preview.to_delete.length - 20 }, "and {count} more"));
        const message = [
          tr("sync_confirm_body", { name: pair.name, files: preview.delete_files, bytes: formatBytes(preview.delete_bytes) }, 'Sync "{name}" will remove {files} files ({bytes}) from the PS5. This cannot be undone. The PC folder is never changed.'),
          preview.to_delete.some((entry) => entry.blocks_upload)
            ? tr("sync_confirm_conflicts", undefined, "Marked file/folder replacements must be deleted before uploading their PC counterparts. Other deletions happen after uploading succeeds.") : "",
          paths.join("\n"),
        ].filter(Boolean).join("\n\n");
        const approved = await confirm({
          title: tr("sync_confirm_title", { count: preview.to_delete.length }, "Delete {count} PS5 entries and sync?"),
          message,
          confirmLabel: tr("sync_confirm_action", undefined, "Approve deletions & sync"),
          destructive: true,
        });
        if (!approved || !mountedRef.current || probe.isStale()) return;
        approvedDeletes = preview.to_delete.map((entry) => entry.path);
      }
      // A queue can start while the user reads the deletion confirmation.
      if (useUploadQueueStore.getState().runningHosts[pair.host]) {
        setNotice(tr("sync_queue_busy", undefined, "The upload queue is running for this PS5. Wait for it to finish before syncing."));
        return;
      }
      setPreviews((current) => {
        const next = { ...current };
        delete next[pair.id];
        return next;
      });
      void useSyncPairsStore.getState().startRun(
        pair.host, pair.id, approvedDeletes, fullVerify,
        useUploadSettingsStore.getState().bandwidthCapMbps,
        effectiveUploadStreams(transferAddr(pair.host)),
      );
    } catch (err) {
      if (mountedRef.current && !probe.isStale()) setError(humanizeSyncError(tr, err instanceof Error ? err.message : String(err)));
    } finally {
      busyRef.current = null;
      if (mountedRef.current && !probe.isStale()) setBusyPair(null);
    }
  }

  async function removePair(pair: SyncPair) {
    if (busyRef.current || runs[syncPairRunKey(pair.host, pair.id)]) return;
    const probe = guard.capture();
    busyRef.current = pair.id;
    setBusyPair(pair.id);
    try {
      const approved = await confirm({
        title: tr("sync_remove_title", { name: pair.name }, 'Remove sync pair "{name}"?'),
        message: tr("sync_remove_body", undefined, "Only the saved pair is removed. Neither the PC nor PS5 folder is changed."),
        confirmLabel: tr("sync_remove", undefined, "Remove"),
        destructive: true,
      });
      if (approved && mountedRef.current && !probe.isStale()) useSyncPairsStore.getState().removePair(pair.host, pair.id);
    } finally {
      busyRef.current = null;
      if (mountedRef.current && !probe.isStale()) setBusyPair(null);
    }
  }

  return (
    <div className="app-page">
      <div className="mx-auto max-w-5xl space-y-4">
        <PageHeader
          icon={RefreshCw}
          title={tr("sync_title", undefined, "Folder Sync")}
          count={pairs.length}
          description={tr("sync_explainer", undefined, "One-way PC → PS5. Upload new or changed files; PS5-only files are deleted only after you confirm. Use excludes to protect PS5-only files such as fakelib or saves.")}
          right={<Button variant="primary" leftIcon={<Plus size={14} />} disabled={!host || busyPair !== null} onClick={() => openEditor()}>{tr("sync_add", undefined, "Add pair")}</Button>}
        />
        <ConnectionGate require="host">
          <Card>
            <Checkbox
              checked={fullVerify}
              disabled={busyPair !== null || consoleRunning}
              onChange={(checked) => { setFullVerify(checked); setPreviews({}); }}
              label={tr("sync_full_verify", undefined, "Full verify")}
              hint={tr("sync_full_verify_hint", undefined, "Compare same-size files with BLAKE3 instead of trusting the last sync's PC file metadata. This can take longer.")}
            />
          </Card>
          {!ready && (
            <WarningCard title={tr("sync_helper_needed", undefined, "The PS5 helper must be running to preview or sync. You can still manage saved pairs.")} />
          )}
          {queueRunning && <WarningCard title={tr("sync_queue_busy", undefined, "The upload queue is running for this PS5. Wait for it to finish before syncing.")} />}
          {notice && <WarningCard title={notice} onDismiss={() => setNotice(null)} />}
          {error && <ErrorCard title={tr("sync_preview_failed", undefined, "Couldn't preview this folder")} detail={error} onDismiss={() => setError(null)} />}
          {pairs.length === 0 ? (
            <EmptyState icon={RefreshCw} title={tr("sync_empty_title", undefined, "No sync pairs for this PS5")} message={tr("sync_empty_body", undefined, "Save a PC folder and its matching PS5 folder, then sync after your launcher updates the PC copy.")} />
          ) : pairs.map((pair) => {
            const run = runs[syncPairRunKey(pair.host, pair.id)];
            const working = busyPair === pair.id;
            const actionsDisabled = busyPair !== null || consoleRunning || !ready;
            const blocked = !!previews[pair.id]?.blocked?.length;
            return (
              <Card key={pair.id} className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-all text-base font-semibold">{pair.name}</h2>
                    {pair.lastSyncAtMs !== undefined && <p className="mt-1 text-xs text-[var(--color-muted)]">{tr("sync_last_run", { time: new Date(pair.lastSyncAtMs).toLocaleString() }, "Last sync attempt: {time}")}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button leftIcon={<Eye size={14} />} disabled={actionsDisabled} loading={working} onClick={() => void previewPair(pair, false)}>{tr("sync_preview", undefined, "Preview")}</Button>
                    <span title={queueRunning
                      ? tr("sync_queue_busy", undefined, "The upload queue is running for this PS5. Wait for it to finish before syncing.")
                      : blocked ? tr("sync_blocked_hint", undefined, "Remove or rename these on the PS5, or adjust excludes, then Preview again.") : undefined}>
                      <Button variant="primary" leftIcon={<RefreshCw size={14} />} disabled={actionsDisabled || queueRunning || blocked} onClick={() => void previewPair(pair, true)}>{tr("sync_now", undefined, "Sync now")}</Button>
                    </span>
                    <Button variant="ghost" leftIcon={<Pencil size={14} />} disabled={busyPair !== null || !!run} onClick={() => openEditor(pair)}>{tr("sync_edit", undefined, "Edit")}</Button>
                    <Button variant="ghost" leftIcon={<Trash2 size={14} />} disabled={busyPair !== null || !!run} onClick={() => void removePair(pair)}>{tr("sync_remove", undefined, "Remove")}</Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 text-xs text-[var(--color-muted)] sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1"><p>{tr("sync_source", undefined, "PC folder")}</p><p className="mt-1 break-all font-mono text-[var(--color-text)]">{pair.srcDir}</p></div>
                  <ArrowRight size={16} className="shrink-0 max-sm:rotate-90" aria-hidden />
                  <div className="min-w-0 flex-1"><p>{tr("sync_destination", undefined, "PS5 destination")}</p><p className="mt-1 break-all font-mono text-[var(--color-text)]">{pair.destRoot}</p></div>
                </div>
                {pair.excludes.length > 0 && <p className="break-all text-xs text-[var(--color-muted)]">{tr("sync_excludes_summary", { patterns: pair.excludes.join(", ") }, "Excludes: {patterns}")}</p>}
                {run ? <SyncProgress run={run} onCancel={() => void useSyncPairsStore.getState().cancelRun(pair.host, pair.id)} /> : pair.lastResult && <SyncResult result={pair.lastResult} />}
                {previews[pair.id] && <PreviewDetails preview={previews[pair.id]} />}
              </Card>
            );
          })}
        </ConnectionGate>
      </div>
      {editor && !picking && (
        <Modal open size="lg" title={editor.id ? tr("sync_edit_pair", undefined, "Edit sync pair") : tr("sync_add_pair", undefined, "Add sync pair")} onClose={() => setEditor(null)} footer={<><Button variant="ghost" onClick={() => setEditor(null)}>{tr("cancel", undefined, "Cancel")}</Button><Button variant="primary" onClick={savePair}>{tr("sync_save_pair", undefined, "Save pair")}</Button></>}>
          <div className="space-y-4 p-4">
            {editorError && <ErrorCard title={editorError} />}
            <Input label={tr("sync_pair_name", undefined, "Pair name")} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} autoFocus />
            <div className="space-y-2">
              <Input label={tr("sync_source", undefined, "PC folder")} value={editor.srcDir} onChange={(event) => setEditor({ ...editor, srcDir: event.target.value })} hint={tr("sync_local_hint", undefined, "A local folder on the device running the engine, not a saved-server path.")} />
              <Button leftIcon={<FolderOpen size={14} />} onClick={() => void browseFolder("srcDir")}>{tr("sync_browse_local", undefined, "Browse this device")}</Button>
            </div>
            <div className="space-y-2">
              <Input label={tr("sync_destination", undefined, "PS5 destination")} value={editor.destRoot} onChange={(event) => setEditor({ ...editor, destRoot: event.target.value })} hint={tr("sync_destination_hint", undefined, "Use a specific folder such as /data/homebrew/MyGame, not an entire storage root.")} />
              <Button leftIcon={<FolderOpen size={14} />} disabled={!ready} onClick={() => void browseFolder("destRoot")}>{tr("sync_browse_ps5", undefined, "Browse PS5")}</Button>
            </div>
            <Textarea label={tr("sync_excludes", undefined, "Excludes")} rows={4} value={editor.excludes} onChange={(event) => setEditor({ ...editor, excludes: event.target.value })} hint={tr("sync_excludes_hint", undefined, "Separate patterns with commas or new lines. Excluded paths are neither uploaded nor deleted; for example: fakelib, saves.")} />
          </div>
        </Modal>
      )}
      <div className="[&_[role=alertdialog]]:max-h-[90dvh] [&_[role=alertdialog]]:overflow-y-auto [&_[role=alertdialog]_p]:whitespace-pre-line [&_[role=alertdialog]_p]:break-words">{dialog}</div>
    </div>
  );
}
