// main.js — Electron main process for Roundtrip.
//
// The bulk of pure helpers has been moved into lib/* (job.js, projects.js,
// spawn.js). What lives here is the slice that genuinely needs main-process
// state: mutable config (PROJECTS_DIR, AE_EXE, PYTHON_EXE_NOCONSOLE — the
// wizard can change these at runtime), cross-tick watchers (currentProject,
// currentShot, lastKnownShotsByProject), the status-strip emitter, and the
// ~55 IPC handlers that expose the whole thing to the renderer.
//
// Persistence rules (enforced via lib/job.js):
//   * Every write to job.json / settings.json / renderjob.json goes through
//     atomicWrite so a crash or power loss always leaves either the old file
//     or the new file on disk — never a half-written one.
//   * IPC handlers that read-modify-write a job use withJob(dir, mutator) so
//     the read/write/error handling is centralized.
//   * Destructive filesystem operations pass through assertInProjects() so
//     user-controlled paths can't escape the projects root.

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { readConfig, writeConfig, defaultConfig } = require('./lib/config');
const detect = require('./lib/detect');
const {
    atomicWrite, atomicWriteJSON,
    readJob, writeJob, withJob,
    VALID_FORMATS, VALID_SCALES,
    FORMAT_FILENAME_TOKEN, FORMAT_EXT,
    resolveJobFormat, resolveJobScale,
    findMaster, specFromMaster,
    qualityTier, isFinalMaster, isNonFinalMaster,
    listVersions, reconcileFinalVersion,
    computeSanity,
} = require('./lib/job');
const P = require('./lib/projects');
const SP = require('./lib/spawn');
const M = require('./lib/manifest');
const { memoizeByMtime } = require('./lib/memoize');
// v0.5.0 — Vault MVP. See lib/asset.js (VAULT_ASSET_SCHEMA), lib/vault.js
// (VAULT_LAYOUT), lib/vault_pipeline.js (VAULT_PIPELINE).
const VAULT_ASSET = require('./lib/asset');
const VAULT      = require('./lib/vault');
const VAULT_PIPE = require('./lib/vault_pipeline');
const VAULT_FOLDERS = require('./lib/vault_folders');   // dev24
const SHOT_TRASH = require('./lib/shot_trash');         // dev35
const WATCH = require('./lib/watch');                   // dev43
const ARRIVAL = require('./lib/arrival_policy');        // dev44

// Memoized variants for the 3s rail tick and jump palette: both walk every
// shot × every project, so skipping unchanged JSON reads is a clear win.
// Keyed on the job.json mtime — atomic writes always bump mtime, so the
// cache invalidates automatically whenever withJob/atomicWriteJSON runs.
// NOTE: these memos are for *read-only summary* use. Code paths that then
// mutate the returned object (e.g. withJob-style read-modify-write) must
// keep using the un-memoized readJob/writeJob pair from ./lib/job.
const readJobMemo = memoizeByMtime(readJob,
    (shotDir) => path.join(shotDir, 'source', 'job.json'));

const sleep = SP.sleep;

// ---- Config ----------------------------------------------------------------
// ROOT = app install dir (where scripts/ lives). Stays as the app source tree
// in dev; in packaged builds, electron-builder puts scripts/ + vendor/ under
// process.resourcesPath via the `extraResources` config.
const ROOT = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..');

// `let` because the Setup Wizard can change them at runtime (applyConfig
// overwrites these when config.json is saved). Module-load values act as
// safe fallbacks before the wizard has run.
let PROJECTS_DIR = app.isPackaged
    ? path.join(app.getPath('userData'), 'projects')
    : path.join(ROOT, 'projects');
let AE_EXE = process.env.AFTERFX_EXE
    || 'C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe';
const CREATE_JSX = path.join(ROOT, 'scripts', 'ae', 'create_comp.jsx');
const RENDER_JSX = path.join(ROOT, 'scripts', 'ae', 'render_version.jsx');
const VAULT_COLLECT_JSX = path.join(ROOT, 'scripts', 'ae', 'vault_collect.jsx');
const VAULT_CLIP_JSX    = path.join(ROOT, 'scripts', 'ae', 'vault_clip.jsx');
const IMPORT_CLIPS_JSX  = path.join(ROOT, 'scripts', 'ae', 'import_clips.jsx');
const IMPORT_ASSET_JSX  = path.join(ROOT, 'scripts', 'ae', 'import_asset.jsx');
const PROBE_JSX  = path.join(ROOT, 'scripts', 'ae', 'probe.jsx');
const PROBE_COMP_JSX = path.join(ROOT, 'scripts', 'ae', 'probe_comp.jsx');
const RELINK_PY  = path.join(ROOT, 'scripts', 'resolve', 'relink_latest_render.py');
const RESOLVE_SCRIPTS_SRC = path.join(ROOT, 'scripts', 'resolve');
const RESOLVE_SCRIPTS_DST = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Blackmagic Design', 'DaVinci Resolve',
                'Support', 'Fusion', 'Scripts', 'Utility')
    : null;

// Resolve scripting API locations. We resolve via detect.detectResolveScripting()
// which walks a candidate list (env override → ProgramData → Program Files →
// APPDATA) and picks the first one where Modules/DaVinciResolveScript.py is
// actually readable. Falling back to the ProgramData default was poison for
// testers whose Resolve install doesn't expose the SDK at that path.
// dev5 regression — surfaced by "No module named 'DaVinciResolveScript'".
const _RESOLVE_SCRIPTING = detect.detectResolveScripting();
const RESOLVE_SCRIPT_API = _RESOLVE_SCRIPTING.apiPath;
const RESOLVE_SCRIPT_LIB = process.env.RESOLVE_SCRIPT_LIB
    || 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll';
const RESOLVE_SCRIPT_MODULE_OK = _RESOLVE_SCRIPTING.moduleExists;

let PYTHON_EXE = process.env.PYTHON_EXE || 'py';
let PYTHON_EXE_NOCONSOLE = PYTHON_EXE;
// v0.4.9-rc4 — track detected Python version + in-range flag. The relink
// dispatch path checks PYTHON_INRANGE and refuses to spawn if false, with a
// precise status-strip error. Set by resolvePythonPath() at startup.
let PYTHON_VERSION = null;   // { major, minor, patch, full } or null
let PYTHON_INRANGE = true;   // optimistic default for env-overridden paths

