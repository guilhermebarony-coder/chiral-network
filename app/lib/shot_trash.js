// lib/shot_trash.js — soft-delete + 7-day retention for shots.
//
// dev35 — mirrors the dev32 vault-trash patterns one-to-one. Why a separate
// lib instead of generalising vault.js? Two reasons:
//
//   1. The trash STORE differs. Vault has one fixed `vaultRoot/.trash/` and
//      asset IDs are UUIDs (slice(0,36) parses entries). Shot trash lives
//      per-project at `<projectDir>/.trash/` and shot names are arbitrary
//      strings, so the entry-name parser is different.
//   2. `restoreShot` has to check that no live shot with the same name
//      already exists in the project before moving back — a conflict the
//      vault path doesn't have because vault assets are content-addressed.
//
// On-disk layout, per project:
//   <projectDir>/
//     ├── Shot_001/                        # live shot
//     ├── Shot_002/
//     └── .trash/
//         ├── 2026-04-30T15-22-33-456Z__Shot_001/
//         └── 2026-04-30T18-00-12-009Z__Shot_001/   # second delete after restore
//
// Entry name format: `${timestamp}__${shotName}`. The double underscore is
// the separator (timestamps from `toISOString().replace(/[:.]/g, '-')` never
// contain `__`; shot names are allowed to contain single underscores).
// indexOf('__') gives the split point unambiguously.

const fs   = require('fs');
const path = require('path');

const TRASH_DIR_NAME = '.trash';
const TRASH_RETENTION_DAYS = 7;
const SEP = '__';

function trashDirOf(projectDir) { return path.join(projectDir, TRASH_DIR_NAME); }

// Format Date → safe filename component. `:` and `.` are illegal on Windows;
// replace both with `-`. Output stays sortable lexicographically because the
// dashes are at fixed positions.
function makeTimestamp(d = new Date()) {
    return d.toISOString().replace(/[:.]/g, '-');
}

// Split an entry filename back into { timestamp, shotName }. Returns null
// for malformed names so the caller can skip them.
function parseEntry(entryName) {
    const i = entryName.indexOf(SEP);
    if (i < 0) return null;
    const timestamp = entryName.slice(0, i);
    const shotName  = entryName.slice(i + SEP.length);
    if (!timestamp || !shotName) return null;
    return { timestamp, shotName };
}

// Move a shot folder into <project>/.trash/<ts>__<shot>/. Atomic rename on
// the same volume (the project tree is one root, mirroring the vault's same-
// volume guarantee). Returns the new trash path on success.
function trashShot(projectDir, shotName) {
    const src = path.join(projectDir, shotName);
    if (!fs.existsSync(src)) return { ok: false, error: 'shot not found' };
    if (!fs.statSync(src).isDirectory()) return { ok: false, error: 'shot path is not a directory' };
    const ts = makeTimestamp();
    const entry = `${ts}${SEP}${shotName}`;
    const dst = path.join(trashDirOf(projectDir), entry);
    fs.mkdirSync(trashDirOf(projectDir), { recursive: true });
    fs.renameSync(src, dst);
    return { ok: true, trashPath: dst, entry };
}

// Restore a shot from a specific trash entry. Refuses to overwrite a live
// shot with the same name — caller should rename the live one or pick a
// different restore target. Caller passes the full entry name (timestamp +
// shotName) because there can be multiple trash entries for the same shot.
function restoreShot(projectDir, entryName) {
    const src = path.join(trashDirOf(projectDir), entryName);
    if (!fs.existsSync(src)) return { ok: false, error: 'trash entry not found' };
    const parsed = parseEntry(entryName);
    if (!parsed) return { ok: false, error: 'malformed trash entry name' };
    const dst = path.join(projectDir, parsed.shotName);
    if (fs.existsSync(dst)) {
        return { ok: false, error: `a shot named "${parsed.shotName}" already exists — rename it before restoring` };
    }
    fs.renameSync(src, dst);
    return { ok: true, shotName: parsed.shotName, restoredTo: dst };
}

