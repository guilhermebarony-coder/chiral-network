// lib/asset.js — Vault asset schema + pure helpers.
//
// An "asset" is a vaulted, reusable artifact (typically a finished shot or
// animation) stored under <VaultRoot>/assets/<assetId>/. Its ground-truth
// metadata lives in `asset.json` at the asset dir root.
//
// This module is pure: no electron, no module-level state, no filesystem
// side effects beyond explicit read/write helpers. Everything is callable
// from tests with just a tmp dir.
//
// Design anchors (see Session 4 design doc):
//   * UUID-keyed flat layout — no hierarchical folders inside assets/
//   * All intra-asset paths are RELATIVE — vault must survive a drive move
//   * schemaVersion on every file — additive migrations only
//   * origin is immutable after vault; usage[] is append-only
//
// Grep anchor: VAULT_ASSET_SCHEMA — keep in sync with any AE-side JSX that
// writes asset.json fields and with import/export handlers in main.js.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON } = require('./job');

const ASSET_SCHEMA_VERSION = 1;

// File-name conventions inside an asset dir. Centralized so the rest of the
// app never hardcodes these strings.
const ASSET_FILES = Object.freeze({
    manifest:  'asset.json',
    master:    'master',          // extension appended from source (mov/mp4/mxf…)
    proxy:     'proxy.mp4',
    thumbnail: 'thumb.jpg',
    aeRoot:    'ae',              // Collect Files target dir
    proxyLog:  '.proxy.log',
    errorLog:  '.vault.error.json',
    doneFlag:  '.vault.done.json',
});

// Kinds supported today. Future values (`template`, `lut`, `preset`) can be
// added without breaking v1 readers — validateAsset warns but doesn't reject.
const ASSET_KINDS = Object.freeze(['shot', 'animation']);

// dev13 — `type` discriminates between full-AEP assets and bare-files clips.
// Existing assets pre-dev13 have no `type` field; readers treat that as
// "asset" (the legacy default) so the upgrade is purely additive.
//   * "asset" — full .aep + collected footage (vault_collect.jsx)
//   * "clip"  — just tagged files, no .aep      (vault_clip.jsx)
const ASSET_TYPES = Object.freeze(['asset', 'clip']);

// ---- ID + validation -------------------------------------------------------

// UUIDv4 — stable forever, used as folder name and cross-project foreign key.
// Kept as a thin wrapper so tests can monkey-patch deterministically.
function newAssetId() {
    return crypto.randomUUID();
}

// RFC 4122 v4 shape. Intentionally strict — we generate these ourselves, so
// anything that doesn't match is a bug or a hand-edited file.
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidAssetId(s) {
    return typeof s === 'string' && ASSET_ID_RE.test(s);
}

// Shape check, not semantic. Returns { ok, errors[], warnings[] }. Errors
// block reads/writes; warnings surface in logs but don't stop the caller.
// Checks the fields the rest of the app will actually dereference.
function validateAsset(a) {
    const errors = [];
    const warnings = [];
    if (!a || typeof a !== 'object') {
        return { ok: false, errors: ['asset is not an object'], warnings };
    }
    if (a.schemaVersion !== ASSET_SCHEMA_VERSION) {
        // Future-version reads land here. We don't crash — main.js decides
        // whether to migrate-down or refuse. Tests assert the warning text.
        warnings.push(`schemaVersion=${a.schemaVersion} (expected ${ASSET_SCHEMA_VERSION})`);
    }
    if (!isValidAssetId(a.assetId)) errors.push('assetId must be UUIDv4');
    if (typeof a.name !== 'string' || !a.name.trim()) errors.push('name is required');
    if (!ASSET_KINDS.includes(a.kind)) warnings.push(`unknown kind: ${a.kind}`);
    // dev13: type defaults to "asset" for back-compat. We warn (not error)
    // on unknown values so future "preset"/"lut" types don't break v1 readers.
    if (a.type !== undefined && !ASSET_TYPES.includes(a.type)) {
        warnings.push(`unknown type: ${a.type} (expected one of ${ASSET_TYPES.join(', ')})`);
    }

    if (!a.origin || typeof a.origin !== 'object') errors.push('origin block missing');
    else {
        if (typeof a.origin.projectName !== 'string') errors.push('origin.projectName missing');
        if (typeof a.origin.vaultedAt !== 'string')   errors.push('origin.vaultedAt missing');
    }

    if (!a.specAtVault || typeof a.specAtVault !== 'object') {
        errors.push('specAtVault block missing');
    } else {
        const s = a.specAtVault;
        if (typeof s.fps !== 'number' || !isFinite(s.fps) || s.fps <= 0)
            errors.push('specAtVault.fps must be positive number');
        if (!Number.isInteger(s.width)  || s.width  <= 0) errors.push('specAtVault.width must be positive integer');
        if (!Number.isInteger(s.height) || s.height <= 0) errors.push('specAtVault.height must be positive integer');
    }

    if (!a.files || typeof a.files !== 'object') {
        errors.push('files block missing');
    } else {
        // All path fields must be relative — absolute paths defeat the whole
        // portability contract. We check explicitly; path.isAbsolute handles
        // both C:\ and / forms.
        // dev13: `clips` is an array of relative paths (clip-mode assets).
        // Validate each entry rather than the array itself.
        for (const [k, v] of Object.entries(a.files)) {
            if (v == null) continue;
            if (k === 'clips') {
                if (!Array.isArray(v)) { errors.push('files.clips must be an array'); continue; }
                v.forEach((cp, idx) => {
                    if (typeof cp !== 'string') errors.push(`files.clips[${idx}] must be string`);
                    else if (path.isAbsolute(cp)) errors.push(`files.clips[${idx}] must be relative (got ${cp})`);
                    else if (cp.includes('..'))   errors.push(`files.clips[${idx}] must not contain .. (got ${cp})`);
                });
                continue;
            }
            if (typeof v !== 'string') { errors.push(`files.${k} must be string`); continue; }
            if (path.isAbsolute(v))     errors.push(`files.${k} must be relative (got ${v})`);
            if (v.includes('..'))       errors.push(`files.${k} must not contain .. (got ${v})`);
        }
    }

    if (a.usage && !Array.isArray(a.usage)) errors.push('usage must be an array');
    return { ok: errors.length === 0, errors, warnings };
}