function resolvePythonPath() {
    if (process.env.PYTHON_EXE) {
        // Env override is user intent — trust it, but still probe for the
        // version so we can surface a warning if it's out of range.
        const v = detect.parsePythonVersionString(
            (() => { try {
                return require('child_process').execFileSync(
                    process.env.PYTHON_EXE, ['--version'],
                    { timeout: 2000, windowsHide: true, encoding: 'utf8',
                      stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (_) { return ''; } })()
        );
        return {
            path: process.env.PYTHON_EXE, source: 'env',
            version: v, inRange: detect.isPythonInSupportedRange(v),
        };
    }
    // dev60 — pass RESOLVE_SCRIPT_LIB so detectPython can pick the right
    // vendored Python (3.10 for Resolve <21, 3.13 for Resolve 21+) by
    // reading fusionscript.dll's import strings.
    const r = detect.detectPython(ROOT, RESOLVE_SCRIPT_LIB);
    if (r && r.path) return r;
    return { path: 'py', source: 'fallback', version: null, inRange: false };
}

const _ffmpegResolved = SP.resolveFFmpegPath();
let FFMPEG_EXE = _ffmpegResolved.path;
if (_ffmpegResolved.verified) {
    console.log(`[preview] ffmpeg found at ${FFMPEG_EXE}`);
} else {
    console.log('[preview] ffmpeg not found at default locations — will try PATH; previews stay as mp4 if unavailable');
}

// Pointer / sentinel files. The JSX side reads these when $.arguments is empty
// (the common case with `AfterFX.exe -r <jsx>`). Separate comp-probe sentinel
// from the readiness probe so a concurrent quickProbe() can't race-delete it.
const TEMP_DIR = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
const JOB_POINTER         = path.join(TEMP_DIR, 'roundtrip_current_job.txt');
const RENDER_POINTER      = path.join(TEMP_DIR, 'roundtrip_current_renderjob.txt');
const PROBE_SENTINEL      = path.join(TEMP_DIR, 'ae_ready_probe.txt');
const COMP_PROBE_SENTINEL = path.join(TEMP_DIR, 'roundtrip_comp_probe.json');

// Small forwarding-slash helper for paths that cross into JSX / Python land
// (both prefer forward slashes; ExtendScript File() normalizes either way
// but forward slashes are portable across our pointer-file round-trips).
const fwd = p => (p || '').replace(/\\/g, '/');

// ---- Settings persistence --------------------------------------------------
// settings.json lives in userData (not next to main.js) so it survives app
// updates and is writable in packaged builds. Now routed through
// lib/manifest.js so the same atomic-write + schema-version discipline
// we apply to project.json / asset.json applies here too. `SETTINGS_SCHEMA`
// is the current target version; bump + add a migration step if a future
// settings field needs reshaping rather than additive defaulting.
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const SETTINGS_SCHEMA = M.CURRENT_MANIFEST_SCHEMAS.settings;
const SETTINGS_MIGRATIONS = [
    // [0] v0 (legacy / unversioned) → v1: no-op. Current shape is additive,
    // so every absent field already defaults cleanly at the call site.
    // Leaving this slot populated so the migration pipeline runs and stamps
    // schemaVersion:1 into pre-0.4.9 settings.json files on first read.
    (_obj) => { /* no structural change */ },
];
function readSettings() {
    return M.readManifest(SETTINGS_PATH, {
        defaultValue:  {},
        targetVersion: SETTINGS_SCHEMA,
        migrations:    SETTINGS_MIGRATIONS,
    });
}
function writeSettings(s) {
    M.writeManifest(SETTINGS_PATH, s, { targetVersion: SETTINGS_SCHEMA });
}

// ---- Runtime state ---------------------------------------------------------
// currentProject is persisted to settings.json. currentShot is in-memory only
// — on relaunch we pick the newest shot via newestShotIn() rather than trying
// to restore a shot selection that may have been deleted.
let currentProject = null;
let currentShot = null;
let userSelectedShot = false;
let userSelectedProject = false;
let lastKnownShots = [];
// Cross-project watcher seed (null = unseeded — skip the "new arrivals" fire
// on first call so existing shots aren't treated as new).
let lastKnownShotsByProject = null;

// dev44 — cross-project arrival pending the user's decision. Set when
// detectNewShotAcrossProjects finds a new shot in a project DIFFERENT
// from the user's current one, while the user has a shot selected
// ("they're working — don't yank them"). Cleared by:
//   * the user clicking Switch / Dismiss in the banner
//   * the user picking a project on their own (project:select)
//   * the user picking a shot on their own (shot:select)
//
// _broadcastedArrivalKey dedupes the broadcast so successive shot:info
// calls (which now fire on every fs.watch push from dev43) don't
// re-emit the same banner event over and over. The same key is
// cleared on dismiss/switch so a NEW arrival re-broadcasts cleanly.
let _pendingArrival = null;
let _broadcastedArrivalKey = null;

// ---- State-backed helpers (need currentProject/currentShot) ---------------
function projectDir() {
    return currentProject ? path.join(PROJECTS_DIR, currentProject) : null;
}
function shotDir() {
    return currentShot ? path.join(projectDir(), currentShot) : null;
}
function listShots() { return P.listShotsIn(projectDir()); }
function newestShot() { return P.newestShotIn(projectDir()); }
function listProjects() { return P.listProjects(PROJECTS_DIR); }
function assertInProjects(p) { return P.assertInProjects(PROJECTS_DIR, p); }

function seedCurrentProject() {
    const settingsName = readSettings().currentProject;
    const existing = listProjects();
    if (settingsName && existing.includes(settingsName)) currentProject = settingsName;
    else if (existing.length) currentProject = existing[0];
    else currentProject = null;
}

// ---- Cross-tick watchers ---------------------------------------------------
// Compare the current per-project shot map against lastKnownShotsByProject and
// return the newest brand-new shot (by job.json mtime) as { project, shot }.
// Returns null if nothing new. Side-effect: always updates the snapshot so
// each new arrival is reported at most once.
function detectNewShotAcrossProjects() {
    const now = P.listShotsAllProjects(PROJECTS_DIR);
    if (lastKnownShotsByProject === null) {
        lastKnownShotsByProject = now;
        return null;
    }
    let best = null;
    for (const p of Object.keys(now)) {
        const prev = lastKnownShotsByProject[p] || [];
        for (const s of now[p]) {
            if (prev.includes(s)) continue;
            const jp = path.join(PROJECTS_DIR, p, s, 'source', 'job.json');
            let mtime = Date.now();
            try { if (fs.existsSync(jp)) mtime = fs.statSync(jp).mtimeMs; } catch (_) {}
            if (!best || mtime > best.mtime) best = { project: p, shot: s, mtime };
        }
    }
    lastKnownShotsByProject = now;
    return best;
}

// Warn banner scanner: count shots in the current project whose activeVersion
// is a non-final render. FINAL override — if the active version IS the one
// explicitly flagged FINAL, suppress the warning (user-sanctioned exception).
function scanFastActiveShots(shotsList) {
    const out = { count: 0, shots: [] };
    const pDir = projectDir();
    if (!pDir) return out;
    const shots = shotsList || listShots();
    for (const s of shots) {
        const sDir = path.join(pDir, s);
        const job = readJob(sDir);
        if (!job || !job.activeVersion) continue;
        if (job.finalVersion && job.activeVersion === job.finalVersion) continue;
        const vDir = path.join(sDir, 'renders', job.activeVersion);
        if (!fs.existsSync(vDir)) continue;
        if (isNonFinalMaster(findMaster(vDir))) {
            out.count += 1;
            out.shots.push(s);
        }
    }
    return out;
}

// ---- AE-first shot construction -------------------------------------------
// Build the job.json payload for an AE-origin shot from a probe_comp result.
// markIn/markOut come from the comp's work area so AE users get the same
// "active range" semantics as Resolve users do via I / O marks.
function buildAEJob(probe, projectName, shotName) {
    const fps = Number(probe.fps) || 24;
    const waStart = Number(probe.workAreaStart) || 0;
    const waDur   = Number(probe.workAreaDuration) || Number(probe.duration) || 0;
    const markIn  = Math.round(waStart * fps);
    const markOut = Math.round((waStart + waDur) * fps);
    return {
        origin:   'ae',
        project:  projectName,
        shot:     shotName,
        compName: probe.name,
        width:    probe.width,
        height:   probe.height,
        fps,
        markIn,
        markOut:  Math.max(markIn + 1, markOut),
        aepPath:  probe.aepPath ? fwd(probe.aepPath) : null,
        resolveTrackIndex: 2,
    };
}

// Create the standard shot folder layout atomically via a stage-dir: we
// build everything inside `<projectDir>/.tmp_<shot>` and then fs.renameSync
// it into place so a crash halfway through never leaves a half-constructed
// shot dir sitting in the projects tree. If rename fails we clean up the
// stage so the next retry starts fresh.
function finalizeAEShotStaged(projectName, shotName, job) {
    const projDir    = path.join(PROJECTS_DIR, projectName);
    const finalDir   = path.join(projDir, shotName);
    const stageDir   = path.join(projDir, '.tmp_' + shotName);
    if (fs.existsSync(finalDir)) {
        throw new Error('Shot already exists: ' + shotName);
    }
    // Clean up any leftover stage from a prior crashed attempt.
    if (fs.existsSync(stageDir)) P.rmDirRetry(stageDir);

    try {
        fs.mkdirSync(path.join(stageDir, 'source'),  { recursive: true });
        fs.mkdirSync(path.join(stageDir, 'renders'), { recursive: true });
        atomicWriteJSON(path.join(stageDir, 'source', 'job.json'), job);
        // Atomic commit: rename is atomic on NTFS within the same volume.
        fs.renameSync(stageDir, finalDir);
    } catch (e) {
        try { if (fs.existsSync(stageDir)) P.rmDirRetry(stageDir); } catch (_) {}
        throw e;
    }

    currentProject = projectName;
    currentShot    = shotName;
    userSelectedShot = true;
    userSelectedProject = true;
    lastKnownShots = [];
    writeSettings(Object.assign(readSettings(), { currentProject }));
    return finalDir;
}

// ---- IPC: shot info (hot path) --------------------------------------------
ipcMain.handle('shot:info', () => {
    // dev44 — cross-project arrival routing. Pre-dev44 this block silently
    // mutated currentProject/currentShot whenever a new shot was detected
    // in any project (gated only by user-selected flags). That broke trust
    // on multi-project installs: a user mid-edit could find themselves
    // teleported into another project because someone's export_range.py
    // ran 12s earlier.
    //
    // New rule (see lib/arrival_policy.js):
    //   * 'auto-jump'  — true cold start (no shot selected). Pick it.
    //   * 'cross-project-banner' — user IS on a shot, arrival is in a
    //                    different project. Broadcast; never silently
    //                    switch. Renderer's banner offers Switch / Dismiss.
    //   * 'intra-project' — falls through to the existing newest-on-arrival
    //                    rule below (still gated by userSelectedShot).
    //   * 'none'       — no arrival, no-op.
    const newArrival = detectNewShotAcrossProjects();
    const decision = ARRIVAL.classifyArrival({
        newArrival,
        currentProject,
        currentShot,
    });
    if (decision === 'auto-jump') {
        if (newArrival.project !== currentProject) {
            currentProject = newArrival.project;
            writeSettings(Object.assign(readSettings(), { currentProject }));
            lastKnownShots = [];
        }
        currentShot = newArrival.shot;
        // Cold-start auto-jump satisfies the user. Don't broadcast a
        // banner for the SAME shot a tick later.
        _pendingArrival = null;
        _broadcastedArrivalKey = null;
    } else if (decision === 'cross-project-banner') {
        const key = newArrival.project + '/' + newArrival.shot;
        _pendingArrival = { project: newArrival.project, shot: newArrival.shot };
        if (key !== _broadcastedArrivalKey) {
            _broadcastedArrivalKey = key;
            broadcastCrossProjectArrival(_pendingArrival);
        }
    }

    // Intra-project auto-selection: pick newest on missing/new arrival, never
    // override a user-pinned selection.
    const shotsNow = listShots();
    const appeared = shotsNow.filter(s => !lastKnownShots.includes(s));
    const currentStillExists = currentShot && shotsNow.includes(currentShot);
    if (!currentStillExists)                                currentShot = newestShot();
    else if (!userSelectedShot && appeared.length > 0)      currentShot = newestShot();
    lastKnownShots = shotsNow;

    const dir = shotDir();
    const jobPath = dir ? path.join(dir, 'source', 'job.json') : null;
    const versions = dir ? listVersions(dir) : [];
    const job = dir ? reconcileFinalVersion(dir, versions) : null;

    // v0.4.8 — lazy-seed render defaults from settings.json the first time
    // we see a shot that doesn't yet have explicit renderFormat / renderScale.
    // Fulfils the spec: "new shots must inherit last_codec/last_quality
    // instead of defaulting to 50%". We seed into job.json via withJob so
    // the persisted shape matches what later reads expect and the UI
    // doesn't flicker between the inherited value and a hardcoded default
    // on the next refresh.
    if (dir && job) {
        const s = readSettings();
        let needsSeed = false;
        const patch = {};
        if (!job.renderFormat && s.lastRenderFormat && VALID_FORMATS.includes(s.lastRenderFormat)) {
            patch.renderFormat = s.lastRenderFormat;
            needsSeed = true;
        }
        if (typeof job.renderScale !== 'number' && typeof s.lastRenderScale === 'number') {
            patch.renderScale = s.lastRenderScale;
            needsSeed = true;
        }
        if (needsSeed) {
            withJob(dir, j => { Object.assign(j, patch); return patch; });
            Object.assign(job, patch);
        }
    }

    return {
        project: currentProject,
        projects: listProjects(),
        shot: currentShot,
        shots: shotsNow,
        shotDir: dir,
        hasJob: !!(jobPath && fs.existsSync(jobPath)),
        hasReference: !!dir && (fs.existsSync(path.join(dir, 'source', 'reference.mp4'))
                   || fs.existsSync(path.join(dir, 'source', 'reference.mov'))),
        trackIndex: (job && job.resolveTrackIndex) || 2,
        aepPath: job ? job.aepPath : null,
        aepExists: !!(job && job.aepPath && fs.existsSync(job.aepPath.replace(/\//g, '\\'))),
        origin: (job && job.origin) || 'resolve',
        hasResolveLink: !!(job && job.resolveMediaPoolItemId),
        aeRunning: SP.isAERunning(),
        animationName: (job && job.name) ? job.name : '',
        label: (job && typeof job.label === 'string') ? job.label : '',
        finalVersion: (job && job.finalVersion) || null,
        activeVersion: (job && job.activeVersion) || null,
        // v0.5.0 — Vault MVP batch-flag. Renderer reads this to render a
        // checkmark on the "Mark for batch vault" overflow entry.
        vaultMarked:   !!(job && job.vaultMarked),
        renderMode: (job && job.renderMode) || 'final',
        renderQuality: (job && job.renderQuality)
            || ((job && job.renderMode === 'fast') ? 'fast' : 'final'),
        renderFormat: resolveJobFormat(job),
        renderScale:  resolveJobScale(job),
        versions,
        fastActive: scanFastActiveShots(shotsNow),
        sanity: computeSanity(dir, job),
    };
});

// ---- IPC: project management ----------------------------------------------
ipcMain.handle('project:list', () =>
    ({ ok: true, projects: listProjects(), current: currentProject }));

// All-projects summary for the vertical rail accordion. Returns every project
// with its shots nested, plus a worst-of-nested sanity level per project.
// Single IPC round-trip for the whole tree.
ipcMain.handle('project:allSummary', () => {
    const projects = listProjects();
    const out = [];
    for (const pName of projects) {
        const pDir = path.join(PROJECTS_DIR, pName);
        if (!fs.existsSync(pDir)) {
            out.push({ name: pName, shots: [], sanity: { level: 'red', reasons: ['project folder missing'] } });
            continue;
        }
        const shotNames = P.listShotsIn(pDir);
        const shots = [];
        let worst = 'green';
        for (const sName of shotNames) {
            const sDir = path.join(pDir, sName);
            const job  = readJobMemo(sDir);
            const san  = computeSanity(sDir, job);
            shots.push({
                name: sName,
                label: (job && typeof job.label === 'string') ? job.label : '',
                origin: (job && job.origin) || 'resolve',
                sanity: san,
            });
            if (san.level === 'red') worst = 'red';
            else if (san.level === 'yellow' && worst !== 'red') worst = 'yellow';
        }
        out.push({ name: pName, shots, sanity: { level: worst, reasons: [] } });
    }
    return { ok: true, projects: out, current: currentProject, currentShot };
});

// Per-shot summary for the Jump Palette. Only runs on palette open — we don't
// want the 3s refresh tick walking every shot in the project on every call.
ipcMain.handle('project:shotsSummary', () => {
    const projDir = projectDir();
    if (!projDir) return { ok: true, shots: [] };
    const names = listShots();
    const out = [];
    for (const name of names) {
        const dir = path.join(projDir, name);
        const job = readJobMemo(dir);
        out.push({
            name,
            label: (job && typeof job.label === 'string') ? job.label : '',
            origin: (job && job.origin) || 'resolve',
            sanity: computeSanity(dir, job),
        });
    }
    return { ok: true, shots: out, current: currentShot };
});

// dev38 — Project overview. Per-shot rows with versions / active / final /
// size / sanity. Triggered by the rail's "Project overview" button + the
// PROJECT_ACTIONS context menu — runs on demand, not on every refresh tick.
// Walks renders/, reads job.json, sums dirSizeBytes per shot. For a 30-shot
// project that's ~30 readdirs + ~30 file-tree walks; fast enough to call
// synchronously per overview open.
ipcMain.handle('project:overview', (_e, projectName) => {
    const name = projectName || currentProject;
    if (!name) return { ok: false, error: 'no project' };
    const pDir = path.join(PROJECTS_DIR, name);
    try { assertInProjects(pDir); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(pDir)) return { ok: false, error: 'project not found' };

    const shotNames = P.listShotsIn(pDir);
    const shots = [];
    let totalBytes = 0;
    for (const sName of shotNames) {
        const sDir = path.join(pDir, sName);
        const job  = readJobMemo(sDir);
        const versions = listVersions(sDir);
        // Reuse the vault's dirSizeBytes — same recursive byte-sum walker
        // we trust on the vault SIZE column. No reason to write a second
        // implementation; cross-module dependency stays narrow (one fn).
        let bytes = 0;
        try { bytes = VAULT.dirSizeBytes(sDir); } catch (_) { bytes = 0; }
        totalBytes += bytes;
        let mtime = null;
        try { mtime = fs.statSync(sDir).mtime.toISOString(); } catch (_) {}

        // dev40 — surface a preview path so the overview cards can render
        // a hover-play tile (vault-style). Prefer the active version's
        // preview; fall back to the newest version that has any preview.
        // Returns null when there's nothing renderable yet — card paints
        // a "no preview" placeholder. Absolute paths only — the renderer
        // wraps them as file:// URLs.
        let previewPath = null;
        const active = (job && job.activeVersion)
            ? versions.find(v => v.name === job.activeVersion)
            : null;
        if (active && active.preview) {
            previewPath = active.preview;
        } else {
            for (let i = versions.length - 1; i >= 0; i--) {
                if (versions[i].preview) { previewPath = versions[i].preview; break; }
            }
        }
        shots.push({
            name:           sName,
            label:          (job && typeof job.label === 'string') ? job.label : '',
            origin:         (job && job.origin) || 'resolve',
            activeVersion:  (job && job.activeVersion) || null,
            finalVersion:   (job && job.finalVersion)  || null,
            versionCount:   versions.length,
            // hasMaster across any version is signal that "something
            // renderable exists" — the dot doesn't go full grey.
            hasAnyMaster:   versions.some(v => v.hasMaster),
            sanity:         computeSanity(sDir, job),
            sizeBytes:      bytes,
            mtime,
            previewPath,            // dev40
        });
    }
    return {
        ok: true,
        project: name,
        shotCount: shots.length,
        totalBytes,
        shots,
        currentShot: (name === currentProject) ? currentShot : null,
    };
});

// ---- Spec Lock (v0.4.9) ---------------------------------------------------
// Read project.json + .spec_mismatch.json for a project. Returns a single
// blob the renderer uses to paint the header badge (locked spec, green /
// red state, optional diffs for the unlock modal).
//
// Never throws across the bridge. Missing project.json => not-locked (green,
// no badge). Missing .spec_mismatch.json => no mismatch pending.
// Both readers route through lib/manifest.js so schema evolution has ONE
// home. project.json is the canonical versioned manifest; the sidecar
// .spec_mismatch.json is transient (written once by export_range.py, wiped
// on unlock/match) so it's an unversioned plain-object read.
const PROJECT_SCHEMA = M.CURRENT_MANIFEST_SCHEMAS.project;
const PROJECT_MIGRATIONS = [
    // [0] legacy/unversioned → v1: no-op. First export_range.py run that
    // wrote lockedSpec did NOT stamp schemaVersion — this migration sets it.
    (_obj) => { /* no structural change; just tag as v1 */ },
];

function readProjectManifest(projName) {
    const pDir  = path.join(PROJECTS_DIR, projName || '');
    const mPath = path.join(pDir, 'project.json');
    return M.readManifest(mPath, {
        defaultValue:  {},
        targetVersion: PROJECT_SCHEMA,
        migrations:    PROJECT_MIGRATIONS,
    });
}

function readSpecMismatch(projName) {
    const pDir = path.join(PROJECTS_DIR, projName || '');
    const sPath = path.join(pDir, '.spec_mismatch.json');
    // defaultValue:null because the renderer distinguishes "no sidecar" (null)
    // from "empty sidecar" (truthy-but-shallow) for the badge-state branch.
    // Transient file, no migrations / schemaVersion.
    const v = M.readManifest(sPath, { defaultValue: null });
    return v || null;
}

ipcMain.handle('project:getSpec', (_e, projName) => {
    const name = projName || currentProject;
    if (!name) return { ok: true, locked: null, mismatch: null };
    const m = readProjectManifest(name);
    return {
        ok: true,
        project: name,
        locked: m.lockedSpec || null,
        lockedAt: m.lockedAt || null,
        lockedBy: m.lockedBy || null,
        mismatch: readSpecMismatch(name),
    };
});

// Unlocking is destructive-adjacent: the next export will overwrite the
// lock with whatever the open Resolve timeline says. Guarded by a native
// confirm dialog on the renderer side; main.js just does the write.
ipcMain.handle('project:unlockSpec', (_e, projName) => {
    const name = projName || currentProject;
    if (!name) return { ok: false, error: 'no project selected' };
    const pDir = path.join(PROJECTS_DIR, name);
    if (!fs.existsSync(pDir)) return { ok: false, error: 'project folder missing' };
    const mPath = path.join(pDir, 'project.json');
    const sPath = path.join(pDir, '.spec_mismatch.json');
    try {
        const m = readProjectManifest(name);
        delete m.lockedSpec;
        delete m.lockedAt;
        delete m.lockedBy;
        // Keep schemaVersion / any other future fields so we don't nuke the
        // whole manifest when a future version adds more project-level state.
        // writeManifest re-stamps schemaVersion if absent; noop if present.
        if (!M.writeManifest(mPath, m, { targetVersion: PROJECT_SCHEMA })) {
            return { ok: false, error: 'failed to write project.json' };
        }
    } catch (e) {
        return { ok: false, error: 'failed to write project.json: ' + e.message };
    }
    try { if (fs.existsSync(sPath)) fs.unlinkSync(sPath); } catch {}
    try { emitStatus('Spec unlocked — next export will set a new lock.', 'info'); } catch {}
    return { ok: true };
});

// v0.4.9-rc5 — Spec Lock: "Accept new spec" path for the mismatch modal.
// Promotes the sidecar's currentSpec into project.json.lockedSpec and wipes
// the sidecar. End result: the project is now locked to whatever the tester
// was exporting at, and the red badge goes away. Equivalent to "unlock +
// next export re-locks" but skips the round-trip through Resolve (which
// matters when the user just wants to bless the drift without re-exporting).
ipcMain.handle('project:applyNewSpec', (_e, projName) => {
    const name = projName || currentProject;
    if (!name) return { ok: false, error: 'no project selected' };
    const pDir  = path.join(PROJECTS_DIR, name);
    if (!fs.existsSync(pDir)) return { ok: false, error: 'project folder missing' };
    const mPath = path.join(pDir, 'project.json');
    const sPath = path.join(pDir, '.spec_mismatch.json');

    const mismatch = readSpecMismatch(name);
    if (!mismatch || !mismatch.currentSpec) {
        return { ok: false, error: 'no pending spec mismatch for this project' };
    }
    // Shallow-validate the currentSpec shape. We refuse garbage rather than
    // silently writing a busted lock — the sidecar is generated by Python
    // so a missing field here means the Python side changed contract.
    const ns = mismatch.currentSpec;
    if (typeof ns.fps !== 'number' || typeof ns.width !== 'number'
        || typeof ns.height !== 'number') {
        return { ok: false, error: 'sidecar currentSpec is missing required fields' };
    }
    try {
        const m = readProjectManifest(name);
        m.lockedSpec = {
            fps:    ns.fps,
            width:  ns.width,
            height: ns.height,
            // colorScienceMode is recorded but not enforced — mirror the
            // Python _build_timeline_spec contract so a future version that
            // starts enforcing it doesn't need a schema bump.
            colorScienceMode: ns.colorScienceMode != null ? ns.colorScienceMode : null,
        };
        m.lockedAt = new Date().toISOString();
        m.lockedBy = (mismatch.attemptedShot || m.lockedBy || 'app:acceptNewSpec');
        if (!M.writeManifest(mPath, m, { targetVersion: PROJECT_SCHEMA })) {
            return { ok: false, error: 'failed to write project.json' };
        }
    } catch (e) {
        return { ok: false, error: 'failed to write project.json: ' + e.message };
    }
    try { if (fs.existsSync(sPath)) fs.unlinkSync(sPath); } catch {}
    try { emitStatus('New spec accepted — project relocked.', 'ok'); } catch {}
    return { ok: true };
});

// v0.4.9-rc5 — Spec Lock: "Keep locked spec" path for the mismatch modal.
// Drops the sidecar without touching the lock. The red badge disappears;
// the lock value is unchanged, so the NEXT mismatched export will prompt
// again in Resolve. Use case: user fixed the timeline or decided the drift
// was a one-off render and doesn't want the persistent UI reminder.
ipcMain.handle('project:clearMismatch', (_e, projName) => {
    const name = projName || currentProject;
    if (!name) return { ok: false, error: 'no project selected' };
    const pDir  = path.join(PROJECTS_DIR, name);
    if (!fs.existsSync(pDir)) return { ok: false, error: 'project folder missing' };
    const sPath = path.join(pDir, '.spec_mismatch.json');
    let dropped = false;
    try {
        if (fs.existsSync(sPath)) { fs.unlinkSync(sPath); dropped = true; }
    } catch (e) {
        return { ok: false, error: 'failed to remove .spec_mismatch.json: ' + e.message };
    }
    if (dropped) {
        try { emitStatus('Mismatch flag cleared — lock kept as-is.', 'info'); } catch {}
    }
    return { ok: true, dropped };
});

ipcMain.handle('project:select', (_e, name) => {
    if (!listProjects().includes(name)) return { ok: false, error: 'no such project' };
    currentProject = name;
    currentShot = null;
    userSelectedShot = false;
    userSelectedProject = true;
    lastKnownShots = [];
    writeSettings(Object.assign(readSettings(), { currentProject }));
    // dev44 — selecting a project counts as "the user noticed and
    // handled the arrival" for any pending banner. Clearing here also
    // covers the banner's [Switch] handler, which calls project:select
    // before shot:select.
    _pendingArrival = null;
    _broadcastedArrivalKey = null;
    return { ok: true, project: currentProject };
});

ipcMain.handle('project:create', (_e, rawName) => {
    const clean = P.sanitizeName(rawName);
    if (!clean) return { ok: false, error: 'empty or invalid name' };
    const target = path.join(PROJECTS_DIR, clean);
    if (fs.existsSync(target)) return { ok: false, error: 'already exists' };
    fs.mkdirSync(target, { recursive: true });
    currentProject = clean;
    currentShot = null;
    userSelectedShot = false;
    userSelectedProject = true;
    lastKnownShots = [];
    writeSettings(Object.assign(readSettings(), { currentProject }));
    return { ok: true, project: currentProject };
});

ipcMain.handle('project:delete', (_e, name) => {
    if (!name) return { ok: false, error: 'name required' };
    const target = path.join(PROJECTS_DIR, name);
    try { assertInProjects(target); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(target)) return { ok: false, error: 'not found' };
    if (!P.rmDirRetry(target)) return { ok: false, error: 'could not fully delete (file in use?)' };
    if (name === currentProject) {
        const remaining = listProjects();
        currentProject = remaining[0] || null;
        currentShot = null;
        userSelectedShot = false;
        lastKnownShots = [];
        writeSettings(Object.assign(readSettings(), { currentProject }));
    }
    return { ok: true, project: currentProject };
});

// ---- IPC: shot management --------------------------------------------------
ipcMain.handle('shot:select', (_e, shotName) => {
    if (listShots().includes(shotName)) {
        currentShot = shotName;
        userSelectedShot = true;
    }
    // dev44 — explicit shot pick clears any pending banner. If they
    // selected the very shot the banner pointed to (via [Switch] in
    // the renderer), this is the natural place to drop it.
    _pendingArrival = null;
    _broadcastedArrivalKey = null;
    return { ok: true, shot: currentShot };
});

// dev44 — banner buttons. `crossProject:dismiss` clears the pending
// arrival without changing selection (user keeps working). `:switch`
// is renderer-side only — the renderer calls project:select +
// shot:select sequentially, both of which clear pending state above.
ipcMain.handle('crossProject:dismiss', () => {
    _pendingArrival = null;
    _broadcastedArrivalKey = null;
    return { ok: true };
});

// Read-only accessor so the renderer can rehydrate the banner on
// boot if a cross-project arrival was broadcast before the renderer
// finished mounting (race: watcher fires within the first 50ms of
// app boot). Returns the same shape the broadcast does, or null.
ipcMain.handle('crossProject:peek', () => {
    return _pendingArrival ? Object.assign({}, _pendingArrival) : null;
});

ipcMain.handle('shot:setTrack', (_e, trackIndex) =>
    withJob(shotDir(), job => {
        job.resolveTrackIndex = parseInt(trackIndex, 10) || 2;
        return { trackIndex: job.resolveTrackIndex };
    }));

// dev59 — setName ALSO mirrors into job.label so the tag the user types
// in the render-settings panel propagates everywhere the shot is named:
// shot header, project rail, breadcrumb. Mirroring is conditional so
// power users who explicitly renamed via the header double-click don't
// get their custom label overwritten:
//   * job.label empty            → mirror (first-time tag)
//   * job.label === prior name   → mirror (label was previously auto-set
//                                   from setName and the user is just
//                                   editing the same field)
//   * job.label is anything else → preserve (user has set a freeform
//                                   label that diverges from the tag,
//                                   e.g. spaces / punctuation / a name
//                                   that's longer than sanitizeName
//                                   would allow). To re-link them the
//                                   user can clear the label via the
//                                   header inline-edit and the next
//                                   setName will mirror again.
ipcMain.handle('shot:setName', (_e, rawName) =>
    withJob(shotDir(), job => {
        const prevName  = (typeof job.name  === 'string') ? job.name  : '';
        const prevLabel = (typeof job.label === 'string') ? job.label : '';
        const clean = P.sanitizeName(rawName);
        if (clean) job.name = clean; else delete job.name;

        // Mirror policy described above.
        const labelWasMirrored = (!prevLabel) || (prevLabel === prevName);
        if (labelWasMirrored) {
            // Length-cap to match shot:setLabel's contract so downstream
            // renderers see a consistent value regardless of which IPC
            // handler set it.
            const mirroredLabel = clean ? clean.slice(0, 80) : '';
            if (mirroredLabel) job.label = mirroredLabel; else delete job.label;
        }

        return {
            name:  clean,
            label: (typeof job.label === 'string') ? job.label : '',
        };
    }));

// label is distinct from setName: pure display text, trimmed + length-capped
// but not sanitized (spaces / case / punctuation preserved). Never touches
// filenames.
ipcMain.handle('shot:setLabel', (_e, rawLabel) =>
    withJob(shotDir(), job => {
        const clean = String(rawLabel || '').trim().slice(0, 80);
        if (clean) job.label = clean; else delete job.label;
        return { label: clean };
    }));

// v0.5.0 — Vault tagging. Per-shot boolean flag; batch "Vault Project" iterates
// shots where job.vaultMarked === true. AE-side comp-marker convention
// (CHIRAL:VAULT) can later flip the same flag without schema changes.
ipcMain.handle('shot:setVaultMarked', (_e, marked) =>
    withJob(shotDir(), job => {
        job.vaultMarked = !!marked;
        return { vaultMarked: job.vaultMarked };
    }));

ipcMain.handle('shot:setRenderFormat', (_e, format) =>
    withJob(shotDir(), job => {
        const clean = VALID_FORMATS.includes(format) ? format : 'prores_4444';
        job.renderFormat = clean;
        job.renderQuality = (clean === 'mp4') ? 'superfast'
                          : (clean === 'prores_422') ? 'fast' : 'final';
        job.renderMode    = (clean === 'prores_4444') ? 'final' : 'fast';
        // v0.4.8 — preserve the user's explicit renderScale across a format
        // switch. The prior code left renderScale untouched, but if the shot
        // had NEVER set renderScale explicitly, resolveJobScale(job) would
        // fall through to the renderQuality=='superfast' branch and return
        // 0.5 — the slider snapped to 50% the first time the user switched
        // to MP4. Pinning the scale here (preferring the user's last
        // sticky choice) keeps the slider where it was.
        if (typeof job.renderScale !== 'number') {
            const s = readSettings();
            job.renderScale = (typeof s.lastRenderScale === 'number')
                            ? s.lastRenderScale : 1.0;
        }
        // v0.4.8 — stickiness: remember the codec across shots.
        writeSettings(Object.assign(readSettings(), {
            lastRenderFormat: clean,
            lastRenderQuality: job.renderQuality,
        }));
        return { renderFormat: clean };
    }));

ipcMain.handle('shot:setRenderScale', (_e, scale) =>
    withJob(shotDir(), job => {
        const n = Number(scale);
        let best = 1.0, bestD = 99;
        for (const s of VALID_SCALES) {
            const d = Math.abs(s - n);
            if (d < bestD) { bestD = d; best = s; }
        }
        job.renderScale = best;
        // v0.4.8 — stickiness: remember the scale so the next new shot
        // inherits it instead of falling through to the hardcoded default.
        writeSettings(Object.assign(readSettings(), { lastRenderScale: best }));
        return { renderScale: best };
    }));

// dev17 audit: shot:setRenderMode + shot:setRenderQuality stripped — no
// renderer ever called them. The renderQuality field is still tolerated
// in job.json (writeJob doesn't strip unknown keys) so any pre-existing
// shot files keep working; we just don't accept new mutations from the
// UI until a render-quality dropdown actually exists.

ipcMain.handle('shot:openAE', () => {
    const dir = shotDir();
    if (!dir) { emitStatus('No shot selected', 'error'); return { ok: false, error: 'no shot selected' }; }
    const job = readJob(dir);
    if (!job || !job.aepPath) {
        emitStatus('No AE project on this shot', 'error');
        return { ok: false, error: 'no aepPath' };
    }
    const p = job.aepPath.replace(/\//g, '\\');
    if (!fs.existsSync(p)) {
        emitStatus('AE project file not found on disk', 'error');
        return { ok: false, error: 'aep not found: ' + p };
    }
    emitStatus(`Opening ${path.basename(p)} in After Effects\u2026`, 'busy');
    shell.openPath(p);
    emitStatus('After Effects launched', 'ok');
    return { ok: true };
});

// ---- IPC: version lifecycle -----------------------------------------------
ipcMain.handle('version:setFinal', (_e, versionName) =>
    withJob(shotDir(), job => {
        if (!/^v\d+$/.test(versionName || '')) throw new Error('bad version name');
        if (job.finalVersion === versionName) delete job.finalVersion;
        else job.finalVersion = versionName;
        return { finalVersion: job.finalVersion || null };
    }));

// Switch the timeline to point at a different rendered version. Writes the
// new activeVersion into job.json, dispatches relink_latest_render.py, and
// then polls for the `.relink.json` result file Python writes on completion
// so the status strip shows a real terminal state instead of the old honest
// but unhelpful "Relink dispatched".
ipcMain.handle('version:setActive', async (_e, versionName) => {
    if (!/^v\d+$/.test(versionName || '')) return { ok: false, error: 'bad version name' };
    const dir = shotDir();
    if (!dir) return { ok: false, error: 'no shot selected' };
    const vDir = path.join(dir, 'renders', versionName);
    if (!fs.existsSync(vDir)) return { ok: false, error: 'version not found' };
    // Persist activeVersion BEFORE dispatching so the UI flips immediately.
    const persisted = withJob(dir, job => {
        job.activeVersion = versionName;
        return { activeVersion: versionName };
    });
    if (!persisted.ok) return persisted;

    emitStatus(`Relinking ${versionName} in Resolve\u2026`, 'busy');
    runRelinkAndAwait(dir, versionName, /* atPlayhead */ false);
    return { ok: true, activeVersion: versionName };
});

ipcMain.handle('version:delete', (_e, versionName) => {
    if (!/^v\d+$/.test(versionName || '')) return { ok: false, error: 'bad version name' };
    const dir = shotDir();
    if (!dir) return { ok: false, error: 'no shot selected' };
    const target = path.join(dir, 'renders', versionName);
    try { assertInProjects(target); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(target)) return { ok: false, error: 'not found' };
    const wiped = P.rmDirRetry(target);
    // Reconcile job.json even on partial delete so the UI doesn't keep a stale
    // pointer at a half-deleted dir.
    const job = readJob(dir);
    if (job) {
        let dirty = false;
        if (job.finalVersion === versionName)  { delete job.finalVersion;  dirty = true; }
        if (job.activeVersion === versionName) { delete job.activeVersion; dirty = true; }
        if (dirty) writeJob(dir, job);
    }
    if (!wiped) return { ok: false, error: 'partial delete — release any open preview and try again' };
    return { ok: true };
});

// v0.4.8 — accepts either a plain string (legacy: delete the named shot in the
// CURRENT project) or an object {project, shot} (rail-clicked shot from a
// non-current project). The rail shot-delete path MUST send the object form —
// passing a string from a different project's row silently targeted the
// wrong shot on 0.4.7 and earlier (that bug paired with the ctx-menu leak to
// make the data-loss case: user right-clicks shot in project A, gets project
// menu, clicks Delete, project B's shot with the same name gets deleted).
// dev35 — shot:delete is now a SOFT delete. Moves <project>/<shot>/ →
// <project>/.trash/<ts>__<shot>/ via atomic rename. The dev0 hard-delete
// path is preserved for `shot:purgeFromTrash` (the user-explicit "delete
// forever" action from the trash drawer); regular Delete from index.html
// goes through here and is recoverable for 7 days.
//
// Same arg shape + same return shape as before — index.html doesn't need
// to change to get the safety upgrade. The renderer's confirm copy SHOULD
// change to mention 7-day recoverability but the IPC contract is stable.
ipcMain.handle('shot:delete', (_e, arg) => {
    let projectName, shotName;
    if (arg && typeof arg === 'object') {
        projectName = arg.project;
        shotName    = arg.shot;
    } else {
        projectName = currentProject;
        shotName    = arg || currentShot;
    }
    if (!projectName || !shotName) return { ok: false, error: 'no shot selected' };
    const pDir = path.join(PROJECTS_DIR, projectName);
    const target = path.join(pDir, shotName);
    try { assertInProjects(target); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(target)) return { ok: false, error: 'not found' };
    const r = SHOT_TRASH.trashShot(pDir, shotName);
    if (!r.ok) return { ok: false, error: r.error };
    if (projectName === currentProject && shotName === currentShot) {
        currentShot = null;
        userSelectedShot = false;
    }
    return { ok: true, recoverable: true, trashEntry: r.entry };
});

// dev35 — shot trash IPC surface, mirroring the dev32 vault trash
// handlers (vault:listTrash / vault:restore / vault:emptyTrash). Each
// trash entry includes ageDays + daysRemaining so the drawer can render
// "expires in 4d" without doing date math in the renderer.
ipcMain.handle('shot:listTrash', () => {
    if (!PROJECTS_DIR) return { ok: true, entries: [], retentionDays: SHOT_TRASH.TRASH_RETENTION_DAYS };
    const RETENTION_DAYS = SHOT_TRASH.TRASH_RETENTION_DAYS;
    const now = Date.now();
    const entries = SHOT_TRASH.listAllTrash(PROJECTS_DIR).map(t => {
        const trashedMs = t.trashedAt ? Date.parse(t.trashedAt) : 0;
        const ageMs   = trashedMs ? Math.max(0, now - trashedMs) : null;
        const ageDays = (ageMs == null) ? null : Math.floor(ageMs / (24 * 60 * 60 * 1000));
        const daysRemaining = (ageDays == null) ? null : Math.max(0, RETENTION_DAYS - ageDays);
        return Object.assign({}, t, { ageDays, daysRemaining });
    });
    return { ok: true, entries, retentionDays: RETENTION_DAYS };
});

ipcMain.handle('shot:restoreFromTrash', (_e, args) => {
    const o = args || {};
    if (!o.project || !o.entry) return { ok: false, error: 'project and entry required' };
    const pDir = path.join(PROJECTS_DIR, o.project);
    try { assertInProjects(pDir); } catch (e) { return { ok: false, error: e.message }; }
    const r = SHOT_TRASH.restoreShot(pDir, o.entry);
    if (r.ok) emitStatus(`Shot restored: ${o.project}/${r.shotName}`, 'ok');
    else      emitStatus('Restore failed: ' + r.error, 'error');
    return r;
});

// Permanent delete of a single trash entry. Gated behind a confirm
// dialog in the renderer.
ipcMain.handle('shot:purgeFromTrash', (_e, args) => {
    const o = args || {};
    if (!o.project || !o.entry) return { ok: false, error: 'project and entry required' };
    const pDir = path.join(PROJECTS_DIR, o.project);
    try { assertInProjects(pDir); } catch (e) { return { ok: false, error: e.message }; }
    const r = SHOT_TRASH.purgeEntry(pDir, o.entry);
    if (r.ok) emitStatus('Trashed shot purged', 'ok');
    return r;
});

// User-initiated "empty all". Wipes every entry across every project.
ipcMain.handle('shot:emptyAllTrash', () => {
    if (!PROJECTS_DIR) return { ok: false, error: 'no projects dir' };
    const removed = SHOT_TRASH.emptyAllShotTrash(PROJECTS_DIR);
    emitStatus(`Shot trash emptied · ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} purged`, 'ok');
    return { ok: true, count: removed.length };
});

// v0.4.8 — delete-preview IPC. Returns the absolute path that WOULD be
// deleted, plus a recursive .aep count so the renderer's confirm modal can
// show both (and escalate to a red "this folder contains AE project files"
// warning). Never deletes anything itself — read-only. Separate IPC from
// the actual delete so even an XSS-bug in the renderer can't trick this
// into destroying files.
ipcMain.handle('path:deletePreview', (_e, arg) => {
    const o = arg || {};
    if (!o.project) return { ok: false, error: 'project required' };
    const projectDirAbs = path.join(PROJECTS_DIR, o.project);
    const targetAbs = o.shot ? path.join(projectDirAbs, o.shot) : projectDirAbs;
    try { assertInProjects(targetAbs); }
    catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(targetAbs)) return { ok: false, error: 'not found' };
    let aepCount = 0;
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); }
        catch { return; }
        for (const ent of entries) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile() && ent.name.toLowerCase().endsWith('.aep')) aepCount++;
        }
    };
    walk(targetAbs);
    return {
        ok: true,
        path: targetAbs,
        aepCount,
        kind: o.shot ? 'shot' : 'project',
    };
});

// Keep-only: delete every version except the named one. Guards refuse the
// request when the target doesn't have a master on disk (so you can't end up
// with a shot that has no usable renders at all). After deletion, if the
// active version was among the deletes we auto-relink Resolve to the kept
// version so the timeline rebinds without a second user click.
ipcMain.handle('shot:keepOnlyFinal', (_e, versionName) => {
    const dir = shotDir();
    if (!dir) { emitStatus('No shot selected', 'error'); return { ok: false, error: 'no shot selected' }; }
    const job = readJob(dir);
    if (!job) { emitStatus('No job.json for this shot', 'error'); return { ok: false, error: 'no job.json' }; }

    const keep = (versionName && /^v\d+$/.test(versionName))
        ? versionName : job.finalVersion;
    if (!keep) {
        emitStatus('Pick a version to keep first', 'error');
        return { ok: false, error: 'no version specified and no finalVersion set' };
    }
    const rendersDir = path.join(dir, 'renders');
    if (!fs.existsSync(rendersDir)) {
        emitStatus('No renders folder on this shot', 'error');
        return { ok: false, error: 'no renders/' };
    }
    const keepDir = path.join(rendersDir, keep);
    if (!fs.existsSync(keepDir)) {
        emitStatus(`Version ${keep} does not exist on disk`, 'error');
        return { ok: false, error: 'version folder missing: ' + keep };
    }
    // Refuse to keep a version that has no master file — otherwise we'd be
    // deleting every usable render and leaving only a hollow folder behind.
    if (!findMaster(keepDir)) {
        emitStatus(`Version ${keep} has no master render — refusing to keep only it`, 'error');
        return { ok: false, error: 'kept version has no master; refusing to wipe others' };
    }

    emitStatus(`Cleaning up versions \u2014 keeping ${keep}\u2026`, 'busy');
    const deleted = [], failed = [];
    for (const v of fs.readdirSync(rendersDir)) {
        if (v === keep || !/^v\d+$/.test(v)) continue;
        const vDir = path.join(rendersDir, v);
        try {
            assertInProjects(vDir);
            if (P.rmDirRetry(vDir)) deleted.push(v); else failed.push(v);
        } catch (e) { failed.push(v); }
    }

    // Reconcile job.json. If activeVersion was nuked we ALSO auto-relink
    // Resolve to the kept version so the user's timeline rebinds without
    // another click.
    const activeWasDeleted = job.activeVersion && deleted.includes(job.activeVersion);
    let relinkNeeded = false;
    let dirty = false;
    if (activeWasDeleted) {
        job.activeVersion = keep;        // point at the kept version
        dirty = true;
        relinkNeeded = true;
    }
    if (job.finalVersion && deleted.includes(job.finalVersion)) {
        delete job.finalVersion; dirty = true;
    }
    if (dirty) writeJob(dir, job);

    if (relinkNeeded) {
        emitStatus(`Relinking ${keep} in Resolve (previous active deleted)\u2026`, 'busy');
        runRelinkAndAwait(dir, keep, false);
    } else if (failed.length) {
        emitStatus(`Some versions could not be deleted (locked?): ${failed.join(', ')}`, 'error');
    } else {
        emitStatus(
            deleted.length
                ? `Kept ${keep} \u2014 deleted ${deleted.length} other version${deleted.length===1?'':'s'}`
                : `Kept ${keep} \u2014 no other versions to delete`,
            'ok'
        );
    }
    return { ok: failed.length === 0, kept: keep, deleted, failed };
});

// ---- IPC: native confirm dialog -------------------------------------------
ipcMain.handle('dialog:confirm', async (_e, opts) => {
    const o = opts || {};
    const parent = BrowserWindow.getFocusedWindow() || mainWindow || null;
    // v0.4.9-rc5 — honor caller-supplied `buttons`, `defaultId`, `cancelId`,
    // and `type` so the Spec Lock mismatch modal can offer a 3-way choice
    // (Accept / Keep / Unlock) instead of the baseline 2-button OK/Cancel.
    // Callers that DON'T pass `buttons` still get the legacy shape and
    // behavior unchanged — {ok, confirmed: response===0}. Callers that DO
    // pass `buttons` should read `chosenIndex` (and `chosenLabel`) to branch
    // on which option the user picked.
    const hasCustomButtons = Array.isArray(o.buttons) && o.buttons.length > 0;
    const buttons = hasCustomButtons
        ? o.buttons
        : [o.confirmLabel || 'OK', o.cancelLabel || 'Cancel'];
    const defaultId = Number.isInteger(o.defaultId)
        ? o.defaultId
        : (o.destructive ? buttons.length - 1 : 0);
    const cancelId = Number.isInteger(o.cancelId) ? o.cancelId : buttons.length - 1;
    const dlgType = o.type
        || (o.destructive ? 'warning' : 'question');

    const res = await dialog.showMessageBox(parent, {
        type:      dlgType,
        buttons,
        defaultId,
        cancelId,
        title:     o.title   || 'Confirm',
        message:   o.message || 'Are you sure?',
        detail:    o.detail  || '',
        noLink:    true,
    });
    const chosenIndex = res.response;
    return {
        ok: true,
        confirmed:   chosenIndex === 0,            // legacy field (button 0 == "confirm")
        chosenIndex,                                // 0-based index into `buttons`
        chosenLabel: buttons[chosenIndex] || null,  // convenience for branching
    };
});

// ---- IPC: AE-first creation flows -----------------------------------------
ipcMain.handle('ae:createProject', async (_e, rawName) => {
    const clean = P.sanitizeName(rawName);
    if (!clean) { emitStatus('Invalid project name', 'error'); return { ok: false, error: 'empty or invalid project name' }; }
    if (fs.existsSync(path.join(PROJECTS_DIR, clean))) {
        emitStatus('Project already exists: ' + clean, 'error');
        return { ok: false, error: 'project already exists: ' + clean };
    }

    emitStatus('Reading active After Effects composition\u2026', 'busy');
    let probe;
    try { probe = await SP.runAEProbeComp(AE_EXE, PROBE_COMP_JSX, COMP_PROBE_SENTINEL); }
    catch (e) { emitStatus('Could not read After Effects: ' + e.message, 'error'); return { ok: false, error: e.message }; }
    if (!probe.ok) {
        emitStatus('AE probe failed: ' + (probe.error || 'unknown'), 'error');
        return { ok: false, error: probe.error || 'AE probe failed' };
    }
    if (!probe.aepPath) {
        emitStatus('Save your .aep in After Effects first', 'error');
        return { ok: false, error: 'Save your After Effects project (.aep) first so we can track it.' };
    }

    fs.mkdirSync(path.join(PROJECTS_DIR, clean), { recursive: true });
    const shotName = P.nextShotInProject(path.join(PROJECTS_DIR, clean));
    const job = buildAEJob(probe, clean, shotName);
    finalizeAEShotStaged(clean, shotName, job);
    emitStatus(`Project "${clean}" created from ${probe.name}`, 'ok');
    return { ok: true, project: clean, shot: shotName, compName: probe.name };
});

ipcMain.handle('ae:createShot', async () => {
    if (!currentProject) { emitStatus('No project selected', 'error'); return { ok: false, error: 'no project selected' }; }

    emitStatus('Reading active After Effects composition\u2026', 'busy');
    let probe;
    try { probe = await SP.runAEProbeComp(AE_EXE, PROBE_COMP_JSX, COMP_PROBE_SENTINEL); }
    catch (e) { emitStatus('Could not read After Effects: ' + e.message, 'error'); return { ok: false, error: e.message }; }
    if (!probe.ok) {
        emitStatus('AE probe failed: ' + (probe.error || 'unknown'), 'error');
        return { ok: false, error: probe.error || 'AE probe failed' };
    }
    if (!probe.aepPath) {
        emitStatus('Save your .aep in After Effects first', 'error');
        return { ok: false, error: 'Save your After Effects project (.aep) first so we can track it.' };
    }

    const projAbs = path.join(PROJECTS_DIR, currentProject);
    const shotName = P.nextShotInProject(projAbs);
    const job = buildAEJob(probe, currentProject, shotName);
    try {
        finalizeAEShotStaged(currentProject, shotName, job);
    } catch (e) {
        emitStatus('Shot create failed: ' + e.message, 'error');
        return { ok: false, error: e.message };
    }
    emitStatus(`Shot ${shotName} created from ${probe.name}`, 'ok');
    return { ok: true, project: currentProject, shot: shotName, compName: probe.name };
});

// "Send to Resolve" — insert the shot's latest render at the current
// playhead on first call; ReplaceClip via stored MPI on subsequent calls.
ipcMain.handle('ae:sendToResolve', async () => {
    const sDir = shotDir();
    if (!sDir) { emitStatus('No shot selected', 'error'); return { ok: false, error: 'no shot selected' }; }
    const job = readJob(sDir);
    if (!job) { emitStatus('job.json missing', 'error'); return { ok: false, error: 'no job.json' }; }
    const rendersDir = path.join(sDir, 'renders');
    if (!fs.existsSync(rendersDir)) {
        emitStatus('No renders yet — render a version first', 'error');
        return { ok: false, error: 'no renders yet — render a version in AE first' };
    }
    const versions = fs.readdirSync(rendersDir).filter(n => /^v\d+$/.test(n)).sort();
    if (!versions.length) {
        emitStatus('No renders yet — render a version first', 'error');
        return { ok: false, error: 'no renders yet — render a version in AE first' };
    }
    const atPlayhead = !job.resolveMediaPoolItemId;
    emitStatus(atPlayhead
        ? `Inserting ${path.basename(sDir)} into Resolve at playhead\u2026`
        : `Updating ${path.basename(sDir)} in Resolve\u2026`, 'busy');
    runRelinkAndAwait(sDir, null, atPlayhead);
    return { ok: true, shot: path.basename(sDir), atPlayhead };
});

ipcMain.handle('shot:sendToAE', async () => {
    const dir = shotDir();
    if (!dir) { emitStatus('No shot selected', 'error'); return { ok: false, error: 'no shot selected' }; }
    const jobPath = path.join(dir, 'source', 'job.json');
    if (!fs.existsSync(jobPath)) {
        emitStatus('job.json missing', 'error'); return { ok: false, error: 'job.json missing' };
    }
    emitStatus(`Opening ${path.basename(dir)} in After Effects\u2026`, 'busy');
    try { await SP.spawnAE(AE_EXE, CREATE_JSX, JOB_POINTER, jobPath); }
    catch (e) { emitStatus('After Effects launch failed: ' + e.message, 'error'); throw e; }
    emitStatus('After Effects opened', 'ok');
    return { ok: true, pointer: JOB_POINTER, jobPath };
});

// ---- Relink wrapper --------------------------------------------------------
// runRelink dispatches fire-and-forget Python. Here we also await the
// .relink.json result file Python writes on completion, and emit the final
// status from that. Non-blocking for the IPC caller (no await at handler
// level) — we fire the Promise and let emitStatus drive the UI.
// v0.4.8 — Force Relink path. Same dispatch as runRelinkAndAwait but adds
// `--force-reconnect` to the Python argv, which tells relink_latest_render.py
// to call ReplaceClip with os.path.abspath(render_path) even when the
// MediaPoolItem looks healthy — the recovery hammer for the "Media Offline"
// case where Resolve's internal reference went stale (drive letter changed,
// project copied, network mount reconnected, etc.). Emits its own status
// strings so the user can tell Force from normal relink.
function runForceRelinkAndAwait(shotDirAbs) {
    if (SP.isRelinkInFlight(shotDirAbs)) {
        emitStatus('Already relinking this shot in Resolve \u2014 please wait\u2026', 'busy');
        return { dispatched: false, reason: 'already-in-flight' };
    }
    if (!_assertPythonUsable('Force-relink')) {
        return { dispatched: false, reason: 'python-out-of-range' };
    }
    if (!_assertResolveScriptingUsable('Force-relink')) {
        return { dispatched: false, reason: 'resolve-sdk-missing' };
    }
    const ctx = { PYTHON_EXE, RELINK_PY, RESOLVE_SCRIPT_API, RESOLVE_SCRIPT_LIB };
    const spawnResult = SP.runRelink(ctx, shotDirAbs, null, false, { forceReconnect: true });
    if (!spawnResult || spawnResult.dispatched === false) {
        emitStatus('Already relinking this shot in Resolve \u2014 please wait\u2026', 'busy');
        return spawnResult || { dispatched: false, reason: 'already-in-flight' };
    }
    emitStatus('Force-relinking \u2014 trying to reconnect missing reference in Resolve\u2026', 'busy');
    (async () => {
        const result = await SP.waitForRelinkResult(shotDirAbs, 12000);
        if (result.ok) {
            emitStatus('Force-relink OK \u2014 reference reconnected in Resolve', 'ok');
        } else if (result.error === 'timeout') {
            emitStatus('Force-relink dispatched \u2014 no completion signal from Resolve', 'ok');
        } else {
            emitStatus('Force-relink failed: ' + result.error, 'error');
        }
    })();
    return spawnResult;
}

ipcMain.handle('shot:forceRelink', () => {
    const dir = shotDir();
    if (!dir) { emitStatus('No shot selected', 'error'); return { ok: false, error: 'no shot selected' }; }
    const r = runForceRelinkAndAwait(dir);
    return { ok: r && r.dispatched !== false };
});

// v0.4.8 — pendingShotName persistence. Fulfils "NAME field in the UI must
// override the default Shot_XXX in the export_range.py payload". We write
// to %APPDATA%/Roundtrip/config.json (the exact path export_range.py's
// _read_roundtrip_config() reads) so the Resolve-side script picks it up
// at shot creation and clears it after use. Null/empty arg clears the
// pending name.
ipcMain.handle('shot:setPendingName', (_e, rawName) => {
    const appdata = process.env.APPDATA;
    if (!appdata) return { ok: false, error: 'APPDATA missing' };
    const cfgDir  = path.join(appdata, 'Roundtrip');
    const cfgPath = path.join(cfgDir, 'config.json');
    try { fs.mkdirSync(cfgDir, { recursive: true }); } catch (_) {}
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) {}
    const clean = String(rawName || '').trim().slice(0, 64);
    if (clean) cfg.pendingShotName = clean;
    else delete cfg.pendingShotName;
    try { atomicWriteJSON(cfgPath, cfg); }
    catch (e) { return { ok: false, error: 'write failed: ' + e.message }; }
    return { ok: true, pendingShotName: cfg.pendingShotName || null };
});

