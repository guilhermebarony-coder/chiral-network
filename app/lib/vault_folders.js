// lib/vault_folders.js — Virtual-folder organization for the Vault (0.5.0-dev24).
//
// Why "virtual": folders are metadata, not on-disk directory moves. The
// asset's bytes never leave <vault>/assets/<id>/ — only the (folderId,
// assetId) mapping changes. This keeps the portability contract intact
// (assets are still UUID-flat under assets/) and means renaming/deleting
// a folder can never lose data.
//
// Storage:
//   <vault>/folders.json   {schemaVersion, folders[], assignments{}}
//
// folders[]: [{id, name, createdAt, color?}]  — folder definitions
// assignments{}: {<assetId>: <folderId>}      — one folder per asset
//
// Single-folder-per-asset is a deliberate simplification for the MVP.
// Multi-folder / tag-style organization can layer on later by changing
// the assignments value to an array; the asset-side schema doesn't need
// to know.
//
// Design anchors:
//   * Atomic writes via lib/job.js#atomicWriteJSON — never leave a
//     half-written folders.json on disk.
//   * Pure-ish: every function takes vaultRoot explicitly; no module
//     state.
//   * Defensive against missing folders.json (returns empty defaults)
//     so a fresh vault Just Works without a migration step.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON } = require('./job');

const FOLDERS_FILE = 'folders.json';
const FOLDERS_SCHEMA_VERSION = 1;

// fld_<8 lowercase hex> — short prefix makes folder IDs visually distinct
// from asset IDs (UUID v4) at a glance, both in logs and JSON.
const FOLDER_ID_RE = /^fld_[0-9a-f]{8}$/;
function newFolderId() {
    return 'fld_' + crypto.randomBytes(4).toString('hex');
}
function isValidFolderId(s) {
    return typeof s === 'string' && FOLDER_ID_RE.test(s);
}

function foldersPath(vaultRoot) {
    return path.join(vaultRoot, FOLDERS_FILE);
}

// Defensive read — missing/corrupt file returns the empty default rather
// than throwing, so callers don't need to special-case "first run."
function readFolders(vaultRoot) {
    const p = foldersPath(vaultRoot);
    if (!fs.existsSync(p)) return _empty();
    try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return _normalize(j);
    } catch (_) {
        return _empty();
    }
}

function _empty() {
    return {
        schemaVersion: FOLDERS_SCHEMA_VERSION,
        folders: [],
        assignments: {},
    };
}

// Coerce a parsed JSON into a known-shape object so the rest of the
// module can rely on `folders` being an array and `assignments` an
// object even if someone hand-edited the file.
function _normalize(j) {
    return {
        schemaVersion: Number(j && j.schemaVersion) || FOLDERS_SCHEMA_VERSION,
        folders: Array.isArray(j && j.folders) ? j.folders.filter(f => f && isValidFolderId(f.id) && typeof f.name === 'string') : [],
        assignments: (j && typeof j.assignments === 'object' && j.assignments) ? Object.assign({}, j.assignments) : {},
    };
}

function writeFolders(vaultRoot, data) {
    atomicWriteJSON(foldersPath(vaultRoot), _normalize(data));
}

// ---- Mutators --------------------------------------------------------------
// Each mutator reads, mutates, writes. Safe under sequential single-process
// access (Electron main only). For multi-process this would need locking;
// we don't have that case.

function createFolder(vaultRoot, rawName) {
    const name = String(rawName || '').trim();
    if (!name) return { ok: false, error: 'name required' };
    if (name.length > 80) return { ok: false, error: 'name too long (max 80)' };
    const data = readFolders(vaultRoot);
    // Prevent duplicate names — confusing in the UI and breaks "select by
    // name" debugging in logs. Case-insensitive comparison.
    if (data.folders.some(f => f.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: 'folder name already exists' };
    }
    const id = newFolderId();
    data.folders.push({
        id,
        name,
        createdAt: new Date().toISOString(),
    });
    writeFolders(vaultRoot, data);
    return { ok: true, id };
}

function renameFolder(vaultRoot, id, rawName) {
    const name = String(rawName || '').trim();
    if (!name) return { ok: false, error: 'name required' };
    if (name.length > 80) return { ok: false, error: 'name too long (max 80)' };
    const data = readFolders(vaultRoot);
    const target = data.folders.find(f => f.id === id);
    if (!target) return { ok: false, error: 'folder not found' };
    if (data.folders.some(f => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, error: 'folder name already exists' };
    }
    target.name = name;
    writeFolders(vaultRoot, data);
    return { ok: true };
}

function deleteFolder(vaultRoot, id) {
    const data = readFolders(vaultRoot);
    const idx = data.folders.findIndex(f => f.id === id);
    if (idx < 0) return { ok: false, error: 'folder not found' };
    data.folders.splice(idx, 1);
    // Orphan affected assets — they go back to "unfiled" rather than
    // disappearing or being silently moved.
    let cleared = 0;
    for (const aid of Object.keys(data.assignments)) {
        if (data.assignments[aid] === id) { delete data.assignments[aid]; cleared++; }
    }
    writeFolders(vaultRoot, data);
    return { ok: true, cleared };
}

// folderId === null  → unfile
// folderId === '<id>' → file under that folder (must exist)
function assignAsset(vaultRoot, assetId, folderId) {
    if (typeof assetId !== 'string' || !assetId) return { ok: false, error: 'bad assetId' };
    const data = readFolders(vaultRoot);
    if (folderId == null) {
        delete data.assignments[assetId];
        writeFolders(vaultRoot, data);
        return { ok: true, folderId: null };
    }
    if (!isValidFolderId(folderId)) return { ok: false, error: 'bad folderId' };
    if (!data.folders.some(f => f.id === folderId)) {
        return { ok: false, error: 'folder not found' };
    }
    data.assignments[assetId] = folderId;
    writeFolders(vaultRoot, data);
    return { ok: true, folderId };
}

// Helper — used by vault:delete to clean up the assignment when an asset
// goes to trash. Returns whether anything was cleared (caller doesn't
// care today, but useful for telemetry).
function removeAssignment(vaultRoot, assetId) {
    const data = readFolders(vaultRoot);
    if (!data.assignments[assetId]) return { ok: true, cleared: false };
    delete data.assignments[assetId];
    writeFolders(vaultRoot, data);
    return { ok: true, cleared: true };
}

module.exports = {
    FOLDERS_FILE,
    FOLDERS_SCHEMA_VERSION,
    FOLDER_ID_RE,
    isValidFolderId,
    newFolderId,
    foldersPath,
    readFolders,
    writeFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    assignAsset,
    removeAssignment,
};
