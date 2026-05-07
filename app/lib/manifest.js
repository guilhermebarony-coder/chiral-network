// lib/manifest.js — canonical read/write/migrate for versioned JSON files.
//
// Covers every persistent JSON artefact in the app that is NOT job.json:
//   * settings.json      — userData, app-wide preferences
//   * project.json       — per-project manifest (lockedSpec + future fields)
//   * asset.json         — v0.4.9 Vault, one per asset
//   * .spec_mismatch.json — transient sidecar, read-mostly
//
// job.json predates this module and still uses its own reader in lib/job.js
// (readJob/writeJob/withJob). That reader is semantically equivalent to
// readManifest(path, { defaultValue: null }) with no migrations — we leave
// it alone to avoid churning the hot path and the withJob() signature that
// every IPC handler already depends on.
//
// Design goals:
//   1. Every read returns a plain object (never throws, never returns null
//      except when the caller explicitly sets defaultValue:null). Callers
//      can destructure without a try/catch wrapper.
//   2. Every write is atomic (tmp + fsync + rename via atomicWriteJSON).
//   3. Schema evolution is explicit: callers pass a `migrations` array;
//      the manifest's own schemaVersion field drives which steps run.
//      Migrations run at read time, and (if they mutated anything) the
//      migrated file is flushed back to disk so subsequent reads skip them.
//
// This is NOT a general-purpose schema validator. We've kept validation at
// the "does the file parse, is it an object, does it have schemaVersion"
// level on purpose — richer validation belongs in per-caller code where the
// error messages can be specific ("asset.json is missing proxyRelPath")
// instead of generic. A validator library would be overkill for the four
// files we actually write.

const fs   = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./job');

const CURRENT_MANIFEST_SCHEMAS = Object.freeze({
    // Each entry declares the CURRENT target version for a given manifest
    // kind. Bump when you add fields that need migration; leave alone for
    // purely-additive fields that default cleanly on absence.
    settings:  1,
    project:   1,
    asset:     1,
});

// ---- Core read -------------------------------------------------------------
// Never throws. Returns:
//   * {} when the file is missing (or missing+createIfAbsent:true writes it)
//   * the parsed object when it parses as a plain object
//   * defaultValue (if provided) otherwise — including malformed JSON,
//     unreadable permissions, or a top-level array (we only accept objects)
//
// When migrations are provided, they run in order for every version step
// below `targetVersion`. If any migration mutated the object, the result is
// flushed back via atomicWriteJSON so the next read is fast.
//
// The migration contract:
//   migrations[i] = (obj) => void   // mutates in place, runs to bring
//                                   // schemaVersion from i to i+1.
// Index i must match "the version we are migrating FROM". So migrations[0]
// upgrades a v0 file (or an unversioned legacy file, treated as v0) to v1,
// migrations[1] upgrades v1→v2, etc.
function readManifest(filePath, opts = {}) {
    const {
        defaultValue     = {},
        targetVersion    = null,       // null = don't enforce a version
        migrations       = null,       // array of (obj)=>void; see above
        createIfAbsent   = false,      // write defaultValue when file missing
    } = opts;

    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        // ENOENT is the expected "not written yet" path; anything else is
        // still non-fatal (we return default) but worth not silently eating
        // in case a tester reports "my project forgot its spec lock".
        if (e.code !== 'ENOENT') {
            console.warn('[manifest] read failed:', filePath, e.message);
        }
        if (createIfAbsent) {
            const seed = _clone(defaultValue);
            if (targetVersion != null) seed.schemaVersion = targetVersion;
            try { atomicWriteJSON(filePath, seed); } catch (_) {}
            return seed;
        }
        return _clone(defaultValue);
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
        console.warn('[manifest] JSON parse failed:', filePath, e.message);
        return _clone(defaultValue);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return _clone(defaultValue);
    }

    // ---- Migration pass ---------------------------------------------------
    if (targetVersion != null && Array.isArray(migrations) && migrations.length) {
        const startVer = Number.isInteger(parsed.schemaVersion)
            ? parsed.schemaVersion
            : 0;   // unversioned legacy file = v0
        let ver = startVer;
        let mutated = false;
        while (ver < targetVersion) {
            const step = migrations[ver];
            if (typeof step !== 'function') break;   // gap = stop, don't crash
            try {
                step(parsed);
                mutated = true;
            } catch (e) {
                // A failing migration is a red flag — log loudly, stop the
                // climb, but return the partially-migrated object so the app
                // keeps running. The file on disk is NOT updated if we fail
                // mid-chain; next launch retries cleanly.
                console.error('[manifest] migration v%d->v%d failed on %s: %s',
                    ver, ver + 1, filePath, e.message);
                return parsed;
            }
            ver += 1;
            parsed.schemaVersion = ver;
        }
        if (mutated) {
            try { atomicWriteJSON(filePath, parsed); }
            catch (e) { console.warn('[manifest] post-migration flush failed:',
                filePath, e.message); }
        }
    } else if (targetVersion != null && parsed.schemaVersion == null) {
        // No migrations supplied but caller declared a targetVersion —
        // stamp it so the field is always populated going forward.
        parsed.schemaVersion = targetVersion;
    }

    return parsed;
}

// ---- Core write ------------------------------------------------------------
// Stamps schemaVersion (if a targetVersion is given and the caller didn't
// set one themselves) then atomic-writes. Returns true on success, false
// on failure — callers decide whether to surface the error.
function writeManifest(filePath, obj, opts = {}) {
    const { targetVersion = null } = opts;
    const out = (obj && typeof obj === 'object') ? obj : {};
    if (targetVersion != null && out.schemaVersion == null) {
        out.schemaVersion = targetVersion;
    }
    try {
        atomicWriteJSON(filePath, out);
        return true;
    } catch (e) {
        console.warn('[manifest] write failed:', filePath, e.message);
        return false;
    }
}

// ---- Convenience: read + mutate + write ------------------------------------
// Mirror of withJob() for non-job manifests. The mutator mutates in place
// and returns:
//   * truthy   → commit (atomic write)
//   * falsy    → no-op, no write
// The (possibly-mutated) object is always returned so callers can read the
// post-state. Errors from the mutator propagate; this helper is for trusted
// main-process code, not IPC boundaries (use withJob pattern for those).
function withManifest(filePath, opts, mutator) {
    const m = readManifest(filePath, opts);
    const commit = mutator(m);
    if (commit) {
        writeManifest(filePath, m, opts);
    }
    return m;
}

// ---- Internal --------------------------------------------------------------
// Deep-clone for defaultValue so callers can't accidentally mutate the shared
// default across reads. JSON round-trip is fine for our plain-object payloads.
function _clone(v) {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return {}; }
}

module.exports = {
    CURRENT_MANIFEST_SCHEMAS,
    readManifest,
    writeManifest,
    withManifest,
};