function runRelinkAndAwait(shotDirAbs, versionOverride, atPlayhead) {
    // v0.4.7 — defensive in-flight guard. The render-complete watcher AND
    // the user's "Send to Resolve" / "Set active version" buttons can all
    // land here within the same 1-2s window. Second+ callers short-circuit
    // with a visible status message so the user doesn't think their click
    // was ignored (and then click five more things).
    if (SP.isRelinkInFlight(shotDirAbs)) {
        emitStatus('Already relinking this shot in Resolve \u2014 please wait\u2026', 'busy');
        return { dispatched: false, reason: 'already-in-flight' };
    }
    if (!_assertPythonUsable('Relink')) {
        return { dispatched: false, reason: 'python-out-of-range' };
    }
    if (!_assertResolveScriptingUsable('Relink')) {
        return { dispatched: false, reason: 'resolve-sdk-missing' };
    }

    const ctx = { PYTHON_EXE, RELINK_PY, RESOLVE_SCRIPT_API, RESOLVE_SCRIPT_LIB };
    const spawnResult = SP.runRelink(ctx, shotDirAbs, versionOverride, atPlayhead);
    // Belt-and-braces: if the spawn helper itself refused (race with another
    // caller that grabbed the lock microseconds earlier), treat it the same
    // way — surface it to the user and bail without awaiting a result file
    // the prior caller will consume.
    if (!spawnResult || spawnResult.dispatched === false) {
        emitStatus('Already relinking this shot in Resolve \u2014 please wait\u2026', 'busy');
        return spawnResult || { dispatched: false, reason: 'already-in-flight' };
    }

    (async () => {
        const result = await SP.waitForRelinkResult(shotDirAbs);
        if (result.ok) {
            const v = result.version ? `${result.version} ` : '';
            emitStatus(`Relinked ${v}in Resolve`, 'ok');
        } else if (result.error === 'timeout') {
            // Python didn't report back — keep the honest terminal state
            // "dispatched" so the strip doesn't stick on busy forever.
            emitStatus('Relink dispatched — no completion signal from Resolve', 'ok');
        } else {
            emitStatus('Relink failed: ' + result.error, 'error');
        }
    })();
    return spawnResult;
}

