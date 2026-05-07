// lib/job.js — job.json lifecycle + per-shot reconciliation + atomic writes.
//
// Pure module: never reads module-level state. Every function takes the shot
// dir (or a full path) explicitly so it can be called from any context —
// IPC handlers, background watchers, migration helpers, tests.
//
// The cornerstone here is `atomicWrite` — a tmp-file + fsync + rename dance
// that guarantees either the old contents or the new contents are visible at
// every instant, never a half-written file. Every persistent write in the app
// should go through this primitive. `withJob(dir, mutator)` builds on it to
// make IPC handlers a one-liner: they mutate an object and we handle the
// read/serialize/write/error path.

const fs   = require('fs');
const path = require('path');

// ---- atomicWrite -----------------------------------------------------------
// Open a sibling .tmp in the same directory (same filesystem → rename is
// atomic on NTFS), write the full payload, fsync, close, then rename over
// the target. On any failure we close the fd and unlink the tmp so a retry
// starts clean.
//
// `data` may be Buffer or string. JSON callers stringify first. fsync is
// best-effort: some network/virtualized filesystems don't support it — we
// swallow that specific failure rather than propagating, because the rename
// still gives us crash-consistency for the common case.
function atomicWrite(targetPath, data) {
    const tmp = targetPath + '.tmp';
    // Ensure parent dir exists — callers shouldn't have to mkdir before every
    // write. Idempotent, cheap.
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let fd;
    try {
        fd = fs.openSync(tmp, 'w');
        fs.writeSync(fd, data);
        try { fs.fsyncSync(fd); } catch (_) { /* best-effort */ }
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, targetPath);
    } catch (e) {
        if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
}

// JSON convenience wrapper — pretty-prints with 2-space indent so the files
// stay human-readable/diffable in the projects/ tree.
function atomicWriteJSON(targetPath, obj) {
    atomicWrite(targetPath, JSON.stringify(obj, null, 2));
}

// ---- job.json I/O ----------------------------------------------------------
function jobPathOf(shotDir) { return path.join(shotDir, 'source', 'job.json'); }

