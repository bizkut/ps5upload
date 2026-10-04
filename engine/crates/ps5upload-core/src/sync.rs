//! One-way folder sync planning. Paths in inventories are relative, '/'-separated.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::fs_ops::{
    acquire_reconcile_gate, blake3_file, fs_delete_with_timeout, fs_hash_with_timeout,
    list_dir_with_timeout, ListDirOptions, ReconcileFile, ReconcileGate,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncFileState {
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub struct LocalSyncInventory {
    pub files: BTreeMap<String, SyncFileState>,
    pub dirs: BTreeSet<String>,
    pub non_regular: BTreeSet<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteSyncTree {
    pub files: BTreeMap<String, u64>,
    pub dirs: BTreeSet<String>,
    pub others: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncManifest {
    pub version: u32,
    pub src_dir: String,
    pub dest_root: String,
    pub host: String,
    pub files: BTreeMap<String, SyncFileState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncDelete {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub files: u64,
    /// Structural conflicts must be approved and removed before uploading.
    #[serde(default, skip_serializing_if = "is_false")]
    pub blocks_upload: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SyncPlan {
    pub to_send: Vec<ReconcileFile>,
    pub bytes_to_send: u64,
    pub to_verify: Vec<ReconcileFile>,
    pub bytes_to_verify: u64,
    pub unchanged_count: u64,
    pub unchanged_bytes: u64,
    pub to_delete: Vec<SyncDelete>,
    pub kept_count: u64,
    pub blocked: Vec<String>,
}

/// Reserve the same console/source resources as ordinary reconciliation.
/// Keeping this reservation through a run also prevents two syncs from applying
/// deletion plans computed against each other's partially updated trees.
pub struct SyncGate {
    _gate: ReconcileGate,
}

pub fn acquire_sync_gate(mgmt_addr: &str, src: &Path, block: bool) -> Result<SyncGate> {
    Ok(SyncGate {
        _gate: acquire_reconcile_gate(
            vec![
                format!("addr:{mgmt_addr}"),
                format!("src:{}", src.to_string_lossy()),
            ],
            block,
        )?,
    })
}

/// Inventory without following symlinks or silently dropping unreadable entries:
/// a skipped source entry could otherwise become an approved remote deletion.
pub fn walk_local_sync(root: &Path, excludes: &[String]) -> Result<LocalSyncInventory> {
    let mut out = LocalSyncInventory::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in
            std::fs::read_dir(&dir).with_context(|| format!("read_dir {}", dir.display()))?
        {
            let entry = entry.with_context(|| format!("read_dir entry in {}", dir.display()))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(root)?
                .to_str()
                .context("sync source contains a non-UTF-8 path")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if crate::excludes::is_excluded_strings(Path::new(&rel), excludes) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(&path)
                .with_context(|| format!("metadata {}", path.display()))?;
            if metadata.is_dir() {
                out.dirs.insert(rel);
                stack.push(path);
            } else if metadata.is_file() {
                let modified = metadata
                    .modified()
                    .with_context(|| format!("mtime {}", path.display()))?;
                let mtime_ms = match modified.duration_since(std::time::UNIX_EPOCH) {
                    Ok(d) => i64::try_from(d.as_millis()).context("sync mtime exceeds i64")?,
                    Err(e) => -i64::try_from(e.duration().as_millis())
                        .context("sync mtime exceeds i64")?,
                };
                out.files.insert(
                    rel,
                    SyncFileState {
                        size: metadata.len(),
                        mtime_ms,
                    },
                );
            } else {
                out.non_regular.insert(rel);
            }
        }
    }
    Ok(out)
}

/// Complete remote inventory. Only an ENOENT on the initial root call is empty;
/// a missing child, timeout, or depth overflow invalidates the entire plan.
pub fn walk_remote_sync(mgmt_addr: &str, dest_root: &str) -> Result<RemoteSyncTree> {
    let mut out = RemoteSyncTree::default();
    let mut stack = vec![(String::new(), 0usize)];
    while let Some((parent, depth)) = stack.pop() {
        let abs = remote_path(dest_root, &parent);
        let mut offset = 0;
        loop {
            let listing = match list_dir_with_timeout(
                mgmt_addr,
                &abs,
                ListDirOptions { offset, limit: 256 },
                Some(Duration::from_secs(10)),
            ) {
                Ok(listing) => listing,
                // Match the payload's error body, not errno-looking text in a
                // destination filename included in the error's context.
                Err(e)
                    if parent.is_empty()
                        && offset == 0
                        && e.to_string().ends_with(": fs_list_dir_opendir_errno_2") =>
                {
                    return Ok(RemoteSyncTree::default());
                }
                Err(e) => return Err(e).with_context(|| format!("sync list_dir {abs}")),
            };
            let returned = listing.entries.len();
            for entry in listing.entries {
                if entry.name.is_empty()
                    || entry.name == "."
                    || entry.name == ".."
                    || entry.name.contains('/')
                {
                    bail!("sync invalid remote directory entry in {abs}");
                }
                let rel = if parent.is_empty() {
                    entry.name
                } else {
                    format!("{parent}/{}", entry.name)
                };
                match entry.kind.as_str() {
                    "file" => {
                        out.files.insert(rel, entry.size);
                    }
                    "dir" => {
                        if depth >= 64 {
                            bail!("sync remote depth exceeds 64 at {rel}");
                        }
                        out.dirs.insert(rel.clone());
                        stack.push((rel, depth + 1));
                    }
                    _ => {
                        out.others.insert(rel);
                    }
                }
            }
            offset += returned as u64;
            if returned == 0 {
                if listing.truncated {
                    bail!("sync truncated remote listing made no progress at {abs}");
                }
                break;
            }
            // A full page needs another call even on older payloads that do not
            // set truncated when the entry-count limit (rather than bytes) fills.
            if returned < 256 && !listing.truncated {
                break;
            }
        }
    }
    Ok(out)
}

fn is_false(value: &bool) -> bool {
    !value
}

fn remote_path(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_string()
    } else {
        format!("{}/{rel}", root.trim_end_matches('/'))
    }
}

fn ancestors(rel: &str) -> impl Iterator<Item = &str> {
    rel.match_indices('/').map(move |(i, _)| &rel[..i])
}

fn covered_by(rel: &str, roots: &BTreeSet<&str>) -> bool {
    roots.contains(rel) || ancestors(rel).any(|parent| roots.contains(parent))
}

/// Pure delta/deletion plan; directory totals and protected ancestors are built
/// once, avoiding a full subtree scan for each directory in large game dumps.
pub fn plan_sync(
    local: &LocalSyncInventory,
    remote: &RemoteSyncTree,
    manifest: Option<&SyncManifest>,
    excludes: &[String],
    verify: bool,
) -> SyncPlan {
    let mut plan = SyncPlan::default();
    // A protected directory protects its entire subtree, including wildcard
    // directory exclusions and directories replaced by a local symlink.
    let protected_roots: BTreeSet<&str> = remote
        .dirs
        .iter()
        .filter(|rel| {
            local.non_regular.contains(*rel)
                || crate::excludes::is_excluded_strings(Path::new(rel), excludes)
        })
        .map(String::as_str)
        .collect();
    let kept: BTreeSet<&str> = remote
        .files
        .keys()
        .chain(&remote.dirs)
        .chain(&remote.others)
        .filter(|rel| {
            remote.others.contains(*rel)
                || local.non_regular.contains(*rel)
                || covered_by(rel, &protected_roots)
                || crate::excludes::is_excluded_strings(Path::new(rel), excludes)
        })
        .map(String::as_str)
        .collect();
    plan.kept_count = kept.len() as u64;
    let protected_ancestors: BTreeSet<&str> = kept.iter().flat_map(|rel| ancestors(rel)).collect();
    for (rel, state) in &local.files {
        let protected_conflict = remote.others.contains(rel)
            || (remote.dirs.contains(rel)
                && (kept.contains(rel.as_str()) || protected_ancestors.contains(rel.as_str())))
            || ancestors(rel).any(|parent| {
                remote.others.contains(parent)
                    || (remote.files.contains_key(parent) && kept.contains(parent))
            });
        if protected_conflict {
            plan.blocked.push(rel.clone());
            continue;
        }
        if crate::excludes::is_excluded_strings(Path::new(rel), excludes) {
            continue;
        }
        let needs_send = match remote.files.get(rel) {
            None => true,
            Some(&size) if size != state.size => true,
            Some(_) => match manifest.filter(|_| !verify).and_then(|m| m.files.get(rel)) {
                Some(previous) if previous == state => {
                    plan.unchanged_count += 1;
                    plan.unchanged_bytes += state.size;
                    continue;
                }
                Some(_) => true,
                None => false,
            },
        };
        // Unchanged manifest entries need no owned path in the returned plan.
        let file = ReconcileFile {
            rel_path: rel.clone(),
            size: state.size,
        };
        if needs_send {
            plan.bytes_to_send += state.size;
            plan.to_send.push(file);
        } else {
            plan.bytes_to_verify += state.size;
            plan.to_verify.push(file);
        }
    }

    let mut dir_totals: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    for (rel, &size) in &remote.files {
        for parent in ancestors(rel) {
            let totals = dir_totals.entry(parent).or_default();
            totals.0 += size;
            totals.1 += 1;
        }
    }
    let mut collapsed = BTreeSet::new();
    for rel in &remote.dirs {
        if !local.dirs.contains(rel)
            && !kept.contains(rel.as_str())
            && !protected_ancestors.contains(rel.as_str())
            && !covered_by(rel, &collapsed)
        {
            let (bytes, files) = dir_totals.get(rel.as_str()).copied().unwrap_or_default();
            plan.to_delete.push(SyncDelete {
                path: rel.clone(),
                kind: "dir".into(),
                bytes,
                files,
                blocks_upload: local.files.contains_key(rel),
            });
            collapsed.insert(rel.as_str());
        }
    }
    for (rel, &size) in &remote.files {
        if !local.files.contains_key(rel)
            && !kept.contains(rel.as_str())
            && !covered_by(rel, &collapsed)
        {
            plan.to_delete.push(SyncDelete {
                path: rel.clone(),
                kind: "file".into(),
                bytes: size,
                files: 1,
                blocks_upload: local.dirs.contains(rel),
            });
        }
    }
    plan.to_delete.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    plan
}

/// Resolve first-sync/full-verify candidates. Either-side hash failures mean
/// resend, never a claim that an unreadable file is already correct.
pub fn resolve_verifications(
    mgmt_addr: &str,
    src_dir: &Path,
    dest_root: &str,
    plan: &mut SyncPlan,
    mut progress: impl FnMut(u64, u64),
) -> u64 {
    let candidates = std::mem::take(&mut plan.to_verify);
    let total = candidates.len() as u64;
    progress(0, total);
    for (index, file) in candidates.into_iter().enumerate() {
        let path = src_dir.join(file.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let equal = blake3_file(&path).and_then(|local_hash| {
            fs_hash_with_timeout(
                mgmt_addr,
                &remote_path(dest_root, &file.rel_path),
                Some(Duration::from_secs(10)),
            )
            .map(|remote| remote.hash == local_hash && remote.size == file.size)
        });
        match equal {
            Ok(true) => {
                plan.unchanged_count += 1;
                plan.unchanged_bytes += file.size;
            }
            result => {
                if let Err(e) = result {
                    crate::core_log!("sync: hash failed for {} ({e}); resending", file.rel_path);
                }
                plan.bytes_to_send += file.size;
                plan.to_send.push(file);
            }
        }
        progress(index as u64 + 1, total);
    }
    plan.bytes_to_verify = 0;
    plan.to_send
        .sort_unstable_by(|a, b| a.rel_path.cmp(&b.rel_path));
    total
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncDeleteFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Default)]
pub struct SyncDeleteOutcome {
    pub deleted: Vec<SyncDelete>,
    pub skipped: Vec<String>,
    pub failed: Vec<SyncDeleteFailure>,
}

/// Apply only exact approvals from the freshly planned, collapsed delete list.
pub fn apply_deletes(
    mgmt_addr: &str,
    dest_root: &str,
    plan_deletes: &[SyncDelete],
    approved: &[String],
    cancel: &AtomicBool,
) -> SyncDeleteOutcome {
    apply_deletes_with_progress(
        mgmt_addr,
        dest_root,
        plan_deletes,
        approved,
        cancel,
        |_, _| {},
    )
}

pub fn apply_deletes_with_progress(
    mgmt_addr: &str,
    dest_root: &str,
    plan_deletes: &[SyncDelete],
    approved: &[String],
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> SyncDeleteOutcome {
    let approved: BTreeSet<&str> = approved.iter().map(String::as_str).collect();
    let mut outcome = SyncDeleteOutcome::default();
    let total = plan_deletes.len() as u64;
    progress(0, total);
    for (index, entry) in plan_deletes.iter().enumerate() {
        if !approved.contains(entry.path.as_str()) || cancel.load(Ordering::Acquire) {
            outcome.skipped.push(entry.path.clone());
        } else {
            match fs_delete_with_timeout(
                mgmt_addr,
                &remote_path(dest_root, &entry.path),
                Some(Duration::from_secs(3600)),
            ) {
                Ok(()) => outcome.deleted.push(entry.clone()),
                Err(e) => outcome.failed.push(SyncDeleteFailure {
                    path: entry.path.clone(),
                    error: format!("{e:#}"),
                }),
            }
        }
        progress(index as u64 + 1, total);
    }
    outcome
}

/// Refuse a writable root even with trailing/repeated slashes or dot components.
pub fn sync_dest_too_broad(dest_root: &str) -> bool {
    let mut components = dest_root.split('/').filter(|c| !c.is_empty() && *c != ".");
    match (components.next(), components.next(), components.next()) {
        (None, None, None) => true,
        (Some("data" | "user"), None, None) => true,
        (Some("mnt"), Some(volume), None) => ["ext", "usb"].iter().any(|prefix| {
            volume.strip_prefix(prefix).is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_digit())
            })
        }),
        _ => false,
    }
}

pub fn sync_source_empty(local: &LocalSyncInventory) -> bool {
    local.files.is_empty()
}

/// Invalid manifests trigger a fresh BLAKE3 comparison, not an upload-all fallback.
pub fn load_manifest(path: &Path) -> Option<SyncManifest> {
    let loaded = std::fs::read(path)
        .with_context(|| format!("read sync manifest {}", path.display()))
        .and_then(|bytes| serde_json::from_slice::<SyncManifest>(&bytes).map_err(Into::into))
        .and_then(|manifest| {
            if manifest.version != 1 {
                bail!("unsupported sync manifest version {}", manifest.version);
            }
            Ok(manifest)
        });
    match loaded {
        Ok(manifest) => Some(manifest),
        Err(e) => {
            crate::core_log!("sync: no usable manifest at {} ({e:#})", path.display());
            None
        }
    }
}

/// Write beside the destination and rename atomically, preserving the last
/// successful inventory if serialization, writing, or replacement fails.
pub fn save_manifest(path: &Path, manifest: &SyncManifest) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension("json.tmp");
    let result = (|| {
        std::fs::write(&tmp, serde_json::to_vec(manifest)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(files: &[(&str, u64, i64)]) -> LocalSyncInventory {
        LocalSyncInventory {
            files: files
                .iter()
                .map(|&(rel, size, mtime_ms)| (rel.to_string(), SyncFileState { size, mtime_ms }))
                .collect(),
            ..Default::default()
        }
    }

    fn remote(files: &[(&str, u64)], dirs: &[&str], others: &[&str]) -> RemoteSyncTree {
        RemoteSyncTree {
            files: files.iter().map(|&(p, s)| (p.to_string(), s)).collect(),
            dirs: dirs.iter().map(|p| p.to_string()).collect(),
            others: others.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn manifest(local: &LocalSyncInventory) -> SyncManifest {
        SyncManifest {
            version: 1,
            src_dir: "/pc/game".into(),
            dest_root: "/data/homebrew/Game".into(),
            host: "192.0.2.1".into(),
            files: local.files.clone(),
        }
    }

    fn sent(plan: &SyncPlan) -> Vec<&str> {
        plan.to_send.iter().map(|f| f.rel_path.as_str()).collect()
    }

    fn deleted(plan: &SyncPlan) -> Vec<&str> {
        plan.to_delete.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn new_file_is_sent() {
        let plan = plan_sync(
            &local(&[("new.pak", 10, 1)]),
            &RemoteSyncTree::default(),
            None,
            &[],
            false,
        );
        assert_eq!(sent(&plan), ["new.pak"]);
        assert_eq!(plan.bytes_to_send, 10);
    }

    #[test]
    fn size_change_is_sent() {
        let local = local(&[("game.pak", 20, 1)]);
        let plan = plan_sync(
            &local,
            &remote(&[("game.pak", 10)], &[], &[]),
            Some(&manifest(&local)),
            &[],
            false,
        );
        assert_eq!(sent(&plan), ["game.pak"]);
    }

    #[test]
    fn same_size_changed_mtime_is_sent_with_manifest() {
        let old = manifest(&local(&[("game.pak", 10, 1)]));
        let plan = plan_sync(
            &local(&[("game.pak", 10, 2)]),
            &remote(&[("game.pak", 10)], &[], &[]),
            Some(&old),
            &[],
            false,
        );
        assert_eq!(sent(&plan), ["game.pak"]);
    }

    #[test]
    fn unchanged_manifest_file_is_skipped() {
        let local = local(&[("game.pak", 10, 1)]);
        let plan = plan_sync(
            &local,
            &remote(&[("game.pak", 10)], &[], &[]),
            Some(&manifest(&local)),
            &[],
            false,
        );
        assert!(plan.to_send.is_empty());
        assert!(plan.to_verify.is_empty());
        assert_eq!((plan.unchanged_count, plan.unchanged_bytes), (1, 10));
    }

    #[test]
    fn same_size_without_manifest_requires_verification() {
        let plan = plan_sync(
            &local(&[("game.pak", 10, 1)]),
            &remote(&[("game.pak", 10)], &[], &[]),
            None,
            &[],
            false,
        );
        assert_eq!(
            plan.to_verify
                .iter()
                .map(|f| f.rel_path.as_str())
                .collect::<Vec<_>>(),
            ["game.pak"]
        );
        assert_eq!(plan.bytes_to_verify, 10);
    }

    #[test]
    fn full_verify_ignores_manifest() {
        let local = local(&[("game.pak", 10, 1)]);
        let plan = plan_sync(
            &local,
            &remote(&[("game.pak", 10)], &[], &[]),
            Some(&manifest(&local)),
            &[],
            true,
        );
        assert_eq!(plan.to_verify.len(), 1);
        assert_eq!(plan.unchanged_count, 0);
    }

    #[test]
    fn remote_only_file_is_deleted() {
        let plan = plan_sync(
            &LocalSyncInventory::default(),
            &remote(&[("old.pak", 9)], &[], &[]),
            None,
            &[],
            false,
        );
        assert_eq!(deleted(&plan), ["old.pak"]);
        assert_eq!(
            plan.to_delete[0],
            SyncDelete {
                path: "old.pak".into(),
                kind: "file".into(),
                bytes: 9,
                files: 1,
                blocks_upload: false
            }
        );
    }

    #[test]
    fn remote_only_directory_collapses_recursive_totals() {
        let plan = plan_sync(
            &LocalSyncInventory::default(),
            &remote(&[("old/a", 9), ("old/sub/b", 11)], &["old", "old/sub"], &[]),
            None,
            &[],
            false,
        );
        assert_eq!(deleted(&plan), ["old"]);
        assert_eq!(
            plan.to_delete[0],
            SyncDelete {
                path: "old".into(),
                kind: "dir".into(),
                bytes: 20,
                files: 2,
                blocks_upload: false
            }
        );
    }

    #[test]
    fn excluded_descendant_prevents_directory_collapse() {
        let plan = plan_sync(
            &LocalSyncInventory::default(),
            &remote(
                &[
                    ("old/keep.esbak", 9),
                    ("old/remove.pak", 11),
                    ("old/sub/a", 12),
                ],
                &["old", "old/sub"],
                &[],
            ),
            None,
            &["*.esbak".into()],
            false,
        );
        assert_eq!(deleted(&plan), ["old/remove.pak", "old/sub"]);
        assert_eq!(plan.kept_count, 1);
    }

    #[test]
    fn excluded_remote_file_is_kept() {
        let plan = plan_sync(
            &LocalSyncInventory::default(),
            &remote(&[("keep.esbak", 9)], &[], &[]),
            None,
            &["*.esbak".into()],
            false,
        );
        assert!(plan.to_delete.is_empty());
        assert_eq!(plan.kept_count, 1);
    }

    #[test]
    fn remote_link_is_kept_and_ancestor_not_collapsed() {
        let plan = plan_sync(
            &LocalSyncInventory::default(),
            &remote(&[("old/remove", 9)], &["old"], &["old/link"]),
            None,
            &[],
            false,
        );
        assert_eq!(deleted(&plan), ["old/remove"]);
        assert_eq!(plan.kept_count, 1);
    }

    #[test]
    fn kind_conflicts_are_deleted_and_local_files_sent() {
        let mut local = local(&[("file", 10, 1)]);
        local.dirs.insert("dir".into());
        let plan = plan_sync(
            &local,
            &remote(&[("dir", 3), ("file/child", 4)], &["file"], &[]),
            None,
            &[],
            false,
        );
        assert_eq!(sent(&plan), ["file"]);
        assert_eq!(deleted(&plan), ["dir", "file"]);
        assert_eq!(plan.to_delete[1].kind, "dir");
        assert!(plan.to_delete.iter().all(|entry| entry.blocks_upload));
    }

    #[test]
    fn local_non_regular_entry_protects_remote_tree() {
        let mut local = LocalSyncInventory::default();
        local.non_regular.insert("link".into());
        let plan = plan_sync(
            &local,
            &remote(&[("link/child", 3)], &["link"], &[]),
            None,
            &[],
            false,
        );
        assert!(plan.to_delete.is_empty());
        assert_eq!(plan.kept_count, 2);
    }

    #[test]
    fn kept_remote_link_blocks_local_file() {
        let plan = plan_sync(
            &local(&[("file", 10, 1)]),
            &remote(&[], &[], &["file"]),
            None,
            &[],
            false,
        );
        assert_eq!(plan.blocked, ["file"]);
        assert!(plan.to_send.is_empty());
        assert!(plan.to_verify.is_empty());
        assert!(plan.to_delete.is_empty());
    }

    #[test]
    fn kept_descendant_blocks_directory_to_file_conflict() {
        for remote in [
            remote(
                &[("file/keep.esbak", 3), ("file/remove.bin", 4)],
                &["file"],
                &[],
            ),
            remote(&[("file/remove.bin", 4)], &["file"], &["file/link"]),
        ] {
            let plan = plan_sync(
                &local(&[("file", 10, 1)]),
                &remote,
                None,
                &["*.esbak".into()],
                false,
            );
            assert_eq!(plan.blocked, ["file"]);
            assert!(plan.to_send.is_empty());
            assert!(!plan.to_delete.iter().any(|entry| entry.path == "file"));
        }
    }

    #[test]
    fn kept_non_directory_ancestors_block_local_descendants() {
        let local = local(&[("link/child.bin", 10, 1), ("kept.esbak/child.bin", 5, 1)]);
        let plan = plan_sync(
            &local,
            &remote(&[("kept.esbak", 3)], &[], &["link"]),
            None,
            &["*.esbak".into()],
            false,
        );
        assert_eq!(plan.blocked, ["kept.esbak/child.bin", "link/child.bin"]);
        assert!(plan.to_send.is_empty());
    }

    #[test]
    fn excluded_remote_directory_blocks_local_file() {
        let plan = plan_sync(
            &local(&[("file.esbak", 10, 1)]),
            &remote(&[], &["file.esbak"], &[]),
            None,
            &["*.esbak".into()],
            false,
        );
        assert_eq!(plan.blocked, ["file.esbak"]);
        assert!(plan.to_send.is_empty());
        assert!(plan.to_delete.is_empty());
    }

    #[test]
    fn destination_guard_rejects_writable_roots() {
        assert!(!sync_dest_too_broad("/data/homebrew/Game"));
        for root in ["/", "/data", "/data/", "/user", "/mnt/usb0", "/mnt/ext1"] {
            assert!(sync_dest_too_broad(root), "accepted {root}");
        }
        assert!(!sync_dest_too_broad("/mnt/usb0/Game"));
    }

    #[test]
    fn empty_source_guard_counts_regular_files_only() {
        let mut empty = LocalSyncInventory::default();
        empty.dirs.insert("dir".into());
        empty.non_regular.insert("link".into());
        assert!(sync_source_empty(&empty));
        assert!(!sync_source_empty(&local(&[("empty_file", 0, 1)])));
    }

    #[test]
    fn manifest_roundtrip_corrupt_and_version_mismatch() {
        let dir = std::env::temp_dir().join(format!(
            "ps5upload-sync-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nested/manifest.json");
        let mut manifest = manifest(&local(&[("sub/game.pak", 10, -2)]));
        assert_eq!(load_manifest(&path), None);
        save_manifest(&path, &manifest).unwrap();
        assert_eq!(load_manifest(&path), Some(manifest.clone()));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load_manifest(&path), None);
        manifest.version = 2;
        save_manifest(&path, &manifest).unwrap();
        assert_eq!(load_manifest(&path), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