// ---- Preview webm conversion (post-render) ---------------------------------
// Wait for preview.mp4 to stabilize, then compress it to webm (VP9, 720p cap).
// We delete the mp4 only on successful webm. ffmpeg missing → keep mp4.
function convertPreviewToWebm(versionDir) {
    const mp4  = path.join(versionDir, 'preview.mp4');
    const webm = path.join(versionDir, 'preview.webm');
    if (!fs.existsSync(mp4)) return;

    const vName = path.basename(versionDir);
    const args = [
        '-y', '-i', mp4,
        '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0',
        '-vf', 'scale=-2:min(ih\\,720)',
        '-row-mt', '1', '-cpu-used', '4', '-an',
        webm,
    ];
    const child = spawn(FFMPEG_EXE, args, { windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
        console.warn('[preview] ffmpeg not available — keeping preview.mp4. Error:', err.message);
    });
    child.on('close', code => {
        if (code === 0 && fs.existsSync(webm) && fs.statSync(webm).size > 0) {
            try { fs.unlinkSync(mp4); } catch (_) {}
            console.log(`[preview] converted ${vName} preview.mp4 → preview.webm`);
        } else {
            console.warn(`[preview] ffmpeg exited ${code} — keeping preview.mp4.\n` + stderr.slice(-400));
            try { if (fs.existsSync(webm) && fs.statSync(webm).size === 0) fs.unlinkSync(webm); } catch (_) {}
        }
    });
}