function readJob(shotDir) {
    const p = jobPathOf(shotDir);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJob(shotDir, job) {
    atomicWriteJSON(jobPathOf(shotDir), job);
}

// ---- withJob ---------------------------------------------------------------
// Centralized read-modify-write helper for IPC handlers. Pass a shotDir and
// a mutator that returns truthy to commit (or returns `{ commit, result }`
// for richer control). The common IPC shape becomes:
//
//   ipcMain.handle('shot:setTrack', (_e, n) => withJob(shotDir(), job => {
//       job.resolveTrackIndex = parseInt(n, 10) || 2;
//       return { trackIndex: job.resolveTrackIndex };
//   }));
//
// Semantics:
//   * mutator returns `undefined` / `null` / `false` → no-op, no write
//   * mutator returns `{ commit: false, ... }`      → no write, pass through
//   * mutator returns any other truthy value        → atomic write + ok:true
//     and the value is merged into the returned object
// Errors from mutator propagate as `{ ok: false, error }` so handlers never
// have to try/catch.
function withJob(shotDir, mutator) {
    if (!shotDir) return { ok: false, error: 'no shot selected' };
    const job = readJob(shotDir);
    if (!job) return { ok: false, error: 'no job.json' };
    let result;
    try { result = mutator(job); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
    if (!result) return { ok: true };   // no-op: mutator chose not to commit
    if (result && result.commit === false) {
        const { commit, ...rest } = result;
        return Object.assign({ ok: true }, rest);
    }
    try { writeJob(shotDir, job); }
    catch (e) { return { ok: false, error: 'write failed: ' + (e.message || e) }; }
    if (result === true) return { ok: true };
    return Object.assign({ ok: true }, result);
}

// ---- Format / scale resolution --------------------------------------------
// Canonical read path for "what format/scale does this shot render at?".
// Honors the new renderFormat/renderScale first, then migrates the legacy
// renderQuality / renderMode fields so older shots keep rendering correctly
// after an app upgrade.
const VALID_FORMATS = ['mp4', 'prores_422', 'prores_4444'];
const VALID_SCALES  = [0.25, 0.5, 0.75, 1.0];

const FORMAT_FILENAME_TOKEN = {
    'mp4':         'mp4',
    'prores_422':  '422',
    'prores_4444': '4444',
};
const FORMAT_EXT = {
    'mp4':         '.mp4',
    'prores_422':  '.mov',
    'prores_4444': '.mov',
};

function resolveJobFormat(job) {
    if (job && VALID_FORMATS.includes(job.renderFormat)) return job.renderFormat;
    if (job && job.renderQuality === 'superfast') return 'mp4';
    if (job && job.renderQuality === 'fast')      return 'prores_422';
    if (job && job.renderQuality === 'final')     return 'prores_4444';
    if (job && job.renderMode === 'fast')         return 'prores_422';
    return 'prores_4444';
}

function resolveJobScale(job) {
    if (job && typeof job.renderScale === 'number') {
        let best = 1.0, bestD = 99;
        for (const s of VALID_SCALES) {
            const d = Math.abs(s - job.renderScale);
            if (d < bestD) { bestD = d; best = s; }
        }
        return best;
    }
    if (job && (job.renderQuality === 'superfast' || job.renderQuality === 'fast')) return 0.5;
    if (job && job.renderMode === 'fast') return 0.5;
    return 1.0;
}

// ---- Master / preview discovery + quality tiering --------------------------
const FORMAT_BY_TOKEN = { mp4: 'mp4', '422': 'prores_422', '4444': 'prores_4444' };

function findMaster(vDir) {
    const legacy = path.join(vDir, 'render.mov');
    if (fs.existsSync(legacy)) return legacy;
    try {
        const names = fs.readdirSync(vDir);
        const mov = names.find(n => n.toLowerCase().endsWith('.mov'));
        if (mov) return path.join(vDir, mov);
        const mp4 = names.find(n => n.toLowerCase().endsWith('.mp4')
                                  && n.toLowerCase() !== 'preview.mp4');
        if (mp4) return path.join(vDir, mp4);
        return null;
    } catch { return null; }
}

function specFromMaster(masterAbs) {
    const def = { format: 'prores_4444', scale: 1.0, quality: 'final' };
    if (!masterAbs) return def;
    const base = path.basename(masterAbs).replace(/\.[^.]+$/, '');
    const m = base.match(/_(mp4|422|4444)_s(\d{2,3})$/i);
    if (m) {
        const fmt   = FORMAT_BY_TOKEN[m[1].toLowerCase()];
        const scale = Math.max(0.01, Math.min(1.0, parseInt(m[2], 10) / 100));
        return { format: fmt, scale, quality: qualityBucket(fmt, scale) };
    }
    if (/_superfast$/i.test(base)) return { format: 'mp4',         scale: 0.5, quality: 'superfast' };
    if (/_fast$/i.test(base))      return { format: 'prores_422',  scale: 0.5, quality: 'fast' };
    return def;
}

function qualityBucket(format, scale) {
    if (format === 'mp4') return 'superfast';
    if (format === 'prores_422') return 'fast';
    return (scale >= 0.999) ? 'final' : 'fast';
}

// Scale-priority tier used for badges and Resolve clip colors.
function qualityTier(format, scale) {
    if (scale < 0.999) return 'draft';
    if (format === 'prores_4444') return 'final';
    if (format === 'prores_422')  return 'high';
    return 'preview';
}

function isFinalMaster(masterAbs) {
    const s = specFromMaster(masterAbs);
    return qualityTier(s.format, s.scale) === 'final';
}
function isNonFinalMaster(masterAbs) { return !isFinalMaster(masterAbs); }

// ---- Version enumeration + reconcile --------------------------------------
function listVersions(shotDir) {
    const renders = path.join(shotDir, 'renders');
    if (!fs.existsSync(renders)) return [];
    return fs.readdirSync(renders).filter(n => /^v\d+$/.test(n)).sort().map(v => {
        const vDir = path.join(renders, v);
        const webm = path.join(vDir, 'preview.webm');
        const mp4  = path.join(vDir, 'preview.mp4');
        const master = findMaster(vDir);
        const preview = fs.existsSync(webm) ? webm : (fs.existsSync(mp4) ? mp4 : null);
        const spec = specFromMaster(master);
        return {
            name: v,
            dir: vDir,
            preview,
            master,
            masterBasename: master ? path.basename(master) : null,
            hasMaster: !!master,
            isFast: !isFinalMaster(master),
            quality: spec.quality,
            format:  spec.format,
            scale:   spec.scale,
            tier:    qualityTier(spec.format, spec.scale),
        };
    });
}

// If finalVersion / activeVersion point at a vNN that's no longer on disk,
// silently clear them. Returns the (possibly mutated) job so hot-path callers
// skip a second read+parse of job.json.
function reconcileFinalVersion(shotDir, versions) {
    const job = readJob(shotDir);
    if (!job) return null;
    let dirty = false;
    if (job.finalVersion && !(versions || []).some(v => v.name === job.finalVersion)) {
        delete job.finalVersion; dirty = true;
    }
    if (job.activeVersion && !(versions || []).some(v => v.name === job.activeVersion)) {
        delete job.activeVersion; dirty = true;
    }
    if (dirty) writeJob(shotDir, job);
    return job;
}

// ---- Traffic-light sanity --------------------------------------------------
function computeSanity(shotDir, job) {
    if (!shotDir || !fs.existsSync(shotDir)) {
        return { level: 'red', reasons: ['shot folder missing'] };
    }
    if (!job) {
        return { level: 'red', reasons: ['job.json missing or invalid'] };
    }
    const origin = job.origin || 'resolve';
    const hasRef = fs.existsSync(path.join(shotDir, 'source', 'reference.mp4'))
                || fs.existsSync(path.join(shotDir, 'source', 'reference.mov'));
    if (origin !== 'ae' && !hasRef) {
        return { level: 'red', reasons: ['reference file missing'] };
    }
    const reasons = [];
    const aepPath = job.aepPath ? job.aepPath.replace(/\//g, '\\') : null;
    const aepExists = !!(aepPath && fs.existsSync(aepPath));
    if (!aepExists) reasons.push('AE project file not yet created');
    if (reasons.length) return { level: 'yellow', reasons };
    return { level: 'green', reasons: [] };
}

module.exports = {
    atomicWrite,
    atomicWriteJSON,
    readJob,
    writeJob,
    withJob,
    jobPathOf,
    // format resolution
    VALID_FORMATS, VALID_SCALES,
    FORMAT_FILENAME_TOKEN, FORMAT_EXT,
    resolveJobFormat, resolveJobScale,
    // master/version helpers
    findMaster, specFromMaster,
    qualityBucket, qualityTier,
    isFinalMaster, isNonFinalMaster,
    listVersions, reconcileFinalVersion,
    // sanity
    computeSanity,
};
