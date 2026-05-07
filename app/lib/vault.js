// lib/vault.js — VaultRoot lifecycle + index cache + trash quarantine.
//
// The vault is a single directory the user picks (via the wizard, no default —
// Session 4 design question #7). Everything vault-related is scoped to that
// path. No globals; every function takes vaultRoot explicitly so tests can
// spin up a tmp vault per case.
//
// On-disk layout (ground truth):
//
//   <VaultRoot>/
//   ├── vault.json           # marker + schema version (cheap "is this a vault?")
//   ├── index.json           # denormalized cache, rebuildable from assets/
//   ├── assets/<uuid>/...    # one dir per asset (see lib/asset.js)
//   ├── .trash/<uuid>-<ts>/  # soft-deleted assets (7d retention default)
//   └── .locks/              # transient per-asset write locks (reserved)
//
// Design anchors:
//   * index.json is a PROJECTION — losing it never loses data
//   * `.trash/` is the soft-delete target (design question #3 = soft delete)
//   * no absolute paths in any vault file — portability contract
//
// Grep anchor: VAULT_LAYOUT — if you change the directory structure, update
// this header and main.js's wizard/reveal handlers together.

const fs   = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./job');
const { readAsset, validateAsset, findAbsolutePathFields, ASSET_FILES } = require('./asset');

const VAULT_SCHEMA_VERSION = 1;
const TRASH_RETENTION_DAYS = 7;

// Subpath constants. Centralized so callers never hardcode the layout.
const VAULT_DIRS = Object.freeze({
    assets: 'assets',
    trash:  '.trash',
    locks:  '.locks',
});
const VAULT_FILES = Object.freeze({
    marker: 'vault.json',
    index:  'index.json',
});

// ---- path helpers ----------------------------------------------------------

function vaultMarkerPath(vaultRoot) { return path.join(vaultRoot, VAULT_FILES.marker); }
function vaultIndexPath(vaultRoot)  { return path.join(vaultRoot, VAULT_FILES.index);  }
function assetsDirOf(vaultRoot)     { return path.join(vaultRoot, VAULT_DIRS.assets);  }
function trashDirOf(vaultRoot)      { return path.join(vaultRoot, VAULT_DIRS.trash);   }
function locksDirOf(vaultRoot)      { return path.join(vaultRoot, VAULT_DIRS.locks);   }
function assetDirOf(vaultRoot, assetId) { return path.join(assetsDirOf(vaultRoot), assetId); }

// ---- marker + init ---------------------------------------------------------

// "Is this path a vault?" — cheap signal before doing anything destructive.
// A vault exists iff the marker file is present AND parses as JSON with
// schemaVersion. We don't walk assets/ here; that's initVault's job.
function isVaultRoot(vaultRoot) {
    try {
        const raw = fs.readFileSync(vaultMarkerPath(vaultRoot), 'utf8');
        const j = JSON.parse(raw);
        return typeof j.schemaVersion === 'number';
    } catch (_) { return false; }
}

// Create the directory structure + marker. Idempotent — running on an existing
// vault is a no-op that just verifies/heals missing subdirs. Used by:
//   * wizard.save (first-time setup)
//   * main.js startup (repair missing .trash/.locks after manual tampering)
function initVault(vaultRoot, { chiralVersion } = {}) {
    fs.mkdirSync(vaultRoot,               { recursive: true });
    fs.mkdirSync(assetsDirOf(vaultRoot),  { recursive: true });
    fs.mkdirSync(trashDirOf(vaultRoot),   { recursive: true });
    fs.mkdirSync(locksDirOf(vaultRoot),   { recursive: true });

    if (!isVaultRoot(vaultRoot)) {
        atomicWriteJSON(vaultMarkerPath(vaultRoot), {
            schemaVersion: VAULT_SCHEMA_VERSION,
            createdAt: new Date().toISOString(),
            chiralVersion: chiralVersion || null,
        });
    }
    return { ok: true, vaultRoot };
}

// ---- index.json — denormalized cache ---------------------------------------
//
// Shape: { schemaVersion, builtAt, assets: [ { <projection> }, ... ] }.
// One row per asset. Reading asset.json for every tile on a 500-asset grid
// would be ~500 stat+open calls on every Vault panel open; this file is the
// precomputed projection, rebuilt on mutation.
//
// PROJECTION FIELDS — chosen to feed the grid + search without extra I/O:
//   assetId, name, kind, tags, thumbnailRel, specAtVault,
//   origin.projectName, origin.shotName, origin.vaultedAt,
//   usageCount, masterRel, proxyRel

// dev37 — recursive byte sum of an asset dir. Walks every file under
// `dir` (including subdirs like ae/ and clips/) and totals their sizes.
// Symlinks are followed via fs.statSync; broken symlinks throw which we
// swallow (best-effort). Cost: ~1 readdir + 1 stat per file. For a
// typical asset (master + proxy + thumb + ae/ project + footage) that's
// well under 100 syscalls. Called from rebuildIndex once per asset.
function dirSizeBytes(dir) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return 0; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            total += dirSizeBytes(p);
        } else if (ent.isFile()) {
            try { total += fs.statSync(p).size; } catch (_) {}
        }
    }
    return total;
}