// ---- IPC: render-back (the big one) ---------------------------------------
ipcMain.handle('shot:renderBack', async () => {
    const sDir = shotDir();
    if (!sDir) return { ok: false, error: 'no shot selected' };
    const { name: versionName, dir } = P.nextVersionDir(sDir);
    const job = readJob(sDir);
    const animName = (job && job.name) ? P.sanitizeName(job.name) : '';

    const renderFormat = resolveJobFormat(job);
    const renderScale  = resolveJobScale(job);
    const fmtToken     = FORMAT_FILENAME_TOKEN[renderFormat];
    const masterExt    = FORMAT_EXT[renderFormat];
    const scalePct     = Math.round(renderScale * 100);
    const suffix       = `_${fmtToken}_s${scalePct}`;
    const masterBasename = (animName ? `${animName}_${versionName}` : 'render') + suffix;

    // Keep legacy fields in sync for downstream tools that still read them.
    const renderQuality = (renderFormat === 'mp4')        ? 'superfast'
                        : (renderFormat === 'prores_422') ? 'fast' : 'final';
    const renderMode    = (renderFormat === 'prores_4444') ? 'final' : 'fast';

    // A render always supersedes the previous active version; persist BEFORE
    // spawning AE so the UI flips immediately. If the render fails, the next
    // reconcileFinalVersion tick will clear the pointer when it sees the
    // empty vNN folder.
    if (job) {
        job.activeVersion = versionName;
        writeJob(sDir, job);
    }

    const renderCompName = (job && job.compName) || currentShot;
    const renderJob = {
        compName: renderCompName,
        versionDir: fwd(dir),
        aepPath: job ? fwd(job.aepPath) : null,
        masterBasename, masterExt,
        renderFormat, renderScale,
        renderQuality, renderMode,
    };
    const rjPath = path.join(dir, 'renderjob.json');
    atomicWriteJSON(rjPath, renderJob);
    emitStatus(`Rendering ${path.basename(sDir)} ${versionName} in After Effects\u2026`, 'busy');
    try { await SP.spawnAE(AE_EXE, RENDER_JSX, RENDER_POINTER, rjPath); }
    catch (e) { emitStatus('Render dispatch failed: ' + e.message, 'error'); throw e; }

    // Fire-and-forget watcher: wait for the master to stabilize, then fan out
    // ffmpeg (webm conversion) + Resolve relink in parallel. Capture sDir here
    // so switching shots mid-render doesn't relink the wrong one.
    const renderMov    = path.join(dir, `${masterBasename}${masterExt}`);
    const previewMp4   = path.join(dir, 'preview.mp4');
    const progressPath = path.join(dir, '.render-progress.json');
    const relinkShotDir = sDir;

    // Render-progress poller: the JSX writes .render-progress.json with stage
    // markers (preparing → rendering → complete | error). We poll at 1s and
    // surface stage transitions on the status strip so the user can tell AE
    // is alive vs. wedged. Per-frame counts aren't feasible — rq.render() is
    // blocking in ExtendScript — but stage + elapsed time gives the same UX
    // signal of "something is happening".
    let lastStage = null;
    const progressTimer = setInterval(() => {
        if (!fs.existsSync(progressPath)) return;
        let p;
        try { p = JSON.parse(fs.readFileSync(progressPath, 'utf8')); }
        catch (_) { return; }
        if (!p || p.stage === lastStage) {
            // For an in-flight 'rendering' stage with a startedAt, refresh the
            // elapsed display every tick — even when the stage itself hasn't
            // changed — so the user sees a moving counter instead of a frozen
            // string. Caps at 'rendering' to avoid spamming on terminal stages.
            if (p && p.stage === 'rendering' && p.startedAt) {
                const elapsed = Math.round((Date.now() - p.startedAt) / 1000);
                const v = p.version || versionName;
                emitStatus(`Rendering ${v} \u00B7 ${elapsed}s elapsed (AE)`, 'busy');
            }
            return;
        }
        lastStage = p.stage;
        const v = p.version || versionName;
        if (p.stage === 'preparing') {
            emitStatus(`Rendering ${v} \u00B7 preparing in After Effects\u2026`, 'busy');
        } else if (p.stage === 'rendering') {
            const total = p.totalFrames ? ` (${p.totalFrames} frames)` : '';
            emitStatus(`Rendering ${v} \u00B7 compositing in AE${total}\u2026`, 'busy');
        } else if (p.stage === 'complete' || p.stage === 'error') {
            // Terminal stage — the file-stable watcher below takes over from
            // here and emits the final relink/preview status. Stop polling.
            clearInterval(progressTimer);
        }
    }, 1000);
    // Safety cap: stop polling after 30 minutes regardless. A real render
    // that hung that long has bigger problems than a stale interval.
    setTimeout(() => clearInterval(progressTimer), 30 * 60 * 1000);

    const origin = (job && job.origin) || 'resolve';
    const alreadyLinked = !!(job && job.resolveMediaPoolItemId);
    // Skip auto-relink ONLY for an AE-origin shot's very first render — no
    // Resolve project/timeline/MPI has been captured yet, so the user must
    // explicitly press "Send to Resolve" to pick the playhead insertion point.
    const autoRelink = (origin !== 'ae') || alreadyLinked;
    (async () => {
        const ok = await SP.waitForStableFile(renderMov);
        if (!ok) { emitStatus('Render timed out — master never finished', 'error'); return; }
        if (autoRelink) {
            emitStatus(`Render complete \u2014 relinking ${versionName} in Resolve\u2026`, 'busy');
            runRelinkAndAwait(relinkShotDir, null, false);
        } else {
            emitStatus(`Render complete \u2014 press "Send to Resolve" to place ${versionName}`, 'ok');
        }
        const prevOk = await SP.waitForStableFile(previewMp4, 300000);
        if (prevOk) convertPreviewToWebm(dir);
    })();

    return { ok: true, version: versionName, masterBasename, pointer: RENDER_POINTER };
});

// ---- IPC: open/reveal handlers --------------------------------------------
ipcMain.handle('shot:openFolder', () => {
    const sDir = shotDir();
    shell.openPath(fs.existsSync(sDir) ? sDir : projectDir());
    return { ok: true };
});

ipcMain.handle('project:openFolder', () => {
    const pDir = projectDir();
    const target = pDir || PROJECTS_DIR;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
    return { ok: true };
});

ipcMain.handle('shot:revealJob', () => {
    const sDir = shotDir();
    if (!sDir) return { ok: false, error: 'no shot selected' };
    const jobPath = path.join(sDir, 'source', 'job.json');
    try { assertInProjects(jobPath); } catch (e) { return { ok: false, error: e.message }; }
    if (fs.existsSync(jobPath)) shell.showItemInFolder(jobPath);
    else shell.openPath(path.join(sDir, 'source'));
    return { ok: true };
});

// "Latest rendered version" = highest vNN with hasMaster=true, NOT simply the
// last dir (v07 may have been keep-only'd away even though v06 still has its
// master). listVersions sorts ascending so we scan from the end.
ipcMain.handle('shot:revealLatestRender', () => {
    const sDir = shotDir();
    if (!sDir) return { ok: false, error: 'no shot selected' };
    const versions = listVersions(sDir);
    for (let i = versions.length - 1; i >= 0; i--) {
        if (versions[i].master) {
            try { assertInProjects(versions[i].master); }
            catch (e) { return { ok: false, error: e.message }; }
            shell.showItemInFolder(versions[i].master);
            return { ok: true, version: versions[i].name };
        }
    }
    return { ok: false, error: 'no rendered versions yet' };
});

ipcMain.handle('shot:revealAEP', () => {
    const sDir = shotDir();
    if (!sDir) return { ok: false, error: 'no shot selected' };
    const job = readJob(sDir);
    if (!job || !job.aepPath) return { ok: false, error: 'no AE project path on this shot' };
    const aep = job.aepPath.replace(/\//g, '\\');
    try { assertInProjects(aep); } catch (e) { return { ok: false, error: e.message }; }
    if (fs.existsSync(aep)) shell.showItemInFolder(aep);
    else shell.openPath(path.join(sDir, 'ae'));
    return { ok: true };
});

// Relink latest master — context-menu analogue of clicking "Set Active" on
// the newest rendered version card.
ipcMain.handle('shot:relinkLatest', () => {
    const sDir = shotDir();
    if (!sDir) return { ok: false, error: 'no shot selected' };
    const versions = listVersions(sDir);
    let latest = null;
    for (let i = versions.length - 1; i >= 0; i--) {
        if (versions[i].master) { latest = versions[i]; break; }
    }
    if (!latest) {
        emitStatus('No rendered versions to relink', 'error');
        return { ok: false, error: 'no rendered versions to relink' };
    }
    withJob(sDir, job => { job.activeVersion = latest.name; return { activeVersion: latest.name }; });
    emitStatus(`Relinking ${latest.name} in Resolve\u2026`, 'busy');
    runRelinkAndAwait(sDir, latest.name, false);
    return { ok: true, version: latest.name };
});

ipcMain.handle('version:reveal', (_e, versionName) => {
    if (!/^v\d+$/.test(versionName || '')) return { ok: false, error: 'bad version name' };
    const sDir = shotDir();
    if (!sDir) return { ok: false, error: 'no shot selected' };
    const vDir = path.join(sDir, 'renders', versionName);
    try { assertInProjects(vDir); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(vDir)) return { ok: false, error: 'folder not found' };
    shell.openPath(vDir);
    return { ok: true };
});

// ---- IPC: Vault (v0.5.0-dev2) ---------------------------------------------
// Surface for the Vault MVP. Every handler returns {ok, ...} or {ok:false, error}.
// Heavy lifting lives in lib/vault_pipeline.js — this is the electron-shaped
// adapter that supplies AE spawn + emitStatus + ffmpeg + config.

// Build the ctx object that the pipeline modules consume. Rebuilt each call
// so runtime config changes (wizard edit) take effect immediately.
function _buildVaultCtx() {
    const cfg = readConfig() || {};
    return {
        AE_EXE,
        VAULT_COLLECT_JSX,
        VAULT_CLIP_JSX,
        IMPORT_CLIPS_JSX,
        IMPORT_ASSET_JSX,
        FFMPEG_EXE: FFMPEG_EXE && fs.existsSync(FFMPEG_EXE) ? FFMPEG_EXE : null,
        vaultRoot: cfg.vaultRoot || null,
        chiralVersion: app.getVersion(),
        userEmail: null,                                            // TODO: wire from config if we ever collect it
        tempDir: TEMP_DIR,
        spawnAE: (jsx, pointer, jobPath) => SP.spawnAE(AE_EXE, jsx, pointer, jobPath),
        // dev20 — vault flows wrap their entire AE-resident block (dispatch
        // + sentinel poll) in this lock so we never trigger AE's "second
        // script while another is running" warning. Lock is process-global,
        // FIFO-queued, and auto-releases at 20 min as a safety net.
        acquireAELock: (label) => SP.acquireAELock(label),
        emitStatus: (text, kind) => emitStatus(text, kind),
        readProjectSpec: (projName) => {
            // Reuse the rc5 Spec Lock machinery — project.json.lockedSpec.
            try {
                const pd = path.join(PROJECTS_DIR, projName, 'project.json');
                const j  = JSON.parse(fs.readFileSync(pd, 'utf8'));
                return j.lockedSpec || null;
            } catch (_) { return null; }
        },
        runRelink: async ({ shotDir: sd, version, atPlayhead }) => {
            const r = SP.runRelink({
                PYTHON_EXE: PYTHON_EXE,
                RELINK_PY, RESOLVE_SCRIPT_API, RESOLVE_SCRIPT_LIB,
            }, sd, version, !!atPlayhead);
            if (!r.dispatched) return { ok: false, reason: r.reason };
            return await SP.waitForRelinkResult(sd);
        },
    };
}

// dev17 audit: vault:getRoot stripped — no renderer consumer. The same
// info is reachable via vault:list (returns vaultRoot in the payload),
// which IS used. To re-expose, restore from git.

// Pick or change the vault root from the running app (not only the wizard).
// Useful when users add a vault after first-run setup.
ipcMain.handle('vault:pickRoot', async () => {
    const res = await dialog.showOpenDialog({
        title: 'Choose Vault folder (asset library)',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const vr = res.filePaths[0];
    if (!detect.isWritableDir(vr)) return { ok: false, error: 'folder is not writable' };
    const prev = readConfig() || defaultConfig();
    writeConfig(Object.assign({}, prev, { vaultRoot: vr }));
    applyConfig();
    emitStatus('Vault folder set: ' + path.basename(vr), 'ok');
    return { ok: true, vaultRoot: vr };
});

// Primary listing for the Vault tab. Returns the cached projection — cheap.
// Rebuild is on-demand via vault:rebuildIndex or implicit after create/delete.
ipcMain.handle('vault:list', () => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: true, vaultRoot: null, assets: [], folders: [] };
    if (!VAULT.isVaultRoot(cfg.vaultRoot)) {
        try { VAULT.initVault(cfg.vaultRoot, { chiralVersion: app.getVersion() }); } catch (_) {}
    }
    let idx = VAULT.readIndex(cfg.vaultRoot);
    if (!idx) { VAULT.rebuildIndex(cfg.vaultRoot); idx = VAULT.readIndex(cfg.vaultRoot); }
    // dev37 — opportunistic upgrade. If the cached index predates the
    // sizeBytes field (legacy installs upgrading to dev37), rebuild
    // once so the SIZE column populates without forcing the user to
    // hit "Rebuild." Detected by sampling row 0 — sizeBytes is `null`
    // on a fresh dev37 row and `undefined` on a pre-dev37 row.
    if (idx && Array.isArray(idx.assets) && idx.assets.length
        && !('sizeBytes' in idx.assets[0])) {
        VAULT.rebuildIndex(cfg.vaultRoot);
        idx = VAULT.readIndex(cfg.vaultRoot);
    }
    return {
        ok: true,
        vaultRoot: cfg.vaultRoot,
        assets:  (idx && idx.assets)  || [],
        // dev24 — folders ride along so the UI doesn't need a second IPC.
        folders: (idx && idx.folders) || [],
    };
});

ipcMain.handle('vault:rebuildIndex', () => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root configured' };
    const r = VAULT.rebuildIndex(cfg.vaultRoot);
    emitStatus(`Vault index rebuilt (${r.count} assets, ${r.skipped.length} skipped)`, 'ok');
    return Object.assign({ ok: true }, r);
});