// List trash entries for a single project. Each entry carries the parsed
// shot name + the trashed-at timestamp from `mtime` so the UI can show age
// without re-stat'ing per row. No mutation — callers decide when to purge.
function listTrash(projectDir) {
    const td = trashDirOf(projectDir);
    let entries = [];
    try { entries = fs.readdirSync(td, { withFileTypes: true }); }
    catch (_) { return []; }
    const out = [];
    for (const d of entries) {
        if (!d.isDirectory()) continue;
        const parsed = parseEntry(d.name);
        if (!parsed) continue;
        let trashedAt = null;
        try { trashedAt = fs.statSync(path.join(td, d.name)).mtime.toISOString(); } catch (_) {}
        out.push({
            entry:    d.name,
            shotName: parsed.shotName,
            trashedAt,
        });
    }
    return out;
}

// List trash across every project under projectsDir. Each entry carries the
// project name so the UI can group / show columns. Used by the global
// "Project trash" drawer in index.html.
function listAllTrash(projectsDir) {
    let projects = [];
    try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); }
    catch (_) { return []; }
    const out = [];
    for (const p of projects) {
        if (!p.isDirectory()) continue;
        if (p.name.startsWith('.')) continue;
        const projectDir = path.join(projectsDir, p.name);
        for (const t of listTrash(projectDir)) {
            out.push(Object.assign({ project: p.name }, t));
        }
    }
    // Newest first — the UI typically wants recent deletes at the top.
    out.sort((a, b) => (b.trashedAt || '').localeCompare(a.trashedAt || ''));
    return out;
}

// Delete a single trash entry permanently. No retention check — caller is
// expected to gate this behind a confirm dialog.
function purgeEntry(projectDir, entryName) {
    const p = path.join(trashDirOf(projectDir), entryName);
    if (!fs.existsSync(p)) return { ok: false, error: 'trash entry not found' };
    try {
        fs.rmSync(p, { recursive: true, force: true });
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

// Auto-purge entries older than retentionDays across every project. Called
// at app boot and after each manual trash mutation. Best-effort — a single
// failed entry doesn't abort the rest.
function purgeOldShotTrash(projectsDir, retentionDays = TRASH_RETENTION_DAYS) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = [];
    let projects = [];
    try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); }
    catch (_) { return removed; }
    for (const p of projects) {
        if (!p.isDirectory() || p.name.startsWith('.')) continue;
        const projectDir = path.join(projectsDir, p.name);
        for (const t of listTrash(projectDir)) {
            const trashedMs = t.trashedAt ? Date.parse(t.trashedAt) : 0;
            if (trashedMs && trashedMs < cutoff) {
                const r = purgeEntry(projectDir, t.entry);
                if (r.ok) removed.push(Object.assign({ project: p.name }, t));
            }
        }
    }
    return removed;
}

// User-initiated "empty all". Wipes every trash entry across every project
// regardless of age. Mirror of vault.js#emptyAllTrash.
function emptyAllShotTrash(projectsDir) {
    const removed = [];
    let projects = [];
    try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); }
    catch (_) { return removed; }
    for (const p of projects) {
        if (!p.isDirectory() || p.name.startsWith('.')) continue;
        const projectDir = path.join(projectsDir, p.name);
        for (const t of listTrash(projectDir)) {
            const r = purgeEntry(projectDir, t.entry);
            if (r.ok) removed.push(Object.assign({ project: p.name }, t));
        }
    }
    return removed;
}

module.exports = {
    TRASH_DIR_NAME,
    TRASH_RETENTION_DAYS,
    trashDirOf,
    trashShot,
    restoreShot,
    listTrash,
    listAllTrash,
    purgeEntry,
    purgeOldShotTrash,
    emptyAllShotTrash,
    parseEntry,    // exported for tests
    makeTimestamp, // exported for tests
};