function projectAsset(a) {
    // dev24 — surface the procedural template kind (`comp` | `layer`)
    // so the vault UI can show a precise badge instead of generic "ASSET"
    // for templates. Stored at the asset level via dependencies.footage[0]
    // by clipShot when a template was extracted; null for everything else.
    let templateKind = null;
    if (a.dependencies && Array.isArray(a.dependencies.footage)
        && a.dependencies.footage[0] && a.dependencies.footage[0].templateKind) {
        templateKind = a.dependencies.footage[0].templateKind;
    }
    return {
        assetId:      a.assetId,
        // dev13 — type discriminator; legacy (pre-dev13) assets have no
        // `type` field and are treated as the default "asset" by callers.
        type:         a.type || 'asset',
        templateKind, // dev24 — null | 'comp' | 'layer'
        name:         a.name,
        kind:         a.kind,
        tags:         Array.isArray(a.tags) ? a.tags.slice() : [],
        thumbnailRel: (a.files && a.files.thumbnail) || null,
        masterRel:    (a.files && a.files.master)    || null,
        proxyRel:     (a.files && a.files.proxy)     || null,
        // Clip count — saves vault.html another round-trip when rendering
        // the tile badge ("3 clips"). Null for type:"asset" assets.
        clipCount:    (a.files && Array.isArray(a.files.clips)) ? a.files.clips.length : null,
        specAtVault:  a.specAtVault || null,
        originProject: (a.origin && a.origin.projectName) || null,
        originShot:    (a.origin && a.origin.shotName)    || null,
        vaultedAt:    (a.origin && a.origin.vaultedAt)    || null,
        usageCount:   Array.isArray(a.usage) ? a.usage.length : 0,
        // dev24 — folder assignment is stamped at projection time by
        // rebuildIndex (see _readFolderAssignments). Null = "(unfiled)".
        folderId:     null,
        // dev37 — total bytes on disk for the asset dir. Stamped by
        // rebuildIndex via dirSizeBytes(); null until an index is built.
        sizeBytes:    null,
    };
}

// Walk assets/ directly — this is the authoritative rebuild. Cheap because
// JSON parses are fast and we only touch asset.json (not proxy/master). If an
// asset dir exists but its manifest is missing/broken, it's skipped with a
// warning in the returned report (UI surfaces "3 broken assets — inspect").
function rebuildIndex(vaultRoot) {
    const dir = assetsDirOf(vaultRoot);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { entries = []; }

    // dev24 — read folder assignments once and stamp them on every
    // projected asset row. We require lazily so a vault that's never
    // had folders.json doesn't pay any cost.
    let folderAssignments = {};
    let foldersList = [];
    try {
        const VF = require('./vault_folders');
        const fdata = VF.readFolders(vaultRoot);
        folderAssignments = fdata.assignments || {};
        foldersList = fdata.folders || [];
    } catch (_) { /* missing/broken folders.json — index without folder data */ }

    const assets  = [];
    const skipped = [];
    for (const d of entries) {
        if (!d.isDirectory()) continue;
        const assetDir = path.join(dir, d.name);
        const a = readAsset(assetDir);
        if (!a) { skipped.push({ dir: d.name, reason: 'manifest missing or unparseable' }); continue; }
        const v = validateAsset(a);
        if (!v.ok) { skipped.push({ dir: d.name, reason: v.errors.join('; ') }); continue; }
        // Folder name must match assetId — defensive check against manual rename.
        if (a.assetId !== d.name) {
            skipped.push({ dir: d.name, reason: `assetId ${a.assetId} != folder name` });
            continue;
        }
        const row = projectAsset(a);
        row.folderId = folderAssignments[a.assetId] || null;
        // dev37 — total bytes on disk. Stamped here (not in projectAsset)
        // so the projection stays JSON-only; size requires file I/O on the
        // asset dir. Failure is silent → null on the row.
        try { row.sizeBytes = dirSizeBytes(assetDir); } catch (_) { row.sizeBytes = null; }
        assets.push(row);
    }

    const index = {
        schemaVersion: VAULT_SCHEMA_VERSION,
        builtAt: new Date().toISOString(),
        assets,
        // dev24 — folders inline in the index so vault:list returns
        // everything the UI needs in one round-trip.
        folders: foldersList,
    };
    atomicWriteJSON(vaultIndexPath(vaultRoot), index);
    return { ok: true, count: assets.length, skipped };
}

function readIndex(vaultRoot) {
    try { return JSON.parse(fs.readFileSync(vaultIndexPath(vaultRoot), 'utf8')); }
    catch (_) { return null; }
}

// ---- soft delete (trash) ---------------------------------------------------
//
// Design question #3: soft delete. Moves <assets>/<id>/ → <.trash>/<id>-<ts>/
// atomically via rename (same-volume guarantee — vault is one root). The
// timestamp suffix is so two deletes of the same id (after a restore) don't
// collide. Restore is just the reverse move; purge is fs.rm -rf.