// Precondition check — can this shot be vaulted right now? Used by the UI
// to grey out "Vault this shot" / "Vault marked shots" and show a tooltip
// explaining why. Returns { ok, reason? }.
ipcMain.handle('vault:canVaultShot', (_e, arg) => {
    const projName = (arg && arg.project) || currentProject;
    const shotName = (arg && arg.shot)    || currentShot;
    if (!projName || !shotName) return { ok: false, reason: 'No shot selected.' };
    const projectDirAbs = path.join(PROJECTS_DIR, projName);
    try { assertInProjects(path.join(projectDirAbs, shotName)); }
    catch (e) { return { ok: false, reason: e.message }; }
    return VAULT_PIPE.canVaultShot(projectDirAbs, shotName);
});

// Vault a single shot. Accepts either the current-selection (no args) or an
// explicit {project, shot} payload for batch operations.
ipcMain.handle('vault:createFromShot', async (_e, arg) => {
    const projName = (arg && arg.project) || currentProject;
    const shotName = (arg && arg.shot)    || currentShot;
    if (!projName || !shotName) return { ok: false, error: 'no project/shot' };
    const projectDirAbs = path.join(PROJECTS_DIR, projName);
    try { assertInProjects(path.join(projectDirAbs, shotName)); }
    catch (e) { return { ok: false, error: e.message }; }
    const ctx = _buildVaultCtx();
    if (!ctx.vaultRoot) { emitStatus('Pick a Vault folder first', 'error'); return { ok: false, error: 'no vault root' }; }
    const r = await VAULT_PIPE.vaultShot(ctx, {
        projectDir: projectDirAbs,
        projectName: projName,
        shotName: shotName,
    });
    if (!r.ok) emitStatus('Vault failed: ' + r.error, 'error');
    return r;
});

// dev33 — "Add asset" flow. Pops a native file picker filtered to .aep
// then runs the external-aep vault pipeline. Distinct from
// vault:createFromShot because there's no project / shot context — the
// resulting asset's origin block carries '(External)' and the .aep
// basename.
//
// Two args, both optional:
//   * aepPath     — pre-resolved path. If omitted, the handler opens
//                   a dialog. Letting callers pass a path makes this
//                   testable and lets future drag-and-drop reuse it.
//   * displayName — optional asset name override. Defaults to the
//                   .aep basename (sans extension).
ipcMain.handle('vault:addExternalAEP', async (_e, args) => {
    const ctx = _buildVaultCtx();
    if (!ctx.vaultRoot) {
        emitStatus('Pick a Vault folder first', 'error');
        return { ok: false, error: 'no vault root' };
    }
    let aepPath = (args && args.aepPath) || null;
    if (!aepPath) {
        // Anchor the picker to the vault window if it's open, else fall
        // back to the main window. Keeps the modal centered on the
        // surface the user clicked.
        const parent = (vaultWin && !vaultWin.isDestroyed()) ? vaultWin
                     : (mainWindow && !mainWindow.isDestroyed()) ? mainWindow
                     : null;
        const res = await dialog.showOpenDialog(parent, {
            title: 'Pick an After Effects project to vault',
            filters: [{ name: 'After Effects project', extensions: ['aep'] }],
            properties: ['openFile'],
        });
        if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
        aepPath = res.filePaths[0];
    }
    const r = await VAULT_PIPE.vaultExternalAep(ctx, {
        aepPath,
        displayName: args && args.displayName,
        tags:        args && args.tags,
    });
    if (!r.ok && !r.canceled) emitStatus('Add asset failed: ' + r.error, 'error');
    return r;
});

// Clip-mode vault — same shape as vault:createFromShot but routes through
// VAULT_PIPE.clipShot, which only collects FootageItems tagged with
// CHIRAL:CLIP in their Comment column. See scripts/ae/vault_clip.jsx.
ipcMain.handle('vault:clipFromShot', async (_e, arg) => {
    const projName = (arg && arg.project) || currentProject;
    const shotName = (arg && arg.shot)    || currentShot;
    if (!projName || !shotName) return { ok: false, error: 'no project/shot' };
    const projectDirAbs = path.join(PROJECTS_DIR, projName);
    try { assertInProjects(path.join(projectDirAbs, shotName)); }
    catch (e) { return { ok: false, error: e.message }; }
    const ctx = _buildVaultCtx();
    if (!ctx.vaultRoot) { emitStatus('Pick a Vault folder first', 'error'); return { ok: false, error: 'no vault root' }; }
    const r = await VAULT_PIPE.clipShot(ctx, {
        projectDir:  projectDirAbs,
        projectName: projName,
        shotName:    shotName,
    });
    if (!r.ok) emitStatus('Clip vault failed: ' + r.error, 'error');
    return r;
});

// Clip-mode import. Two execution paths inside importClipToAE:
//   intoOpen=true  → drop files into running AE project via import_clips.jsx
//   intoOpen=false → fall back to creating a new shot folder with /clips
//
// The vault UI prefers intoOpen=true and only falls back when the user
// explicitly opts to "import as new shot".
ipcMain.handle('vault:importClipToAE', async (_e, args) => {
    const { assetId, targetProject, newShotName, intoOpen } = args || {};
    const ctx = _buildVaultCtx();
    let targetDirAbs = null;
    if (targetProject) {
        targetDirAbs = path.join(PROJECTS_DIR, targetProject);
        try { assertInProjects(targetDirAbs); } catch (e) { return { ok: false, error: e.message }; }
    }
    const r = await VAULT_PIPE.importClipToAE(ctx, {
        assetId,
        targetProjectDir:  targetDirAbs,
        targetProjectName: targetProject || null,
        newShotName,
        intoOpen: !!intoOpen,
    });
    if (r.ok) {
        if (r.mode === 'into-open') {
            // AE comes to the foreground when it imports — visibility is
            // already handled by the OS, no shell.openPath needed.
            emitStatus(`Imported ${r.imported} clip(s) into open AE project`, 'ok');
        } else {
            emitStatus(
                `Imported clips to ${targetProject}/${r.shotName}` + (r.renamed ? '  (auto-suffixed — name was taken)' : ''),
                'ok'
            );
            // Same dev15 #4 visibility fix as the asset path.
            try { shell.openPath(r.shotDir); } catch (_) {}
        }
    } else {
        emitStatus('Clip import failed: ' + r.error, 'error');
    }
    return r;
});

// Batch: vault every shot in the given (or current) project where
// job.vaultMarked === true. Sequential to avoid AE re-entrancy issues.
ipcMain.handle('vault:createFromProject', async (_e, arg) => {
    const projName = (arg && arg.project) || currentProject;
    if (!projName) return { ok: false, error: 'no project' };
    const projectDirAbs = path.join(PROJECTS_DIR, projName);
    if (!fs.existsSync(projectDirAbs)) return { ok: false, error: 'project not found' };
    const shots = P.listShotsIn(projectDirAbs);
    const ctx = _buildVaultCtx();
    if (!ctx.vaultRoot) { emitStatus('Pick a Vault folder first', 'error'); return { ok: false, error: 'no vault root' }; }
    const results = [];
    for (const s of shots) {
        const sd = path.join(projectDirAbs, s);
        const job = readJob(sd);
        if (!job || !job.vaultMarked) continue;
        emitStatus(`Vaulting ${s}…`, 'busy');
        const r = await VAULT_PIPE.vaultShot(ctx, {
            projectDir: projectDirAbs,
            projectName: projName,
            shotName: s,
        });
        results.push({ shot: s, ok: r.ok, error: r.error, assetId: r.assetId });
        if (!r.ok) emitStatus(`Vault failed on ${s}: ${r.error}`, 'error');
    }
    const okCount = results.filter(r => r.ok).length;
    emitStatus(`Batch vault: ${okCount}/${results.length} shots succeeded`, okCount === results.length ? 'ok' : 'info');
    return { ok: true, results };
});

ipcMain.handle('vault:delete', (_e, assetId) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    if (!VAULT_ASSET.isValidAssetId(assetId)) return { ok: false, error: 'bad assetId' };
    const r = VAULT.trashAsset(cfg.vaultRoot, assetId);
    if (!r.ok) return r;
    // dev24 — clear the folder assignment so a future restore lands the
    // asset in "(unfiled)" rather than referencing a folder that may or
    // may not still exist.
    try { VAULT_FOLDERS.removeAssignment(cfg.vaultRoot, assetId); } catch (_) {}
    VAULT.rebuildIndex(cfg.vaultRoot);
    emitStatus('Asset moved to trash (restore within 7 days)', 'ok');
    return r;
});

// ---- dev24 — virtual folders -----------------------------------------------
// Metadata-only organization. See lib/vault_folders.js for the storage
// model. Each handler reads → mutates → writes → rebuilds the index so
// the next vault:list call has fresh folder columns on every row.

ipcMain.handle('vault:folders:create', (_e, args) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const r = VAULT_FOLDERS.createFolder(cfg.vaultRoot, (args && args.name) || '');
    if (r.ok) VAULT.rebuildIndex(cfg.vaultRoot);
    return r;
});

ipcMain.handle('vault:folders:rename', (_e, args) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const r = VAULT_FOLDERS.renameFolder(
        cfg.vaultRoot, (args && args.id) || '', (args && args.name) || ''
    );
    if (r.ok) VAULT.rebuildIndex(cfg.vaultRoot);
    return r;
});

ipcMain.handle('vault:folders:delete', (_e, args) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const r = VAULT_FOLDERS.deleteFolder(cfg.vaultRoot, (args && args.id) || '');
    if (r.ok) VAULT.rebuildIndex(cfg.vaultRoot);
    return r;
});

ipcMain.handle('vault:folders:assign', (_e, args) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const r = VAULT_FOLDERS.assignAsset(
        cfg.vaultRoot, (args && args.assetId) || '', (args && args.folderId) || null
    );
    if (r.ok) VAULT.rebuildIndex(cfg.vaultRoot);
    return r;
});

// dev32 — trash drawer IPC. dev17 stripped these; dev32 re-exposes
// listTrash / restore / emptyAllTrash for the new sidebar Trash view.
// vault:read stays stripped (no detail drawer yet).
//
// Behavior:
//   * listTrash returns rows with deletedAt + daysRemaining (UI shows
//     "deleted 3 days ago, expires in 4 days").
//   * restore moves a single trash entry back into assets/, then
//     rebuilds the index so the asset reappears in the grid.
//   * emptyAllTrash is the user-initiated wipe-everything action. The
//     existing 7-day auto-retention path (purgeOldTrash) still runs at
//     boot — this just adds an explicit "Empty now" override.
ipcMain.handle('vault:listTrash', () => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: true, entries: [] };
    const RETENTION_DAYS = 7;
    const now = Date.now();
    const entries = VAULT.listTrash(cfg.vaultRoot).map(t => {
        const trashedMs = t.trashedAt ? Date.parse(t.trashedAt) : 0;
        const ageMs   = trashedMs ? Math.max(0, now - trashedMs) : null;
        const ageDays = (ageMs == null) ? null : Math.floor(ageMs / (24 * 60 * 60 * 1000));
        const daysRemaining = (ageDays == null) ? null : Math.max(0, RETENTION_DAYS - ageDays);
        // Try to read the asset.json that was trashed so we can show
        // a name. Falls back to the assetId if the manifest is gone
        // (asset.json is the FIRST thing inside the trashed dir, so
        // a missing one means a damaged trash entry — rare).
        let name = t.assetId;
        try {
            const trashedDir = path.join(cfg.vaultRoot, '.trash', t.entry);
            const a = VAULT_ASSET.readAsset(trashedDir);
            if (a && a.name) name = a.name;
        } catch (_) {}
        return { entry: t.entry, assetId: t.assetId, trashedAt: t.trashedAt, ageDays, daysRemaining, name };
    });
    return { ok: true, entries, retentionDays: RETENTION_DAYS };
});

ipcMain.handle('vault:restore', (_e, args) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const entry = (args && (args.entry || (typeof args === 'string' ? args : null))) || null;
    if (!entry) return { ok: false, error: 'no trash entry name' };
    const r = VAULT.restoreAsset(cfg.vaultRoot, entry);
    if (r.ok) {
        VAULT.rebuildIndex(cfg.vaultRoot);
        emitStatus('Asset restored from trash', 'ok');
    } else {
        emitStatus('Restore failed: ' + r.error, 'error');
    }
    return r;
});

// User-initiated "Empty trash now". Wipes everything in .trash/
// regardless of age. Rebuilds the index even though that surface
// shouldn't change (assets/ is untouched) — keeps the index.builtAt
// timestamp fresh as a "vault was just maintained" signal.
ipcMain.handle('vault:emptyTrash', () => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const removed = VAULT.emptyAllTrash(cfg.vaultRoot);
    VAULT.rebuildIndex(cfg.vaultRoot);
    emitStatus(`Trash emptied · ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} purged`, 'ok');
    return { ok: true, count: removed.length };
});

// Media paths for the hover-play video element. Returns absolute paths (the
// renderer needs them for <video src>), wrapped in `file://` friendly form.
ipcMain.handle('vault:mediaPaths', (_e, assetId) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    const a = VAULT_ASSET.readAsset(VAULT.assetDirOf(cfg.vaultRoot, assetId));
    if (!a) return { ok: false, error: 'not found' };
    const dir = VAULT.assetDirOf(cfg.vaultRoot, assetId);
    const join = rel => rel ? path.join(dir, rel) : null;
    return {
        ok: true,
        dir,
        master:    join(a.files.master),
        proxy:     join(a.files.proxy),
        thumbnail: join(a.files.thumbnail),
    };
});

ipcMain.handle('vault:reveal', (_e, assetId) => {
    const cfg = readConfig() || {};
    if (!cfg.vaultRoot) return { ok: false, error: 'no vault root' };
    if (!VAULT_ASSET.isValidAssetId(assetId)) return { ok: false, error: 'bad assetId' };
    const d = VAULT.assetDirOf(cfg.vaultRoot, assetId);
    if (!fs.existsSync(d)) return { ok: false, error: 'dir missing' };
    shell.openPath(d);
    return { ok: true };
});

ipcMain.handle('vault:importToResolve', async (_e, args) => {
    const { assetId, targetProject, newShotName, atPlayhead } = args || {};
    if (!targetProject) return { ok: false, error: 'no target project' };
    const targetDirAbs = path.join(PROJECTS_DIR, targetProject);
    try { assertInProjects(targetDirAbs); } catch (e) { return { ok: false, error: e.message }; }
    const ctx = _buildVaultCtx();
    const r = await VAULT_PIPE.importAssetToResolve(ctx, {
        assetId,
        targetProjectDir:  targetDirAbs,
        targetProjectName: targetProject,
        newShotName,
        atPlayhead,
    });
    if (r.ok) {
        // dev15 #4 — make cross-project imports visible. The status toast can
        // get buried (especially when the main UI is showing a different
        // project), so pop Explorer on the new shot folder. The user gets an
        // unmistakable signal that something happened, and a path they can
        // poke around in.
        emitStatus(
            `Imported to Resolve: ${targetProject}/${r.shotName}` + (r.renamed ? '  (auto-suffixed — name was taken)' : ''),
            'ok'
        );
        try { shell.openPath(r.shotDir); } catch (_) {}
    } else {
        emitStatus('Import to Resolve failed: ' + r.error, 'error');
    }
    return r;
});

// dev19 — asset → AE into the currently-open project. Symmetric counterpart
// to vault:importClipToAE (intoOpen=true). Spawns import_asset.jsx which
// calls app.project.importFile() on the asset's .aep, nesting it under a
// FolderItem in the active AE project. No new shot folder created on disk;
// no copy of the .aep elsewhere — this is the "drag-into-AE" experience.
ipcMain.handle('vault:importAssetToOpenAE', async (_e, args) => {
    const { assetId } = args || {};
    if (!assetId) return { ok: false, error: 'no assetId' };
    const ctx = _buildVaultCtx();
    const r = await VAULT_PIPE.importAssetToOpenAE(ctx, { assetId });
    if (r.ok) {
        const folder = r.folderName ? `as "${r.folderName}"` : '';
        emitStatus(`Imported asset into open AE project ${folder}`.trim(), 'ok');
    } else {
        emitStatus('Asset → AE failed: ' + r.error, 'error');
    }
    return r;
});

ipcMain.handle('vault:importToAE', async (_e, args) => {
    const { assetId, targetProject, newShotName } = args || {};
    if (!targetProject) return { ok: false, error: 'no target project' };
    const targetDirAbs = path.join(PROJECTS_DIR, targetProject);
    try { assertInProjects(targetDirAbs); } catch (e) { return { ok: false, error: e.message }; }
    const ctx = _buildVaultCtx();
    const r = await VAULT_PIPE.importAssetToAE(ctx, {
        assetId,
        targetProjectDir:  targetDirAbs,
        targetProjectName: targetProject,
        newShotName,
    });
    if (r.ok) {
        emitStatus(
            `Imported to AE: ${targetProject}/${r.shotName}` + (r.renamed ? '  (auto-suffixed — name was taken)' : ''),
            'ok'
        );
        try { shell.openPath(r.shotDir); } catch (_) {}
    } else {
        emitStatus('Import to AE failed: ' + r.error, 'error');
    }
    return r;
});