// ---- factory ---------------------------------------------------------------

// Builds a fresh, valid asset object from the minimum set of inputs. Callers
// (vault-create handler, tests) fill in files/dependencies after the AE
// collect + proxy steps finish.
//
// Required: name, kind, origin{projectName, shotName, chiralVersion},
//           specAtVault{fps, width, height}
// Optional: tags[], origin.sourceJobId, specAtVault.durationFrames/colorSpace,
//           origin.aeVersion (question #5)
function createAsset({ name, kind, origin, specAtVault, tags, assetId, type }) {
    const id = assetId || newAssetId();
    const now = new Date().toISOString();
    return {
        schemaVersion: ASSET_SCHEMA_VERSION,
        assetId: id,
        type: ASSET_TYPES.includes(type) ? type : 'asset',
        name: String(name || '').trim(),
        kind: ASSET_KINDS.includes(kind) ? kind : 'shot',
        tags: Array.isArray(tags) ? tags.slice() : [],
        origin: Object.assign(
            { projectName: '', shotName: '', chiralVersion: '', vaultedAt: now, vaultedBy: null, sourceJobId: null, aeVersion: null },
            origin || {},
            { vaultedAt: (origin && origin.vaultedAt) || now }
        ),
        specAtVault: Object.assign(
            { fps: 0, width: 0, height: 0, durationFrames: null, colorSpace: null },
            specAtVault || {}
        ),
        files: {
            master:    null,
            proxy:     null,
            thumbnail: null,
            aeProject: null,
            aeRoot:    null,
            // dev13 — populated only for type:"clip" assets. Each entry is
            // a relative path under the asset dir (typically "clips/foo.psd").
            clips:     null,
        },
        dependencies: {
            footage: [],
            fonts:   [],
            plugins: [],
        },
        usage: [],
    };
}

// ---- I/O -------------------------------------------------------------------

function manifestPathFor(assetDir) {
    return path.join(assetDir, ASSET_FILES.manifest);
}

function readAsset(assetDir) {
    const p = manifestPathFor(assetDir);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (_) { return null; }
}

function writeAsset(assetDir, asset) {
    // Validate before the atomic write — a broken asset.json on disk is worse
    // than refusing to write. Callers get the full error list.
    const v = validateAsset(asset);
    if (!v.ok) {
        const err = new Error('asset validation failed: ' + v.errors.join('; '));
        err.validation = v;
        throw err;
    }
    atomicWriteJSON(manifestPathFor(assetDir), asset);
    return v;
}

// ---- usage log -------------------------------------------------------------
// Append-only. Never mutates prior entries, never re-orders. Returns the
// updated asset (pure-ish — caller decides when to persist).
function appendUsage(asset, { toProject, toShot, mode, at }) {
    const entry = {
        toProject: String(toProject || ''),
        toShot:    String(toShot || ''),
        mode:      mode === 'link' ? 'link' : 'copy',   // copy is the MVP default
        at:        at || new Date().toISOString(),
    };
    const next = Object.assign({}, asset, { usage: (asset.usage || []).concat([entry]) });
    return next;
}

// ---- path portability guard ------------------------------------------------
// Hard-fails CI / the "Verify Vault Portability" debug command if anything in
// an asset's JSON smells like an absolute path. Walks the object recursively
// so it catches fields we add later without updating this check.
const ABS_PATH_SMELL = /^[A-Za-z]:[\\/]|^\/\//;   // C:\ or UNC
function findAbsolutePathFields(obj, pathPrefix = '') {
    const hits = [];
    if (obj == null) return hits;
    if (typeof obj === 'string') {
        if (ABS_PATH_SMELL.test(obj) || path.isAbsolute(obj)) hits.push({ field: pathPrefix, value: obj });
        return hits;
    }
    if (Array.isArray(obj)) {
        obj.forEach((v, i) => hits.push(...findAbsolutePathFields(v, `${pathPrefix}[${i}]`)));
        return hits;
    }
    if (typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
            hits.push(...findAbsolutePathFields(v, pathPrefix ? `${pathPrefix}.${k}` : k));
        }
    }
    return hits;
}

module.exports = {
    ASSET_SCHEMA_VERSION,
    ASSET_FILES,
    ASSET_KINDS,
    ASSET_TYPES,
    ASSET_ID_RE,
    newAssetId,
    isValidAssetId,
    validateAsset,
    createAsset,
    manifestPathFor,
    readAsset,
    writeAsset,
    appendUsage,
    findAbsolutePathFields,
};