function trashAsset(vaultRoot, assetId) {
    const src = assetDirOf(vaultRoot, assetId);
    if (!fs.existsSync(src)) return { ok: false, error: 'asset not found', assetId };
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(trashDirOf(vaultRoot), `${assetId}-${ts}`);
    fs.mkdirSync(trashDirOf(vaultRoot), { recursive: true });
    fs.renameSync(src, dst);
    return { ok: true, trashPath: dst };
}

// Restore from a specific trash dir. We require the caller to pass the full
// trash entry name (id + timestamp) because a given assetId could have
// multiple trash entries from separate delete cycles.
function restoreAsset(vaultRoot, trashEntryName) {
    const src = path.join(trashDirOf(vaultRoot), trashEntryName);
    if (!fs.existsSync(src)) return { ok: false, error: 'trash entry not found' };
    // The leading UUID is the assetId — split at the first dash AFTER position
    // 35 (UUIDs are 36 chars). Using lastIndexOf would break on UUIDs that
    // contain no dashes in the timestamp? Timestamps always contain dashes —
    // but UUIDs contain exactly 4. So: slice first 36 chars.
    const assetId = trashEntryName.slice(0, 36);
    const dst = assetDirOf(vaultRoot, assetId);
    if (fs.existsSync(dst)) return { ok: false, error: 'asset with same id already exists in assets/' };
    fs.renameSync(src, dst);
    return { ok: true, assetId, restoredTo: dst };
}

// List trash entries with parsed age for UI. No mutation — the caller decides
// when to auto-purge.
function listTrash(vaultRoot) {
    let entries = [];
    try { entries = fs.readdirSync(trashDirOf(vaultRoot), { withFileTypes: true }); }
    catch (_) { return []; }
    const out = [];
    for (const d of entries) {
        if (!d.isDirectory()) continue;
        const assetId = d.name.slice(0, 36);
        let trashedAt = null;
        try { trashedAt = fs.statSync(path.join(trashDirOf(vaultRoot), d.name)).mtime.toISOString(); } catch (_) {}
        out.push({ entry: d.name, assetId, trashedAt });
    }
    return out;
}

// Purge trash entries older than retentionDays. Returns the list removed.
// Never touches assets/ — only .trash/. Safe to call on startup.
function purgeOldTrash(vaultRoot, retentionDays = TRASH_RETENTION_DAYS) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = [];
    for (const t of listTrash(vaultRoot)) {
        const trashedMs = t.trashedAt ? Date.parse(t.trashedAt) : 0;
        if (trashedMs && trashedMs < cutoff) {
            const p = path.join(trashDirOf(vaultRoot), t.entry);
            try {
                fs.rmSync(p, { recursive: true, force: true });
                removed.push(t);
            } catch (_) { /* best-effort — leave it for next pass */ }
        }
    }
    return removed;
}

// dev32 — user-initiated "empty trash now". Wipes EVERY entry in
// .trash/ regardless of age. The 7-day auto-retention via
// purgeOldTrash is still the default, untouched, and still runs on
// app boot — this function is only invoked from an explicit UI
// action (the trash drawer's "Empty trash" button) gated behind a
// confirm dialog. Returns the list removed for telemetry.
function emptyAllTrash(vaultRoot) {
    const removed = [];
    for (const t of listTrash(vaultRoot)) {
        const p = path.join(trashDirOf(vaultRoot), t.entry);
        try {
            fs.rmSync(p, { recursive: true, force: true });
            removed.push(t);
        } catch (_) { /* best-effort */ }
    }
    return removed;
}

// ---- portability audit -----------------------------------------------------
// Walks every asset.json and flags any absolute-path field. Returns a report
// UI can surface. Used by the debug "Verify Vault Portability" command and
// can run in CI on a sample vault.
function verifyPortability(vaultRoot) {
    const dir = assetsDirOf(vaultRoot);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return { ok: true, checked: 0, offenders: [] }; }
    const offenders = [];
    let checked = 0;
    for (const d of entries) {
        if (!d.isDirectory()) continue;
        const a = readAsset(path.join(dir, d.name));
        if (!a) continue;
        checked++;
        const hits = findAbsolutePathFields(a);
        if (hits.length) offenders.push({ assetId: a.assetId || d.name, hits });
    }
    return { ok: offenders.length === 0, checked, offenders };
}

module.exports = {
    VAULT_SCHEMA_VERSION,
    VAULT_DIRS,
    VAULT_FILES,
    TRASH_RETENTION_DAYS,
    vaultMarkerPath,
    vaultIndexPath,
    assetsDirOf,
    trashDirOf,
    locksDirOf,
    assetDirOf,
    isVaultRoot,
    initVault,
    projectAsset,
    dirSizeBytes,            // dev37
    rebuildIndex,
    readIndex,
    trashAsset,
    restoreAsset,
    listTrash,
    purgeOldTrash,
    emptyAllTrash,
    verifyPortability,
};