// dev17 audit: vault:verifyPortability stripped — no renderer consumer.
// VAULT.verifyPortability() is still in lib/vault.js as a debug helper
// (and is exercised by tests), so re-wrapping when a "Vault Health"
// drawer ships is one IPC handler away.

// v0.5.0 — standalone Vault window. Keeps the main UI untouched; a single
// BrowserWindow loads vault.html. Re-focuses on second invocation.
let vaultWin = null;
function openVaultWindow() {
    if (vaultWin && !vaultWin.isDestroyed()) { vaultWin.focus(); return; }
    vaultWin = new BrowserWindow({
        // dev59 — bumped from 1100x720. The list view's USED column was
        // getting clipped at the default size on 1080p screens, so users
        // had to manually resize on every open just to see all columns.
        // 1400x860 gives every column room and leaves a healthy margin on
        // a typical 1920x1080 desktop.
        width: 1400, height: 860,
        title: 'Chiral Network — Vault',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    vaultWin.setMenuBarVisibility(false);
    vaultWin.loadFile(path.join(__dirname, 'vault.html'));
    vaultWin.on('closed', () => { vaultWin = null; });
}
ipcMain.handle('vault:open', () => { openVaultWindow(); return { ok: true }; });

ipcMain.handle('app:version', () => ({ version: app.getVersion() }));

ipcMain.handle('projects:openRoot', () => {
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    shell.openPath(PROJECTS_DIR);
    return { ok: true };
});

// ---- Setup Wizard ----------------------------------------------------------
function applyConfig() {
    const cfg = readConfig();
    if (!cfg) return;
    if (cfg.afterEffectsPath) AE_EXE = cfg.afterEffectsPath;
    if (cfg.ffmpegPath)       FFMPEG_EXE = cfg.ffmpegPath;
    if (cfg.roundtripRoot)    PROJECTS_DIR = path.join(cfg.roundtripRoot, 'projects');
    // v0.5.0 — Vault MVP. When a vaultRoot is configured, ensure the layout
    // exists (idempotent) and opportunistically purge old trash. Failures are
    // non-fatal — the Vault UI surfaces "vault unreachable" on its own.
    if (cfg.vaultRoot) {
        try {
            VAULT.initVault(cfg.vaultRoot, { chiralVersion: app.getVersion() });
            VAULT.purgeOldTrash(cfg.vaultRoot);
        } catch (e) {
            console.warn('[vault] init/purge failed:', e.message);
        }
    }
    // dev35 — shot trash auto-purge. Same 7-day retention as vault
    // trash. Walks every project under PROJECTS_DIR and purges
    // entries whose mtime is older than the cutoff. Best-effort: a
    // failed entry doesn't abort the rest. Logs and moves on.
    try {
        const removed = SHOT_TRASH.purgeOldShotTrash(PROJECTS_DIR);
        if (removed.length) console.log(`[shot-trash] auto-purged ${removed.length} expired entr${removed.length === 1 ? 'y' : 'ies'}`);
    } catch (e) {
        console.warn('[shot-trash] purge failed:', e.message);
    }
    // dev43 — (re)install fs.watch on PROJECTS_DIR + vault assets/.
    // Idempotent — rebuildWatchers closes any previous handles first.
    // Called from every applyConfig invocation so wizard re-runs (which
    // may change the roots) get fresh watchers.
    // Ensure the dir exists first so fs.watch has something to attach
    // to — otherwise a fresh install (no projects yet) would silently
    // get a noop watcher and miss the user's first project create.
    try {
        if (PROJECTS_DIR && !fs.existsSync(PROJECTS_DIR)) {
            fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        }
    } catch (_) { /* non-fatal — watcher just becomes noop */ }
    try { rebuildWatchers(); }
    catch (e) { console.warn('[watch] rebuild failed:', e.message); }
}

// Silent migration: if <ROOT>/projects has shots but no config.json exists,
// write a populated config so existing users never see the wizard. Never
// touches projects/ itself.
function maybeMigrateExistingInstall() {
    if (readConfig()) return;
    const legacyProjects = path.join(ROOT, 'projects');
    if (!fs.existsSync(legacyProjects)) return;
    let hasShots = false;
    try {
        for (const p of fs.readdirSync(legacyProjects, { withFileTypes: true })) {
            if (!p.isDirectory()) continue;
            const shots = fs.readdirSync(path.join(legacyProjects, p.name), { withFileTypes: true })
                .filter(d => d.isDirectory() && /^Shot_/.test(d.name));
            if (shots.length) { hasShots = true; break; }
        }
    } catch (_) {}
    if (!hasShots) return;
    const aeFound = fs.existsSync(AE_EXE) ? AE_EXE : null;
    const ffFound = (FFMPEG_EXE && FFMPEG_EXE !== 'ffmpeg' && fs.existsSync(FFMPEG_EXE))
        ? FFMPEG_EXE : null;
    const patch = Object.assign(defaultConfig(), {
        setupComplete: true,
        afterEffectsPath: aeFound,
        ffmpegPath: ffFound,
        roundtripRoot: ROOT,
        resolveScriptsInstalled: true,
    });
    writeConfig(patch);
    console.log('[migrate] legacy install detected; wrote config.json with setupComplete=true');
}

let wizardWin = null;
let wizardMode = 'first-run';
function openWizardWindow(mode = 'first-run') {
    wizardMode = mode;
    if (wizardWin && !wizardWin.isDestroyed()) { wizardWin.focus(); return; }
    wizardWin = new BrowserWindow({
        width: 640, height: 580,
        resizable: false, minimizable: false, maximizable: false,
        title: 'Chiral Network — Setup',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    wizardWin.setMenuBarVisibility(false);
    wizardWin.loadFile(path.join(__dirname, 'wizard.html'));
    wizardWin.on('closed', () => { wizardWin = null; });
}

// ---- IPC: wizard -----------------------------------------------------------
ipcMain.handle('wizard:open', () => { openWizardWindow('edit'); return { ok: true }; });
ipcMain.handle('wizard:getMode', () => ({ mode: wizardMode, cfg: readConfig() || null }));

ipcMain.handle('wizard:detect', () => {
    const r = detect.detectAll(ROOT);
    if (r.python && r.python.path) console.log('[wizard] python found:', r.python.path);
    return { ae: r.ae, resolve: r.resolve, ffmpeg: r.ffmpeg, pythonRegistry: r.pythonRegistry };
});

const PYTHON_INSTALLER_URL =
    'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe';

function downloadFile(url, dest, hops = 0) {
    return new Promise((resolve, reject) => {
        if (hops > 5) return reject(new Error('too many redirects'));
        const req = https.get(url, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return downloadFile(res.headers.location, dest, hops + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
            file.on('error', e => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
    });
}

function runInstallerSilent(installerPath) {
    return new Promise((resolve, reject) => {
        const args = ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_test=0'];
        const child = execFile(installerPath, args, {
            windowsHide: true, timeout: 15 * 60 * 1000,
        }, (err, _stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').trim()));
            resolve();
        });
        child.on('exit', code => {
            if (code !== 0 && code !== null) reject(new Error('installer exit code ' + code));
        });
    });
}

ipcMain.handle('wizard:installPython', async () => {
    const pre = detect.detectPythonRegistry();
    if (pre.found) return { ok: true, alreadyInstalled: true, registry: pre };

    const dest = path.join(app.getPath('temp'), 'roundtrip_python_installer_' + Date.now() + '.exe');
    try {
        await downloadFile(PYTHON_INSTALLER_URL, dest);
        await runInstallerSilent(dest);
    } catch (e) {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
        return { ok: false, error: e.message, manualUrl: 'https://www.python.org/downloads/windows/' };
    }
    try { fs.unlinkSync(dest); } catch (_) {}
    const post = detect.detectPythonRegistry();
    if (!post.found) {
        return {
            ok: false,
            error: 'Installer finished but no PythonCore registry key found. Please install manually.',
            manualUrl: 'https://www.python.org/downloads/windows/',
        };
    }
    return { ok: true, alreadyInstalled: false, registry: post };
});

ipcMain.handle('wizard:pickAEExe', async () => {
    const parent = wizardWin && !wizardWin.isDestroyed() ? wizardWin : null;
    const res = await dialog.showOpenDialog(parent, {
        title: 'Locate After Effects (AfterFX.exe)',
        filters: [{ name: 'Executable', extensions: ['exe'] }],
        properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const p = res.filePaths[0];
    if (!/AfterFX\.exe$/i.test(p)) return { ok: false, error: 'Please select AfterFX.exe' };
    if (!fs.existsSync(p))         return { ok: false, error: 'File not found' };
    return { ok: true, path: p };
});

// dev52 — folder-mode AE picker. Use case: portable / non-standard /
// network-mounted AE installs where the user wants to point us at the
// containing folder rather than hunting for AfterFX.exe inside it.
// We try the canonical layout first (.../Support Files/AfterFX.exe)
// then a flat fallback (.../AfterFX.exe) seen in some portable builds.
// Anything else → ask the user to use Browse file… instead so we
// don't ship a recursive walker that could stall on huge folders.
ipcMain.handle('wizard:pickAEFolder', async () => {
    const parent = wizardWin && !wizardWin.isDestroyed() ? wizardWin : null;
    const res = await dialog.showOpenDialog(parent, {
        title: 'Pick the After Effects install folder',
        properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    const root = res.filePaths[0];
    const candidates = [
        path.join(root, 'Support Files', 'AfterFX.exe'),
        path.join(root, 'AfterFX.exe'),
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return { ok: true, path: c }; }
        catch (_) { /* keep trying */ }
    }
    return {
        ok: false,
        error: 'AfterFX.exe not found inside this folder (tried "Support Files/" and the folder root). Use Browse file… to point at the .exe directly.',
    };
});

ipcMain.handle('wizard:pickRoot', async (_e, suggested) => {
    const parent = wizardWin && !wizardWin.isDestroyed() ? wizardWin : null;
    const res = await dialog.showOpenDialog(parent, {
        title: 'Choose Chiral Network projects folder',
        defaultPath: suggested || detect.defaultRoundtripRoot() || undefined,
        properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('wizard:defaultRoot', () => ({ path: detect.defaultRoundtripRoot() }));
ipcMain.handle('wizard:probeWritable', (_e, dirPath) => ({ ok: detect.isWritableDir(dirPath) }));

// v0.5.0 — Vault MVP. Separate picker from roundtripRoot so the user can
// stash the vault on a different (larger / external) SSD. NO default path
// (design question #7) — the dialog opens without a defaultPath hint so
// the user picks consciously.
ipcMain.handle('wizard:pickVaultRoot', async (_e, suggested) => {
    const parent = wizardWin && !wizardWin.isDestroyed() ? wizardWin : null;
    const res = await dialog.showOpenDialog(parent, {
        title: 'Choose Vault folder (asset library)',
        defaultPath: suggested || undefined,
        properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('wizard:installResolveScripts', () => {
    if (!RESOLVE_SCRIPTS_DST) return { ok: false, error: 'APPDATA not available' };
    if (!fs.existsSync(RESOLVE_SCRIPTS_SRC))
        return { ok: false, error: 'scripts/resolve missing under app ROOT' };
    try { fs.mkdirSync(RESOLVE_SCRIPTS_DST, { recursive: true }); }
    catch (e) { return { ok: false, error: 'mkdir failed: ' + e.message }; }
    const copied = [], failed = [];
    for (const name of fs.readdirSync(RESOLVE_SCRIPTS_SRC)) {
        if (!name.toLowerCase().endsWith('.py')) continue;
        try {
            fs.copyFileSync(path.join(RESOLVE_SCRIPTS_SRC, name),
                            path.join(RESOLVE_SCRIPTS_DST, name));
            copied.push(name);
        } catch (e) { failed.push({ name, error: e.message }); }
    }
    return { ok: failed.length === 0, copied, failed, utilDir: RESOLVE_SCRIPTS_DST };
});

ipcMain.handle('wizard:save', (_e, payload) => {
    const p = payload || {};
    if (!p.afterEffectsPath || !fs.existsSync(p.afterEffectsPath))
        return { ok: false, error: 'After Effects path is invalid' };
    if (!p.roundtripRoot || !detect.isWritableDir(p.roundtripRoot))
        return { ok: false, error: 'Chiral Network projects folder is not writable' };
    try { fs.mkdirSync(path.join(p.roundtripRoot, 'projects'), { recursive: true }); }
    catch (e) { return { ok: false, error: 'mkdir failed: ' + e.message }; }

    const prev = readConfig() || defaultConfig();
    const next = Object.assign({}, prev, {
        afterEffectsPath:        p.afterEffectsPath,
        ffmpegPath:              p.ffmpegPath || null,
        roundtripRoot:           p.roundtripRoot,
        // v0.5.0 — vaultRoot is optional at setup; users can skip and pick
        // later from the Vault tab. We still validate writability when set.
        vaultRoot:               (p.vaultRoot && detect.isWritableDir(p.vaultRoot)) ? p.vaultRoot : (prev.vaultRoot || null),
        resolveScriptsInstalled: !!p.resolveScriptsInstalled,
        setupComplete:           true,
    });
    const w = writeConfig(next);
    if (!w.ok) return w;
    applyConfig();
    seedCurrentProject();
    return { ok: true };
});

ipcMain.handle('wizard:finish', () => {
    const mainExists = BrowserWindow.getAllWindows().some(w => w !== wizardWin);
    if (!mainExists) createWindow();
    if (wizardWin && !wizardWin.isDestroyed()) wizardWin.close();
    return { ok: true };
});

ipcMain.handle('wizard:cancel', () => {
    const cfg = readConfig();
    if (wizardWin && !wizardWin.isDestroyed()) wizardWin.close();
    if (!cfg || !cfg.setupComplete) app.quit();
    return { ok: true };
});

// ---- Application menu ------------------------------------------------------
function buildAppMenu() {
    const routeToRenderer = action => () => {
        const w = BrowserWindow.getFocusedWindow()
               || BrowserWindow.getAllWindows().find(x => x !== wizardWin);
        if (w && !w.isDestroyed()) w.webContents.send('menu:action', action);
    };
    const template = [
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        {
            label: 'Help',
            submenu: [
                { label: 'Setup Wizard\u2026',   click: () => openWizardWindow('edit') },
                { label: 'Repair installation',  click: routeToRenderer('repair') },
                { label: 'Reset setup\u2026',    click: routeToRenderer('reset') },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Window + status strip -------------------------------------------------
let mainWindow = null;
function createWindow() {
    // v0.4.8 — 1280x800 default. The 900x640 default from 0.4.1 era was sized
    // for the original single-column layout; the Project Rail + shot header
    // + version cards need more horizontal room to breathe.
    const win = new BrowserWindow({
        width: 1280, height: 800,
        minWidth: 960, minHeight: 560,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false,   // local <video src="file:///..."> only
        },
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    mainWindow = win;
    win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

    // v0.4.8 — Alt-Tab optimization. When the window loses focus we tell the
    // renderer to add .app-blurred to <body>, which the stylesheet uses to
    // short-circuit transitions/animations — cuts background CPU to ~0 when
    // the user is working in AE or Resolve. Restored on focus.
    win.on('blur',  () => win.webContents.send('window:blur'));
    win.on('focus', () => win.webContents.send('window:focus'));
}

// Frozen allow-list for the status-strip renderer. Any `kind` outside this
// set is coerced to 'info' so a rogue call site can't paint an undefined
// color class in the UI. Keeping this central also gives grep a single
// anchor for the taxonomy.
const STATUS_KINDS = Object.freeze({
    INFO:  'info',
    BUSY:  'busy',
    OK:    'ok',
    ERROR: 'error',
});
const _STATUS_KIND_SET = new Set(Object.values(STATUS_KINDS));

// v0.4.9-rc4 — Python version gate for the Resolve relink path. Every spawn
// site that launches a Python subprocess targeting Resolve's fusionscript
// module calls this first. If Python is out of range, emit a precise error
// status (so the user knows EXACTLY what to install) and return false; the
// caller aborts the spawn rather than producing the silent pythonw.exe
// crash pattern we saw on the tester's Python 3.14 machine.
//
// Why "relink only" and not a blanket gate: the in-Resolve export_range.py
// runs under Resolve's bundled fuscript (always 3.12), not our external
// Python, so that path isn't affected. Gating only what we actually spawn
// keeps the blast radius small.
function _assertPythonUsable(opLabel) {
    if (PYTHON_INRANGE) return true;
    const detected = PYTHON_VERSION ? PYTHON_VERSION.full : 'unknown';
    const supported = detect.SUPPORTED_PYTHON.label;
    emitStatus(
        `${opLabel} blocked — Python ${detected} is not supported. `
      + `Install Python ${supported} (3.12 recommended) and click Repair.`,
        'error');
    return false;
}

// Pre-flight for any spawn that calls `import DaVinciResolveScript`. If the
// SDK wrapper file isn't present on disk, the Python import will fail with
// ModuleNotFoundError and the user gets a cryptic relink error. This check
// surfaces the problem up front with a concrete remediation path. Returns
// true when ok, false when blocked (already emitted a status message).
function _assertResolveScriptingUsable(opLabel) {
    if (RESOLVE_SCRIPT_MODULE_OK) return true;
    emitStatus(
        `${opLabel} blocked — DaVinciResolveScript.py not found. `
      + `Resolve's Scripting SDK isn't installed at the expected location. `
      + `Open Setup Wizard for details.`,
        'error');
    return false;
}

function emitStatus(text, kind = 'info') {
    const safeKind = _STATUS_KIND_SET.has(kind) ? kind : 'info';
    if (safeKind !== kind) {
        // Dev-only nudge — a misspelled kind is a silent UI regression.
        console.warn('[status] unknown kind %o coerced to "info"', kind);
    }
    try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('status:update',
                { text: String(text || ''), kind: safeKind, ts: Date.now() });
        }
    } catch (_) { /* window race on shutdown */ }
}

// dev20 — broadcast AE busy state to every BrowserWindow. Renderers grey
// out AE-bound buttons while busy=true so the user can't double-click into
// the "second script while another is running" warning. Both the main
// window and the vault window subscribe via preload's onAEBusy hook.
function broadcastAEBusy(state) {
    try {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed() && w.webContents) {
                w.webContents.send('ae:busy', state);
            }
        }
    } catch (_) { /* shutdown race */ }
}
SP.setAEBusyEmit(broadcastAEBusy);

// dev43 — push-based change notifications. Replaces the renderer's 3s
// polling tick with fs.watch on the projects + vault asset trees.
// One watcher per tree; debounced 250-500ms so a render that writes
// many files doesn't flood the renderer with N refresh calls.
//
// The renderer keeps a 30s "safety tick" as a backstop — fs.watch on
// network drives / SMB shares can drop events. The safety tick is
// also paused on visibilitychange=hidden, so a backgrounded window
// pays zero CPU cost.
//
// Why push rather than the renderer subscribing directly via
// ipcRenderer.on('fs:change', …)? The watcher state belongs on the
// main process — closing it on PROJECTS_DIR changes (e.g. the user
// reopens the wizard and points at a new root) is one place to do it.
function broadcastChange(channel) {
    try {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed() && w.webContents) {
                w.webContents.send(channel);
            }
        }
    } catch (_) { /* shutdown race */ }
}

// dev44 — cross-project arrival broadcast. Fires when a new shot lands
// in a project OTHER than the user's current one while they have a
// shot selected. Renderer paints a non-blocking banner with [Switch]
// and [Dismiss]. Only mainWindow gets this — the vault window doesn't
// surface project navigation, so broadcasting there would be noise.
function broadcastCrossProjectArrival(payload) {
    try {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
            mainWindow.webContents.send('cross-project:arrival', payload);
        }
    } catch (_) { /* window race on shutdown */ }
}

let _projectsWatcher = null;
let _vaultWatcher    = null;
function rebuildWatchers() {
    if (_projectsWatcher) { _projectsWatcher.close(); _projectsWatcher = null; }
    if (_vaultWatcher)    { _vaultWatcher.close();    _vaultWatcher    = null; }

    if (PROJECTS_DIR) {
        _projectsWatcher = WATCH.createWatcher(PROJECTS_DIR, { debounceMs: 250 }, () => {
            broadcastChange('projects:changed');
        });
    }
    const cfg = readConfig() || {};
    if (cfg.vaultRoot) {
        const assetsDir = path.join(cfg.vaultRoot, 'assets');
        // Vault changes are less time-sensitive (the user isn't watching
        // a render bar tick down), bigger debounce so a vault-time
        // collect that writes 200+ files only triggers one refresh.
        _vaultWatcher = WATCH.createWatcher(assetsDir, { debounceMs: 500 }, () => {
            broadcastChange('vault:changed');
        });
    }
}
app.on('before-quit', () => {
    if (_projectsWatcher) { try { _projectsWatcher.close(); } catch (_) {} }
    if (_vaultWatcher)    { try { _vaultWatcher.close();    } catch (_) {} }
});

// ---- Vendor / PATH fallback check (v0.4.5) --------------------------------
// On startup, verify that we can find Python AND ffmpeg from at least one of:
//   1. The bundled vendor/ subtree (preferred — matches the dev environment).
//   2. The system PATH (fallback — relies on the user having installed them
//      globally; common on dev machines with Python from python.org).
// If BOTH fail (no vendor + nothing on PATH), emit a yellow status-strip
// warning so the user knows previews/relinks may not work and can run
// Repair to fix it. We do NOT abort startup — every other feature still
// works without these (the AE side runs without Python, mp4 previews are
// fine without ffmpeg). The warning is the user's signal to take action.
//
// Done as a fire-and-forget after window creation so the splash doesn't
// stall on `where` lookups when PATH is huge.
function _onPathSync(name) {
    try {
        const out = execFileSync('where', [name],
            { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        const first = (out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
        return first || null;
    } catch (_) { return null; }
}
function checkRuntimeFallbacks() {
    // dev60 — vendor/python was split into vendor/python310 and
    // vendor/python313. Either being present is sufficient to consider
    // Python "vendored" — the picker will choose the right one at spawn
    // time. We don't probe both individually here because we only need
    // to know whether the user has any vendored runtime to fall back to.
    const vendoredPy313  = path.join(ROOT, 'vendor', 'python313', 'python.exe');
    const vendoredPy310  = path.join(ROOT, 'vendor', 'python310', 'python.exe');
    const vendoredFFmpeg = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
    const pyVendored = fs.existsSync(vendoredPy313) || fs.existsSync(vendoredPy310);
    const ffVendored = fs.existsSync(vendoredFFmpeg);
    const pyPath = pyVendored ? null : (_onPathSync('python.exe') || _onPathSync('py.exe'));
    const ffPath = ffVendored ? null : _onPathSync('ffmpeg.exe');
    const pyOk = pyVendored || !!pyPath;
    const ffOk = ffVendored || !!ffPath;
    if (!pyOk && !ffOk) {
        emitStatus(
            'Python and ffmpeg not found in vendor/ or on PATH \u2014 ' +
            'previews and relinks will fail. Open the Setup Wizard to install.',
            'error');
    } else if (!pyOk) {
        emitStatus(
            'Python not found in vendor/ or on PATH \u2014 Resolve relink will fail. ' +
            'Open the Setup Wizard to install Python.',
            'error');
    } else if (!ffOk) {
        // ffmpeg-only miss is non-fatal: previews stay as mp4 instead of webm.
        emitStatus('ffmpeg not found \u2014 webm previews disabled (mp4 fallback is fine).',
                   'info');
    }
    console.log('[runtime] python: %s%s | ffmpeg: %s%s',
        pyVendored ? 'vendor' : (pyPath ? 'PATH' : 'MISSING'),
        pyPath ? (' (' + pyPath + ')') : '',
        ffVendored ? 'vendor' : (ffPath ? 'PATH' : 'MISSING'),
        ffPath ? (' (' + ffPath + ')') : '');

    // v0.4.9-rc4 — Python version gate. Even when a Python IS found, if the
    // detected version is outside 3.10-3.13 the Resolve relink will crash
    // silently inside Resolve's fusionscript module. Surface that up front so
    // the user fixes it BEFORE attempting a send-to-Resolve.
    if (pyOk && !PYTHON_INRANGE) {
        const detected = PYTHON_VERSION ? PYTHON_VERSION.full : 'unknown';
        emitStatus(
            `Python ${detected} is not supported by the Resolve relink script. `
          + `Install Python ${detect.SUPPORTED_PYTHON.label} (3.12 recommended) `
          + `and click Repair. Exports to Resolve will work; sending renders back will not.`,
            'error');
    }
}

// ---- Resolve scripts version marker (v0.4.5) ------------------------------
// Compare the bundled scripts/ chiral_version.py against the copy installed
// in Resolve's Utility folder. When they diverge (user upgraded the app but
// the Resolve scripts are stale), emit a yellow status-strip nudge with a
// "run Repair" hint. syncResolveScripts() already overwrites stale copies
// every launch, so this nudge is mostly for cases where the sync failed
// (Resolve open and locking files, AppData unavailable, etc.).
function readScriptVersion(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const txt = fs.readFileSync(filePath, 'utf8');
        const m = txt.match(/SCRIPT_VERSION\s*=\s*["']([^"']+)["']/);
        return m ? m[1] : null;
    } catch (_) { return null; }
}
function checkScriptsVersion() {
    const srcVer = readScriptVersion(
        path.join(RESOLVE_SCRIPTS_SRC, 'chiral_version.py'));
    if (!srcVer) return;   // dev install without the marker file — skip
    if (!RESOLVE_SCRIPTS_DST) return;
    const dstVer = readScriptVersion(
        path.join(RESOLVE_SCRIPTS_DST, 'chiral_version.py'));
    if (dstVer && dstVer !== srcVer) {
        emitStatus(
            'Resolve scripts are out of date (v' + dstVer + ' installed, v' +
            srcVer + ' bundled). Use Repair to update.',
            'error');
    } else if (!dstVer) {
        emitStatus(
            'Resolve scripts not installed yet \u2014 use Repair or the Setup Wizard.',
            'info');
    }
}

// ---- Resolve Utility scripts sync (on startup) ----------------------------
function fileContentsDiffer(src, dst) {
    try {
        if (!fs.existsSync(dst)) return true;
        const s = fs.statSync(src), d = fs.statSync(dst);
        if (s.size !== d.size) return true;
        const a = fs.readFileSync(src), b = fs.readFileSync(dst);
        return !a.equals(b);
    } catch (_) { return true; }
}

function syncResolveScripts() {
    if (!RESOLVE_SCRIPTS_DST) return { ok: false, reason: 'no APPDATA' };
    if (!fs.existsSync(RESOLVE_SCRIPTS_SRC)) return { ok: false, reason: 'source missing' };
    try { fs.mkdirSync(RESOLVE_SCRIPTS_DST, { recursive: true }); }
    catch (e) { return { ok: false, reason: 'mkdir failed: ' + e.message }; }
    let copied = 0, skipped = 0, failed = 0;
    for (const name of fs.readdirSync(RESOLVE_SCRIPTS_SRC)) {
        if (!name.toLowerCase().endsWith('.py')) continue;
        const src = path.join(RESOLVE_SCRIPTS_SRC, name);
        const dst = path.join(RESOLVE_SCRIPTS_DST, name);
        if (!fileContentsDiffer(src, dst)) { skipped++; continue; }
        try { fs.copyFileSync(src, dst); copied++; }
        catch (_) { failed++; }
    }
    if (copied || failed) {
        console.log(`[sync-resolve] done — ${copied} updated, ${skipped} up-to-date, ${failed} failed.`);
    }
    return { ok: failed === 0, copied, skipped, failed, utilDir: RESOLVE_SCRIPTS_DST };
}

// ---- IPC: self-repair + reset ---------------------------------------------
ipcMain.handle('app:repair', () => {
    emitStatus('Running repair\u2026', 'busy');
    const report = { ok: true, steps: [], issues: [] };
    const push = (step, detail) => report.steps.push({ step, detail });

    const cfg = readConfig();
    if (!cfg) {
        report.ok = false;
        report.issues.push('No config.json found — run Setup Wizard.');
        return report;
    }
    push('config', 'loaded from ' + path.join(app.getPath('userData'), 'config.json'));

    if (!cfg.afterEffectsPath || !fs.existsSync(cfg.afterEffectsPath)) {
        report.ok = false;
        report.issues.push('After Effects path invalid: ' + (cfg.afterEffectsPath || '(unset)'));
    } else push('ae', cfg.afterEffectsPath);

    if (cfg.ffmpegPath && !fs.existsSync(cfg.ffmpegPath)) {
        report.issues.push('ffmpeg path invalid (previews will stay mp4): ' + cfg.ffmpegPath);
    } else if (cfg.ffmpegPath) push('ffmpeg', cfg.ffmpegPath);

    if (!cfg.roundtripRoot) {
        report.ok = false;
        report.issues.push('Chiral Network projects folder is not set.');
    } else {
        const projects = path.join(cfg.roundtripRoot, 'projects');
        try {
            fs.mkdirSync(projects, { recursive: true });
            if (!detect.isWritableDir(projects)) {
                report.ok = false;
                report.issues.push('Projects folder is not writable: ' + projects);
            } else push('projects', projects);
        } catch (e) {
            report.ok = false;
            report.issues.push('Could not create projects folder: ' + e.message);
        }
    }

    const pyReg = detect.detectPythonRegistry();
    if (pyReg.found) {
        push('python', `${pyReg.hive} v${pyReg.version || '?'}`);
    } else {
        report.issues.push(
            'Python is not registered for DaVinci Resolve scripting. ' +
            'Open the Setup Wizard and click "Install Python" to fix, ' +
            'or install Python manually from python.org.'
        );
    }

    const sync = syncResolveScripts();
    if (sync.ok) push('resolve-scripts', `${sync.copied || 0} updated, ${sync.skipped || 0} up-to-date`);
    else         report.issues.push('Resolve script sync failed: ' + (sync.reason || 'unknown'));

    applyConfig();
    seedCurrentProject();
    push('applyConfig', 'live bindings refreshed');

    emitStatus(report.ok
        ? `Repair complete \u2014 ${report.steps.length} step${report.steps.length===1?'':'s'}`
        : `Repair finished with ${report.issues.length} issue${report.issues.length===1?'':'s'}`,
        report.ok ? 'ok' : 'error');
    return report;
});

ipcMain.handle('app:reset', async () => {
    const confirm = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'Reset setup'],
        defaultId: 0, cancelId: 0,
        title: 'Reset Chiral Network setup?',
        message: 'This will clear your configuration and reopen the Setup Wizard.',
        detail: 'Your projects, renders, and versions on disk are NOT affected.',
    });
    if (confirm.response !== 1) return { ok: false, canceled: true };

    const cfgPath = path.join(app.getPath('userData'), 'config.json');
    for (const p of [cfgPath, SETTINGS_PATH]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); }
        catch (e) { console.warn('[reset] could not delete', p, e.message); }
    }

    for (const w of BrowserWindow.getAllWindows()) {
        if (w !== wizardWin) { try { w.close(); } catch (_) {} }
    }
    openWizardWindow('first-run');
    return { ok: true };
});

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(() => {
    buildAppMenu();
    {
        const pr = resolvePythonPath();
        PYTHON_EXE = pr.path;
        PYTHON_EXE_NOCONSOLE = SP.resolveNoConsolePython(PYTHON_EXE);
        PYTHON_VERSION = pr.version || null;
        PYTHON_INRANGE = pr.inRange !== false;   // default-allow for env paths
        const vStr = PYTHON_VERSION ? PYTHON_VERSION.full : 'unknown';
        console.log(`[python] using interpreter: ${PYTHON_EXE} `
                  + `(source=${pr.source}, version=${vStr}, inRange=${PYTHON_INRANGE})`);
        if (!PYTHON_INRANGE) {
            // Log loudly so the first-page log shows the problem even before
            // the user attempts a relink. Status-strip warning fires after
            // the renderer loads (see checkRuntimeFallbacks).
            console.error(`[python] WARNING: detected Python ${vStr} is outside `
                        + `the supported range (${detect.SUPPORTED_PYTHON.label}). `
                        + `Resolve relink will refuse to spawn.`);
        }
    }
    maybeMigrateExistingInstall();
    applyConfig();
    seedCurrentProject();
    syncResolveScripts();
    const cfg = readConfig();
    if (!cfg || !cfg.setupComplete) openWizardWindow();
    else createWindow();
    // Defer the runtime + script-version checks until after the renderer
    // has loaded so emitStatus() actually reaches the strip. 1500ms is
    // enough for createWindow's loadFile to wire status:update.
    setTimeout(() => {
        try { checkRuntimeFallbacks(); } catch (e) { console.warn('runtime check failed:', e.message); }
        try { checkScriptsVersion();    } catch (e) { console.warn('scripts-version check failed:', e.message); }
    }, 1500);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
