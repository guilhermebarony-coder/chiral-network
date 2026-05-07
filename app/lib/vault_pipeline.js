// lib/vault_pipeline.js — End-to-end Vault orchestration (state-free-ish).
//
// This is the glue between lib/asset.js (schema), lib/vault.js (layout),
// lib/spawn.js (AE dispatch), and lib/proxy.js (ffmpeg). It does NOT require
// electron — callers pass everything via ctx so tests can drive it with
// mocks. main.js is the only producer of a real ctx.
//
// Session 4 Part B entry points:
//
//   vaultShot(ctx, { projectDir, projectName, shotName, finalVersion })
//     Mints an assetId, spawns vault_collect.jsx against the shot's .aep,
//     waits for the sentinel, copies the final-version master, kicks off
//     proxy+thumbnail (async), writes asset.json, rebuilds index.json.
//     Returns the full asset object on success.
//
//   importAssetToResolve(ctx, { assetId, targetProject, newShotName, atPlayhead })
//     Copies <vault>/assets/<id>/master.* → new shot's versions/v01/, writes
//     job.json, runs the existing relink pipeline. Appends to asset.usage[].
//
//   importAssetToAE(ctx, { assetId, targetProject, newShotName })
//     Copies <vault>/assets/<id>/ae/ → new shot's ae/ dir, launches AE on
//     the copied .aep. Appends to asset.usage[].
//
// ctx shape (produced by main.js):
//   AE_EXE, VAULT_COLLECT_JSX, FFMPEG_EXE (optional),
//   vaultRoot, chiralVersion, userEmail (optional),
//   spawnAE(jsxPath, pointerPath, jobPath) -> Promise<void>,
//   emitStatus(text, kind) -> void,      // pass-through to main.emitStatus
//   readProjectSpec(projectName) -> {fps,width,height}|null  // for import Spec Lock reuse
//
// Grep anchor: VAULT_PIPELINE — the orchestration contract.

const fs   = require('fs');
const path = require('path');

const A = require('./asset');
const V = require('./vault');
const PX = require('./proxy');

const POINTER_NAME   = 'roundtrip_current_vaultjob.txt';
const DONE_POLL_MS   = 500;
const DONE_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min max — Collect Files can be slow

// ---- helpers ---------------------------------------------------------------

function fwd(p) { return (p || '').replace(/\\/g, '/'); }

// dev16 #5 — best-effort unlink. Used for cleaning up TEMP-dir job files
// after AE has read them (which we know from the sentinel arriving).
// Pre-dev16 these accumulated forever — every vault op left a few KB
// behind in %TEMP%/. Now they're cleaned on success or sentinel'd
// failure; only the AE-timeout case leaves them for forensics.
function _quietUnlink(p) {
    try { fs.unlinkSync(p); } catch (_) {}
}

// dev16 #2 — partition a list of clip absolute paths into "files we can
// actually use" and "files that are gone." Pre-dev16 a single missing
// file aborted the entire import; now we proceed with what's present
// and surface the rest as a skipped[] in the result.
function _partitionExistingClips(clipAbs) {
    const present = [];
    const missing = [];
    for (const ap of clipAbs) {
        if (fs.existsSync(ap)) present.push(ap);
        else missing.push(ap);
    }
    return { present, missing };
}

// Copy a file with a stream. We use copyFileSync for simplicity; master
// renders are typically 100 MB – 2 GB and copyFileSync is plenty fast on
// local NTFS. If this ever shows up in a profile, switch to a progress-
// reporting streaming copy and pipe updates through emitStatus.
function copyFile(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

// Recursive dir copy. No-op on same-path. Uses fs.cpSync (Node 16.7+) which
// handles symlinks and attrs sensibly.
function copyDir(src, dst) {
    if (path.resolve(src) === path.resolve(dst)) return;
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true, dereference: false, errorOnExist: false });
}

// Poll for one of two sentinel files. Returns { ok, payload } from the
// done file, or { ok:false, error } from the error file, or { ok:false,
// error:'timeout' }.
async function pollForSentinel(doneFlag, errorFlag, timeoutMs = DONE_TIMEOUT_MS, pollMs = DONE_POLL_MS) {
    const t0 = Date.now();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    while (Date.now() - t0 < timeoutMs) {
        if (fs.existsSync(doneFlag)) {
            try {
                const payload = JSON.parse(fs.readFileSync(doneFlag, 'utf8'));
                try { fs.unlinkSync(doneFlag); } catch (_) {}
                return { ok: !!payload.ok, payload };
            } catch (e) {
                return { ok: false, error: 'malformed done flag: ' + e.message };
            }
        }
        if (fs.existsSync(errorFlag)) {
            try {
                const payload = JSON.parse(fs.readFileSync(errorFlag, 'utf8'));
                try { fs.unlinkSync(errorFlag); } catch (_) {}
                return { ok: false, error: payload.error || 'AE reported error', payload };
            } catch (e) {
                return { ok: false, error: 'malformed error flag: ' + e.message };
            }
        }
        await sleep(pollMs);
    }
    // dev16 — `timedOut` lets callers distinguish "AE crashed and wrote an
    // error sentinel" from "we never heard back at all" without parsing
    // strings. Used by the temp-cleanup paths in vaultShot/clipShot/
    // importClipToAE: we keep the job file around on timeouts (forensics)
    // but remove it on every other outcome.
    return { ok: false, error: 'timeout waiting for AE sentinel', timedOut: true };
}

// dev15 — collision-safe shot name. If <targetProjectDir>/<baseName> already
// exists (folder OR file), suffix with _2, _3, … until we find something
// free. Pre-dev15 we silently fs.cpSync(force:true) into the existing
// folder, which clobbered any prior import of the same asset into the
// same project. Returns the resolved name (may equal baseName).
function _availableShotName(targetProjectDir, baseName) {
    let name = baseName;
    let n = 2;
    // Hard cap so a stat-storm bug can't loop forever; in practice users
    // re-import the same asset a handful of times, not 999.
    while (fs.existsSync(path.join(targetProjectDir, name)) && n < 1000) {
        name = `${baseName}_${n}`;
        n++;
    }
    return name;
}

// Find the latest master render in a shot's versions/<finalVersion>/. The
// naming convention (from render_version.jsx) is
// <masterBasename>.<mov|mp4>; we take the first non-preview media file.
function findMasterInVersion(versionDir) {
    if (!fs.existsSync(versionDir)) return null;
    const files = fs.readdirSync(versionDir);
    // Prefer ProRes masters over H.264 previews. render_version writes the
    // preview as "<basename>_preview.mp4"; skip that.
    const masters = files.filter(f => /\.(mov|mp4|mxf)$/i.test(f) && !/_preview\.mp4$/i.test(f));
    if (masters.length === 0) return null;
    // Sort by size desc — master is always bigger than any other artifact.
    masters.sort((a, b) => fs.statSync(path.join(versionDir, b)).size
                        - fs.statSync(path.join(versionDir, a)).size);
    return path.join(versionDir, masters[0]);
}

// Precondition check: can this shot be vaulted right now?
// Returns { ok, reason?, finalVersion?, masterPath?, hasMaster }.
//
// Design (dev8, per user feedback): the vault's primary value is the AE
// project + its collected footage — not the master render. A shot is
// legitimately vaultable at any stage of its life (work-in-progress,
// reference, cross-project footage transfer, etc.). So the ONLY hard
// requirements are:
//   1. source/job.json exists (can't do anything without the shot metadata)
//   2. aepPath resolves to a real file (needed for AE Collect Files)
//
// A final version + master render are used when present but no longer
// block vaulting. `hasMaster: false` signals to the pipeline to skip the
// master-copy step and leave asset.files.master = null.
//
// Also fixes a folder-name typo: the actual render layout is
// `renders/vNN/`, not `versions/vNN/` — this caused every vault attempt
// on a real shot to be greyed out pre-dev8.
function canVaultShot(projectDir, shotName) {
    const shotDir = path.join(projectDir, shotName);
    const jobPath = path.join(shotDir, 'source', 'job.json');
    if (!fs.existsSync(jobPath)) {
        return { ok: false, reason: 'Shot has no job.json — run export_range from Resolve first.' };
    }
    let job;
    try { job = JSON.parse(fs.readFileSync(jobPath, 'utf8')); }
    catch (e) { return { ok: false, reason: 'job.json unparseable: ' + e.message }; }

    if (!job.aepPath || !fs.existsSync(job.aepPath)) {
        return { ok: false, reason: 'AE project file missing — open the shot in AE at least once.' };
    }

    // Optional — find a master render if one exists. Don't block if not.
    let finalVersion = job.finalVersion || null;
    let masterPath   = null;
    if (finalVersion) {
        const versionDir = path.join(shotDir, 'renders', finalVersion);
        if (fs.existsSync(versionDir)) {
            masterPath = findMasterInVersion(versionDir);
        }
    }
    // Even without finalVersion, pick the newest vNN that has a master —
    // useful for WIP shots the user hasn't marked yet.
    if (!masterPath) {
        const rendersRoot = path.join(shotDir, 'renders');
        if (fs.existsSync(rendersRoot)) {
            const versions = fs.readdirSync(rendersRoot)
                .filter(n => /^v\d+$/.test(n))
                .sort()
                .reverse();
            for (const v of versions) {
                const p = findMasterInVersion(path.join(rendersRoot, v));
                if (p) { masterPath = p; if (!finalVersion) finalVersion = v; break; }
            }
        }
    }

    return {
        ok: true,
        finalVersion,
        masterPath,
        hasMaster: !!masterPath,
        // dev18 #7 — surface the parsed job so callers (vaultShot,
        // clipShot) don't re-read+parse the same file. Pre-dev17 every
        // vault op opened source/job.json twice in quick succession.
        // The UI's canVaultShot consumer ignores this field; that's fine,
        // JSON over IPC is structured-cloned and the bytes go away.
        job,
    };
}

// ---- vaultShot -------------------------------------------------------------

async function vaultShot(ctx, { projectDir, projectName, shotName, finalVersion, tags }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot) return { ok: false, error: 'No VaultRoot configured. Pick one in the Setup Wizard.' };
    if (!V.isVaultRoot(vaultRoot)) V.initVault(vaultRoot, { chiralVersion: ctx.chiralVersion });

    // ---- Gather source info (single source of truth via canVaultShot) ---
    // canVaultShot emits friendlier reasons than raw paths, and sharing it
    // with the UI's grey-out keeps the two in lockstep.
    const pre = canVaultShot(projectDir, shotName);
    if (!pre.ok) return { ok: false, error: pre.reason };
    const shotDir = path.join(projectDir, shotName);
    // dev18 #7 —reuse the parse from canVaultShot.
    const job = pre.job;
    // Master render is OPTIONAL (dev8). If the caller pinned a specific
    // version, honor it; otherwise use whatever canVaultShot found (which
    // may be null). A null master just means the asset is vaulted without
    // a reference render — the AE project + footage still make it through.
    const chosenVersion = finalVersion || pre.finalVersion || null;
    let masterSrc = null;
    if (chosenVersion) {
        if (chosenVersion === pre.finalVersion && pre.masterPath) {
            masterSrc = pre.masterPath;
        } else {
            const versionDir = path.join(shotDir, 'renders', chosenVersion);
            masterSrc = findMasterInVersion(versionDir);
        }
    }
    const aepPath = job.aepPath;

    // ---- Mint asset dir --------------------------------------------------
    const assetId  = A.newAssetId();
    const assetDir = V.assetDirOf(vaultRoot, assetId);
    fs.mkdirSync(assetDir, { recursive: true });
    const aeTarget = path.join(assetDir, 'ae');

    ctx.emitStatus && ctx.emitStatus(`Vaulting ${shotName} → ${assetId.slice(0, 8)}…`, 'busy');

    // ---- Phase B: AE handoff --------------------------------------------
    const tempDir   = (ctx.tempDir || require('os').tmpdir());
    const pointer   = path.join(tempDir, POINTER_NAME);
    const vaultJob  = path.join(tempDir, `vaultjob_${assetId}.json`);
    const doneFlag  = path.join(assetDir, A.ASSET_FILES.doneFlag);
    const errorFlag = path.join(assetDir, A.ASSET_FILES.errorLog);

    // Clean any stale sentinels from a prior aborted attempt.
    try { fs.unlinkSync(doneFlag); }  catch (_) {}
    try { fs.unlinkSync(errorFlag); } catch (_) {}

    const jobPayload = {
        aepPath:   fwd(aepPath),
        targetDir: fwd(aeTarget),
        compName:  shotName,
        doneFlag:  fwd(doneFlag),
        errorFlag: fwd(errorFlag),
    };
    fs.writeFileSync(vaultJob, JSON.stringify(jobPayload, null, 2), 'utf8');

    // dev20 — serialize against AE's "one script at a time" host. Lock is
    // held across BOTH the spawnAE dispatch AND the sentinel poll, since the
    // running JSX is what AE refuses to run another script alongside.
    const releaseLock = ctx.acquireAELock
        ? await ctx.acquireAELock('vault:collect:' + assetId.slice(0, 8))
        : (() => {});
    let sentinel;
    try {
        try {
            await ctx.spawnAE(ctx.VAULT_COLLECT_JSX, pointer, vaultJob);
        } catch (e) {
            _quietUnlink(vaultJob);
            return { ok: false, error: 'AE dispatch failed: ' + e.message };
        }

        sentinel = await pollForSentinel(doneFlag, errorFlag);
    } finally {
        // Always release — even on early returns, even on throws. The
        // safety-net auto-release in spawn.js will catch a forgotten release
        // but we should never rely on it.
        releaseLock();
    }
    // dev16 #5 — temp job file is consumed; AE wrote a sentinel so it's
    // safe to remove. Timeout case keeps the file for log correlation.
    if (!sentinel.timedOut) {
        _quietUnlink(vaultJob);
    }
    if (!sentinel.ok) {
        // Leave the half-baked assetDir under .trash/ so the UUID isn't
        // recycled and we have forensics for debugging.
        const trashPath = path.join(V.trashDirOf(vaultRoot), `${assetId}-failed-${Date.now()}`);
        try { fs.renameSync(assetDir, trashPath); } catch (_) {}
        return { ok: false, error: sentinel.error, assetId };
    }

    const aePayload = sentinel.payload;   // { ok, aepRelPath, fonts, plugins, footage, aeVersion, compSettings, ... }

    // ---- Copy master render (optional — dev8) ---------------------------
    // If no master render exists (WIP shot, cross-project footage copy),
    // skip the copy and leave masterDst=null. The asset is still useful;
    // callers that need a master (importToResolve) will emit a clear error.
    let masterDst = null;
    let masterExt = null;
    if (masterSrc) {
        masterExt = path.extname(masterSrc);
        masterDst = path.join(assetDir, 'master' + masterExt);
        try { copyFile(masterSrc, masterDst); }
        catch (e) { return { ok: false, error: 'Failed to copy master: ' + e.message, assetId }; }
    }

    // ---- Build asset.json -----------------------------------------------
    const cs = aePayload.compSettings || {};
    const specAtVault = {
        fps:    Number(cs.frameRate) || Number(job.fps) || 0,
        width:  parseInt(cs.width,  10) || parseInt(job.width,  10) || 0,
        height: parseInt(cs.height, 10) || parseInt(job.height, 10) || 0,
        durationFrames: cs.durationFrames || null,
        colorSpace:     null,   // TODO: read from AE project in dev3
    };

    // Merge user-supplied tags with AE comp-marker tags (CHIRAL:TAG=<value>).
    // Dedup case-insensitively so a user-entered "hero" and a marker-sourced
    // "Hero" don't both end up on the asset. User tags win on case.
    const markerTags = Array.isArray(aePayload.markerTags) ? aePayload.markerTags : [];
    const userTags   = Array.isArray(tags) ? tags : [];
    const mergedTags = (() => {
        const seen = Object.create(null);
        const out = [];
        for (const t of userTags.concat(markerTags)) {
            const key = String(t || '').trim().toLowerCase();
            if (!key || seen[key]) continue;
            seen[key] = true;
            out.push(String(t).trim());
        }
        return out;
    })();

    const asset = A.createAsset({
        assetId,
        name:  job.label || shotName,
        kind:  'shot',
        tags:  mergedTags,
        origin: {
            projectName:   projectName,
            shotName:      shotName,
            chiralVersion: ctx.chiralVersion || null,
            vaultedAt:     new Date().toISOString(),
            vaultedBy:     ctx.userEmail || null,
            sourceJobId:   job.jobId || null,
            aeVersion:     (aePayload.aeVersion && aePayload.aeVersion.version) || null,
        },
        specAtVault,
    });

    asset.files.master    = masterDst ? ('master' + masterExt) : null;
    asset.files.aeRoot    = aePayload.aeRootRel   || 'ae/';
    asset.files.aeProject = aePayload.aepRelPath  || null;
    // proxy + thumb paths are stamped AFTER ffmpeg finishes (see below).

    asset.dependencies.footage = Array.isArray(aePayload.footage) ? aePayload.footage : [];
    asset.dependencies.fonts   = Array.isArray(aePayload.fonts)   ? aePayload.fonts   : [];
    asset.dependencies.plugins = Array.isArray(aePayload.plugins) ? aePayload.plugins : [];

    try { A.writeAsset(assetDir, asset); }
    catch (e) { return { ok: false, error: 'asset validation failed: ' + e.message, assetId }; }

    // ---- Kick off proxy + thumbnail (queued, non-blocking) ---------------
    // Only queued when we actually have a master to transcode; without one
    // the asset card just shows a placeholder (pre-existing behavior when
    // proxy fails). The asset is BROWSABLE at this point regardless.
    const proxyLog = path.join(assetDir, A.ASSET_FILES.proxyLog);
    const durSec   = Number(cs.duration) || 1;

    if (!masterDst) {
        V.rebuildIndex(vaultRoot);
        ctx.emitStatus && ctx.emitStatus(`Vaulted ${asset.name} (no master render — AE + footage only).`, 'ok');
        return { ok: true, assetId, assetDir, asset };
    }

    PX.enqueue(async () => {
        const r = await PX.generateProxy({
            inputPath:  masterDst,
            outputPath: path.join(assetDir, A.ASSET_FILES.proxy),
            logPath:    proxyLog,
            ffmpegExe:  ctx.FFMPEG_EXE,
        });
        if (r.ok) {
            // Re-read asset (in case it was edited meanwhile) and stamp proxy.
            const cur = A.readAsset(assetDir);
            if (cur) { cur.files.proxy = A.ASSET_FILES.proxy; A.writeAsset(assetDir, cur); }
            V.rebuildIndex(vaultRoot);
            ctx.emitStatus && ctx.emitStatus(`Proxy ready for ${asset.name}`, 'ok');
        } else {
            ctx.emitStatus && ctx.emitStatus(`Proxy failed for ${asset.name}: ${r.error}`, 'error');
        }
    });

    PX.enqueue(async () => {
        const r = await PX.generateThumbnail({
            inputPath:   masterDst,
            outputPath:  path.join(assetDir, A.ASSET_FILES.thumbnail),
            logPath:     proxyLog,
            ffmpegExe:   ctx.FFMPEG_EXE,
            durationSec: durSec,
        });
        if (r.ok) {
            const cur = A.readAsset(assetDir);
            if (cur) { cur.files.thumbnail = A.ASSET_FILES.thumbnail; A.writeAsset(assetDir, cur); }
            V.rebuildIndex(vaultRoot);
        }
    });

    V.rebuildIndex(vaultRoot);
    ctx.emitStatus && ctx.emitStatus(`Vaulted ${asset.name}.`, 'ok');
    return { ok: true, assetId, assetDir, asset };
}

// ---- vaultExternalAep (dev33) ----------------------------------------------
// Vault an .aep that lives OUTSIDE the Chiral project tree — e.g. a
// reusable framework someone shared, an animation downloaded from a
// stock library, anything not born of `New shot from AE` or
// `export_range`.
//
// Same downstream pipeline as vaultShot:
//   1. Mint an asset dir under <vault>/assets/<id>/
//   2. Spawn vault_collect.jsx with a fabricated job pointer that
//      carries the .aep path + asset's ae/ target dir
//   3. Wait for the sentinel; abort to .trash/ on failure
//   4. Build asset.json with origin.projectName='(External)' so the
//      vault grid still groups it sensibly, and the user can search
//      "external" to find every imported one.
//
// What we DON'T do:
//   * No master render copy (no shot context = no version folder).
//     The asset lands without a proxy/thumbnail, mirroring the
//     dev8 "no master" path. AE-side we still get a frame thumbnail
//     for procedural templates, but a vanilla collected .aep gets
//     no preview — the user can render one later via the legacy
//     "open as new shot" flow.
//   * No origin.shotName / finalVersion / sourceJobId — those
//     fields are nullable in the schema for exactly this case.
async function vaultExternalAep(ctx, { aepPath, displayName, tags }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot) return { ok: false, error: 'No VaultRoot configured. Pick one in the Setup Wizard.' };
    if (!V.isVaultRoot(vaultRoot)) V.initVault(vaultRoot, { chiralVersion: ctx.chiralVersion });

    if (!aepPath || typeof aepPath !== 'string') {
        return { ok: false, error: 'aepPath required' };
    }
    if (!fs.existsSync(aepPath)) {
        return { ok: false, error: 'AE project file not found on disk: ' + aepPath };
    }
    if (!/\.aep$/i.test(aepPath)) {
        return { ok: false, error: 'Not an .aep file: ' + path.basename(aepPath) };
    }

    // Display name: caller-supplied, otherwise derive from the .aep
    // basename without the extension. Sanitize lightly — the asset name
    // is just metadata, but trimming whitespace + capping length keeps
    // grid layout predictable.
    const fallbackName = path.basename(aepPath, path.extname(aepPath));
    const name = String(displayName || fallbackName || 'External asset').trim().slice(0, 80);

    const assetId  = A.newAssetId();
    const assetDir = V.assetDirOf(vaultRoot, assetId);
    fs.mkdirSync(assetDir, { recursive: true });
    const aeTarget = path.join(assetDir, 'ae');

    ctx.emitStatus && ctx.emitStatus(`Vaulting external "${name}" → ${assetId.slice(0, 8)}…`, 'busy');

    const tempDir   = (ctx.tempDir || require('os').tmpdir());
    const pointer   = path.join(tempDir, POINTER_NAME);
    const vaultJob  = path.join(tempDir, `vaultjob_${assetId}.json`);
    const doneFlag  = path.join(assetDir, A.ASSET_FILES.doneFlag);
    const errorFlag = path.join(assetDir, A.ASSET_FILES.errorLog);
    try { fs.unlinkSync(doneFlag); }  catch (_) {}
    try { fs.unlinkSync(errorFlag); } catch (_) {}

    fs.writeFileSync(vaultJob, JSON.stringify({
        aepPath:   fwd(aepPath),
        targetDir: fwd(aeTarget),
        // compName: null — vault_collect.jsx falls back to its
        // longest-comp / CHIRAL:VAULT-marker heuristic when the job
        // doesn't pin a specific comp. That's what we want for
        // external imports (the user didn't select one).
        compName:  null,
        doneFlag:  fwd(doneFlag),
        errorFlag: fwd(errorFlag),
    }, null, 2), 'utf8');

    // dev20 — same scripting lock as the rest of the vault flows.
    const releaseLock = ctx.acquireAELock
        ? await ctx.acquireAELock('vault:external:' + assetId.slice(0, 8))
        : (() => {});
    let sentinel;
    try {
        try { await ctx.spawnAE(ctx.VAULT_COLLECT_JSX, pointer, vaultJob); }
        catch (e) {
            _quietUnlink(vaultJob);
            return { ok: false, error: 'AE dispatch failed: ' + e.message };
        }
        sentinel = await pollForSentinel(doneFlag, errorFlag);
    } finally { releaseLock(); }

    if (!sentinel.timedOut) _quietUnlink(vaultJob);
    if (!sentinel.ok) {
        const trashPath = path.join(V.trashDirOf(vaultRoot), `${assetId}-failed-${Date.now()}`);
        try { fs.renameSync(assetDir, trashPath); } catch (_) {}
        return { ok: false, error: sentinel.error, assetId };
    }

    const aePayload = sentinel.payload;
    const cs = aePayload.compSettings || {};
    const specAtVault = {
        fps:    Number(cs.frameRate)       || 0,
        width:  parseInt(cs.width,  10)    || 0,
        height: parseInt(cs.height, 10)    || 0,
        durationFrames: cs.durationFrames  || null,
        colorSpace:     null,
    };

    const markerTags = Array.isArray(aePayload.markerTags) ? aePayload.markerTags : [];
    const userTags   = Array.isArray(tags) ? tags : [];
    const mergedTags = (() => {
        const seen = Object.create(null);
        const out = [];
        for (const t of userTags.concat(markerTags)) {
            const key = String(t || '').trim().toLowerCase();
            if (!key || seen[key]) continue;
            seen[key] = true;
            out.push(String(t).trim());
        }
        return out;
    })();

    const asset = A.createAsset({
        assetId,
        type:  'asset',
        name,
        kind:  'animation',
        tags:  mergedTags,
        origin: {
            // dev33 — sentinel project name so external imports are
            // searchable / sortable as a group. shotName carries the
            // .aep basename so the origin block still answers "where
            // did this come from?".
            projectName:   '(External)',
            shotName:      path.basename(aepPath),
            chiralVersion: ctx.chiralVersion || null,
            vaultedAt:     new Date().toISOString(),
            vaultedBy:     ctx.userEmail || null,
            sourceJobId:   null,
            aeVersion:     (aePayload.aeVersion && aePayload.aeVersion.version) || null,
        },
        specAtVault,
    });

    asset.files.master    = null;            // no shot, no master
    asset.files.aeRoot    = aePayload.aeRootRel  || 'ae/';
    asset.files.aeProject = aePayload.aepRelPath || null;
    asset.dependencies.footage = Array.isArray(aePayload.footage) ? aePayload.footage : [];
    asset.dependencies.fonts   = Array.isArray(aePayload.fonts)   ? aePayload.fonts   : [];
    asset.dependencies.plugins = Array.isArray(aePayload.plugins) ? aePayload.plugins : [];

    try { A.writeAsset(assetDir, asset); }
    catch (e) { return { ok: false, error: 'asset validation failed: ' + e.message, assetId }; }

    V.rebuildIndex(vaultRoot);
    ctx.emitStatus && ctx.emitStatus(`Vaulted external "${asset.name}".`, 'ok');
    return { ok: true, assetId, assetDir, asset };
}

// ---- clipShot (dev13) ------------------------------------------------------
// Clip-mode vault — no .aep, no comp graph, just the files the user tagged
// with CHIRAL:CLIP in AE's Project panel Comment column. See vault_clip.jsx
// for the marker convention.
//
// Pre-flight is intentionally light: we delegate "is there anything to
// vault" to the AE script (which throws "no clip-tagged footage found"
// into the error sentinel if nothing matches). canVaultShot's existing
// job.json + aepPath checks are reused.

async function clipShot(ctx, { projectDir, projectName, shotName, tags }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot) return { ok: false, error: 'No VaultRoot configured. Pick one in the Setup Wizard.' };
    if (!V.isVaultRoot(vaultRoot)) V.initVault(vaultRoot, { chiralVersion: ctx.chiralVersion });

    const pre = canVaultShot(projectDir, shotName);
    if (!pre.ok) return { ok: false, error: pre.reason };
    const shotDir = path.join(projectDir, shotName);
    // dev18 #7 —reuse the parse from canVaultShot (clipShot path).
    const job     = pre.job;
    const aepPath = job.aepPath;

    // Mint asset dir
    const assetId  = A.newAssetId();
    const assetDir = V.assetDirOf(vaultRoot, assetId);
    fs.mkdirSync(assetDir, { recursive: true });

    ctx.emitStatus && ctx.emitStatus(`Vaulting clips from ${shotName} → ${assetId.slice(0, 8)}…`, 'busy');

    const tempDir   = (ctx.tempDir || require('os').tmpdir());
    const pointer   = path.join(tempDir, 'roundtrip_current_clipjob.txt');
    const clipJob   = path.join(tempDir, `clipjob_${assetId}.json`);
    const doneFlag  = path.join(assetDir, A.ASSET_FILES.doneFlag);
    const errorFlag = path.join(assetDir, A.ASSET_FILES.errorLog);
    try { fs.unlinkSync(doneFlag); }  catch (_) {}
    try { fs.unlinkSync(errorFlag); } catch (_) {}

    fs.writeFileSync(clipJob, JSON.stringify({
        aepPath:   fwd(aepPath),
        targetDir: fwd(assetDir),
        // dev23 — vault_clip.jsx mints procedural-asset dirs on the fly
        // for each comp/layer template, so it needs to know the vault
        // root. (File-clip output still goes into targetDir as before.)
        vaultRoot: fwd(vaultRoot),
        doneFlag:  fwd(doneFlag),
        errorFlag: fwd(errorFlag),
    }, null, 2), 'utf8');

    if (!ctx.VAULT_CLIP_JSX) return { ok: false, error: 'VAULT_CLIP_JSX path not configured in ctx' };

    // dev20 — see vaultShot: lock the AE-resident block.
    const releaseLock = ctx.acquireAELock
        ? await ctx.acquireAELock('vault:clip:' + assetId.slice(0, 8))
        : (() => {});
    let sentinel;
    try {
        try { await ctx.spawnAE(ctx.VAULT_CLIP_JSX, pointer, clipJob); }
        catch (e) {
            _quietUnlink(clipJob);
            return { ok: false, error: 'AE dispatch failed: ' + e.message };
        }
        sentinel = await pollForSentinel(doneFlag, errorFlag);
    } finally {
        releaseLock();
    }
    // dev16 #5 — same TEMP-cleanup contract as vaultShot.
    if (!sentinel.timedOut) {
        _quietUnlink(clipJob);
    }
    if (!sentinel.ok) {
        const trashPath = path.join(V.trashDirOf(vaultRoot), `${assetId}-failed-${Date.now()}`);
        try { fs.renameSync(assetDir, trashPath); } catch (_) {}
        return { ok: false, error: sentinel.error, assetId };
    }

    const aePayload = sentinel.payload;
    const clipList  = Array.isArray(aePayload.clips) ? aePayload.clips : [];
    const procList  = Array.isArray(aePayload.proceduralAssets) ? aePayload.proceduralAssets : [];

    // Tag merge — same dedup pattern as vaultShot. Used for the file-clip
    // asset; procedural-asset tags come pre-merged from the AE side.
    const markerTags = Array.isArray(aePayload.markerTags) ? aePayload.markerTags : [];
    const userTags   = Array.isArray(tags) ? tags : [];
    const mergedTags = (() => {
        const seen = Object.create(null);
        const out = [];
        for (const t of userTags.concat(markerTags)) {
            const key = String(t || '').trim().toLowerCase();
            if (!key || seen[key]) continue;
            seen[key] = true;
            out.push(String(t).trim());
        }
        return out;
    })();

    // dev23 — assetDir was minted unconditionally at the top of clipShot
    // for the file-clip case. If the user only marked procedural items
    // (comps / layers), we never write into assetDir and want to remove
    // the empty placeholder so the vault doesn't accumulate ghost dirs.
    if (clipList.length > 0) {
        // Spec for file clips: copied from job.json (the shot's locked
        // spec) since we have no comp settings to harvest from a bag of
        // files. Clips are spec-agnostic by design — they get
        // re-interpreted by AE on import — but we record the spec they
        // were vaulted FROM for provenance.
        const specAtVault = {
            fps:    Number(job.fps)    || 0,
            width:  parseInt(job.width,  10) || 0,
            height: parseInt(job.height, 10) || 0,
            durationFrames: null,
            colorSpace:     null,
        };

        const asset = A.createAsset({
            assetId,
            type:  'clip',
            name:  job.label ? `${job.label} (clips)` : `${shotName} (clips)`,
            kind:  'shot',
            tags:  mergedTags,
            origin: {
                projectName:   projectName,
                shotName:      shotName,
                chiralVersion: ctx.chiralVersion || null,
                vaultedAt:     new Date().toISOString(),
                vaultedBy:     ctx.userEmail || null,
                sourceJobId:   job.jobId || null,
                aeVersion:     (aePayload.aeVersion && aePayload.aeVersion.version) || null,
            },
            specAtVault,
        });

        asset.files.clips = clipList.map(c => c.relPath);
        asset.dependencies.footage = clipList.map(c => ({
            relPath:      c.relPath,
            bytes:        c.bytes || 0,
            name:         c.name,
            tags:         c.tags || [],
            originalPath: c.originalPath || null,
        }));

        try { A.writeAsset(assetDir, asset); }
        catch (e) { return { ok: false, error: 'asset validation failed: ' + e.message, assetId }; }
    } else {
        // Tear down the empty placeholder so we don't leave a ghost asset
        // dir behind. fs.rmSync recursive is fine — the dir literally
        // contains nothing yet (mini.aep template assets minted their
        // OWN dirs in the JSX).
        try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ---- Procedural templates (dev23) -----------------------------------
    // For each comp/layer template the AE script extracted, finalize the
    // asset on the Node side using A.createAsset so schema knowledge stays
    // in one place. The mini.aep itself is already on disk under
    // <vaultRoot>/assets/<id>/ae/<name>.aep; we just stamp asset.json.
    const finalizedProceduralIds = [];
    for (const proc of procList) {
        if (!A.isValidAssetId(proc.assetId)) {
            ctx.emitStatus && ctx.emitStatus(
                `Skipping template "${proc.name}" — bad assetId from AE script`, 'error');
            continue;
        }
        const procDir = V.assetDirOf(vaultRoot, proc.assetId);
        // Defensive: AE side already created procDir/ae/<file>.aep, but
        // double-check before stamping the manifest.
        if (!fs.existsSync(path.join(procDir, proc.aeProject || ''))) {
            ctx.emitStatus && ctx.emitStatus(
                `Skipping template "${proc.name}" — mini.aep missing on disk`, 'error');
            continue;
        }
        const procSpec = {
            fps:            Number((proc.specAtVault || {}).fps)    || 0,
            width:          parseInt((proc.specAtVault || {}).width,  10) || 0,
            height:         parseInt((proc.specAtVault || {}).height, 10) || 0,
            durationFrames: (proc.specAtVault || {}).durationFrames || null,
            colorSpace:     null,
        };
        const procAsset = A.createAsset({
            assetId: proc.assetId,
            // Procedural templates are full asset.aep bundles, just scoped
            // to one comp/layer — same `type:"asset"` as the legacy
            // vault-this-shot path. Keeps the import-into-open-AE flow
            // (dev19) working unchanged for these.
            type:    'asset',
            name:    proc.name,
            kind:    'shot',
            tags:    Array.isArray(proc.tags) ? proc.tags : [],
            origin: {
                projectName:   projectName,
                shotName:      shotName,
                chiralVersion: ctx.chiralVersion || null,
                vaultedAt:     new Date().toISOString(),
                vaultedBy:     ctx.userEmail || null,
                sourceJobId:   job.jobId || null,
                aeVersion:     (aePayload.aeVersion && aePayload.aeVersion.version) || null,
            },
            specAtVault: procSpec,
        });
        procAsset.files.aeRoot    = proc.aeRoot    || 'ae/';
        procAsset.files.aeProject = proc.aeProject || null;
        // dev24 — thumbnail rendered by vault_clip.jsx via saveFrameToPng
        // at the comp's midpoint. Null if AE's renderer threw (missing
        // font, expression error on first eval) — asset still works,
        // just shows the placeholder card.
        procAsset.files.thumbnail = proc.thumbnail || null;
        // Mark in dependencies which kind of template this came from —
        // useful telemetry for a future "show me all my comp templates"
        // filter in the vault UI.
        procAsset.dependencies.fonts   = [];
        procAsset.dependencies.plugins = [];
        procAsset.dependencies.footage = [{ templateKind: proc.kind || 'comp' }];

        try {
            A.writeAsset(procDir, procAsset);
            finalizedProceduralIds.push(proc.assetId);
        } catch (e) {
            ctx.emitStatus && ctx.emitStatus(
                `Template "${proc.name}" validation failed: ${e.message}`, 'error');
        }
    }

    V.rebuildIndex(vaultRoot);

    // Status — describe whatever we ended up with.
    const parts = [];
    if (clipList.length) parts.push(`${clipList.length} clip${clipList.length === 1 ? '' : 's'}`);
    if (finalizedProceduralIds.length) {
        parts.push(`${finalizedProceduralIds.length} template${finalizedProceduralIds.length === 1 ? '' : 's'}`);
    }
    const summary = parts.length ? parts.join(' + ') : 'nothing';
    ctx.emitStatus && ctx.emitStatus(`Vaulted ${summary} from ${shotName}.`, 'ok');

    return {
        ok:                true,
        // Backward-compat: assetId of the file-clip asset, or the first
        // template if no file clips. Existing UI code that reads `r.assetId`
        // still gets a usable id either way.
        assetId:           clipList.length ? assetId : (finalizedProceduralIds[0] || assetId),
        assetDir:          clipList.length ? assetDir : null,
        clipCount:         clipList.length,
        templateCount:     finalizedProceduralIds.length,
        templateAssetIds:  finalizedProceduralIds,
    };
}

// ---- importClipToAE (dev13) ------------------------------------------------
// Clip-mode import. Two paths:
//
//  (1) AE is open with a project — drop the files into the running project
//      via app.project.importFile(). This is the ergonomic path: the user
//      is in their working .aep and just wants the asset added as footage.
//
//  (2) AE is closed OR has no project open — fall back to the legacy
//      "create new shot folder" behavior so the asset still goes somewhere
//      retrievable. The user can open the new shot's .aep later.
//
// Detection is the AE script's job (it knows whether app.project.file is
// null). The caller hands us a flag from the UI; if "intoOpen" is true we
// dispatch the import-into-open script, else we copy files into a new shot.

async function importClipToAE(ctx, { assetId, targetProjectDir, targetProjectName, newShotName, intoOpen }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot || !V.isVaultRoot(vaultRoot)) return { ok: false, error: 'No vault configured' };

    const assetDir = V.assetDirOf(vaultRoot, assetId);
    const asset    = A.readAsset(assetDir);
    if (!asset) return { ok: false, error: 'Asset not found: ' + assetId };
    if (asset.type !== 'clip') return { ok: false, error: 'Not a clip asset (use importAssetToAE for full assets)' };

    const clips = (asset.files && asset.files.clips) || [];
    if (clips.length === 0) return { ok: false, error: 'Clip asset has no files' };

    // dev16 #2 — skip-and-warn instead of all-or-nothing. If a clip file
    // got deleted from the vault dir (drive issue, partial restore from
    // trash, manual cleanup gone wrong), we proceed with what survives
    // rather than failing the whole import. The caller surfaces missing[]
    // alongside the success status so the user knows what they're missing.
    const clipAbs = clips.map(rel => path.join(assetDir, rel));
    const { present, missing } = _partitionExistingClips(clipAbs);
    if (present.length === 0) {
        return {
            ok: false,
            error: `All ${clipAbs.length} clip file(s) missing on disk — vault may be damaged.`,
            missing: missing.map(p => path.basename(p)),
        };
    }
    if (missing.length && ctx.emitStatus) {
        ctx.emitStatus(`${missing.length} clip file(s) missing — importing the rest`, 'info');
    }

    if (intoOpen) {
        // Drop into running AE project. The script reads the file list from
        // a job.json the same way the other AE scripts do, importFile()'s each
        // entry, organizes them in a Project-panel folder named after the
        // asset, and writes a done sentinel.
        if (!ctx.IMPORT_CLIPS_JSX) return { ok: false, error: 'IMPORT_CLIPS_JSX path not configured' };

        const tempDir   = (ctx.tempDir || require('os').tmpdir());
        const pointer   = path.join(tempDir, 'roundtrip_current_clipimport.txt');
        const importJob = path.join(tempDir, `clipimport_${assetId}.json`);
        // Sentinels go in the temp dir — we don't write into the asset dir
        // for an import (it's a read of the asset, not a mutation).
        const doneFlag  = path.join(tempDir, `clipimport_${assetId}.done.json`);
        const errorFlag = path.join(tempDir, `clipimport_${assetId}.error.json`);
        try { fs.unlinkSync(doneFlag); }  catch (_) {}
        try { fs.unlinkSync(errorFlag); } catch (_) {}

        fs.writeFileSync(importJob, JSON.stringify({
            assetName: asset.name,
            // dev16 #2 — only ship paths we verified exist a moment ago.
            clips:     present.map(fwd),
            doneFlag:  fwd(doneFlag),
            errorFlag: fwd(errorFlag),
        }, null, 2), 'utf8');

        // dev20 — lock the AE-resident block (see vaultShot).
        const releaseLock = ctx.acquireAELock
            ? await ctx.acquireAELock('vault:importClipToAE:' + assetId.slice(0, 8))
            : (() => {});
        let sentinel;
        try {
            try { await ctx.spawnAE(ctx.IMPORT_CLIPS_JSX, pointer, importJob); }
            catch (e) {
                _quietUnlink(importJob);
                return { ok: false, error: 'AE dispatch failed: ' + e.message };
            }

            // dev16 #6 — bumped from 5 min to the standard 15 min. Cold AE
            // boots from clean caches comfortably exceed 5 min on slower
            // boxes; matching pollForSentinel's default removes the false
            // timeout path.
            sentinel = await pollForSentinel(doneFlag, errorFlag);
        } finally {
            releaseLock();
        }
        // dev16 #5 — clean the temp job file once AE is done with it.
        // We know AE finished reading because a sentinel arrived. (On
        // timeout we leave it in place for forensics.)
        if (!sentinel.timedOut) {
            _quietUnlink(importJob);
        }
        if (!sentinel.ok) {
            return { ok: false, error: sentinel.error, missing: missing.map(p => path.basename(p)) };
        }

        const updated = A.appendUsage(asset, {
            toProject: targetProjectName || '(open AE project)',
            toShot:    sentinel.payload.projectFile || '(unsaved)',
            mode:      'copy',
        });
        A.writeAsset(assetDir, updated);
        V.rebuildIndex(vaultRoot);
        return {
            ok:       true,
            mode:     'into-open',
            imported: sentinel.payload.imported || present.length,
            missing:  missing.map(p => path.basename(p)),
        };
    }

    // Fallback: copy into a new shot dir under the target project.
    if (!targetProjectDir) return { ok: false, error: 'no target project (and AE not open)' };
    const baseShotName = newShotName || `${asset.origin.shotName || 'asset'}_clips_from_${asset.origin.projectName || 'vault'}`;
    const shotName     = _availableShotName(targetProjectDir, baseShotName);
    const renamed      = shotName !== baseShotName;
    const shotDir  = path.join(targetProjectDir, shotName);
    const clipsDst = path.join(shotDir, 'clips');
    fs.mkdirSync(clipsDst, { recursive: true });
    // dev16 #2 — iterate `present` (filtered list), not the raw clipAbs.
    for (const ap of present) {
        const dst = path.join(clipsDst, path.basename(ap));
        copyFile(ap, dst);
    }

    const updated = A.appendUsage(asset, {
        toProject: targetProjectName,
        toShot:    shotName,
        mode:      'copy',
    });
    A.writeAsset(assetDir, updated);
    V.rebuildIndex(vaultRoot);
    return {
        ok:      true,
        mode:    'new-shot',
        shotDir,
        shotName,
        renamed,
        copied:  present.length,
        missing: missing.map(p => path.basename(p)),
    };
}

// ---- import: Resolve -------------------------------------------------------

async function importAssetToResolve(ctx, { assetId, targetProjectDir, targetProjectName, newShotName, atPlayhead }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot || !V.isVaultRoot(vaultRoot)) return { ok: false, error: 'No vault configured' };

    const assetDir = V.assetDirOf(vaultRoot, assetId);
    const asset    = A.readAsset(assetDir);
    if (!asset) return { ok: false, error: 'Asset not found: ' + assetId };

    const masterRel = asset.files && asset.files.master;
    if (!masterRel) return { ok: false, error: 'Asset has no master file' };
    const masterSrc = path.join(assetDir, masterRel);
    if (!fs.existsSync(masterSrc)) return { ok: false, error: 'Master missing on disk: ' + masterSrc };

    // Spec Lock reuse — let main.js drive the modal via ctx.confirmSpecDrift.
    if (typeof ctx.confirmSpecDrift === 'function') {
        const targetSpec = ctx.readProjectSpec ? ctx.readProjectSpec(targetProjectName) : null;
        const proceed = await ctx.confirmSpecDrift({ lockedSpec: targetSpec, incomingSpec: asset.specAtVault, label: asset.name });
        if (!proceed) return { ok: false, error: 'User cancelled on spec mismatch' };
    }

    // Create the new shot dir + v01/<master>. Suffix on collision so we
    // don't clobber a prior import of the same asset (dev15 #1).
    const baseShotName = newShotName || `${asset.origin.shotName || 'asset'}_from_${asset.origin.projectName || 'vault'}`;
    const shotName     = _availableShotName(targetProjectDir, baseShotName);
    const renamed      = shotName !== baseShotName;
    const shotDir  = path.join(targetProjectDir, shotName);
    const versionDir = path.join(shotDir, 'versions', 'v01');
    fs.mkdirSync(versionDir, { recursive: true });
    const masterDst = path.join(versionDir, 'master' + path.extname(masterSrc));
    copyFile(masterSrc, masterDst);

    // Write a minimal job.json — enough for the relink pipeline to pick up.
    const jobOut = {
        jobId:            require('crypto').randomUUID(),
        shot:             shotName,
        fps:              asset.specAtVault.fps,
        width:            asset.specAtVault.width,
        height:           asset.specAtVault.height,
        duration:         (asset.specAtVault.durationFrames && asset.specAtVault.fps)
                          ? asset.specAtVault.durationFrames / asset.specAtVault.fps
                          : null,
        finalVersion:     'v01',
        activeVersion:    'v01',
        label:            asset.name,
        vaultedFromAssetId: asset.assetId,
        createdAt:        new Date().toISOString(),
    };
    const jobDir = path.join(shotDir, 'source');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(jobOut, null, 2), 'utf8');

    // Run relink if caller provided a runner.
    let relinkResult = null;
    if (typeof ctx.runRelink === 'function') {
        relinkResult = await ctx.runRelink({ shotDir, version: 'v01', atPlayhead: !!atPlayhead });
    }

    // Append to asset.usage[]
    const updated = A.appendUsage(asset, {
        toProject: targetProjectName,
        toShot:    shotName,
        mode:      'copy',
    });
    A.writeAsset(assetDir, updated);
    V.rebuildIndex(vaultRoot);

    return { ok: true, shotDir, shotName, renamed, relink: relinkResult };
}

// ---- import: After Effects -------------------------------------------------

async function importAssetToAE(ctx, { assetId, targetProjectDir, targetProjectName, newShotName }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot || !V.isVaultRoot(vaultRoot)) return { ok: false, error: 'No vault configured' };

    const assetDir = V.assetDirOf(vaultRoot, assetId);
    const asset    = A.readAsset(assetDir);
    if (!asset) return { ok: false, error: 'Asset not found: ' + assetId };

    const aeRootRel = asset.files && asset.files.aeRoot;
    const aepRel    = asset.files && asset.files.aeProject;
    if (!aeRootRel || !aepRel) return { ok: false, error: 'Asset has no AE project bundle' };

    const aeSrc = path.join(assetDir, aeRootRel);
    if (!fs.existsSync(aeSrc)) return { ok: false, error: 'AE bundle missing on disk' };

    // Pre-flight: plugin check (strict, design #4). Caller can supply an
    // installed-plugins probe via ctx.installedPlugins(); if absent, we
    // surface warnings without blocking.
    if (typeof ctx.installedPlugins === 'function') {
        const have = new Set(ctx.installedPlugins() || []);
        const missing = (asset.dependencies.plugins || []).filter(p => p.builtin === false && !have.has(p.matchName));
        if (missing.length && ctx.confirmMissingPlugins) {
            const proceed = await ctx.confirmMissingPlugins(missing);
            if (!proceed) return { ok: false, error: 'User cancelled on missing plugins' };
        }
    }
    // Font check is advisory (lenient, design #4). Caller can surface a toast
    // via ctx.emitStatus; we don't block here.
    const fontCount = (asset.dependencies.fonts || []).length;

    // dev15 #1 — suffix on collision so re-imports don't clobber. Critical
    // for the cross-project case where the user might import the same asset
    // into multiple projects with the same auto-generated base name.
    const baseShotName = newShotName || `${asset.origin.shotName || 'asset'}_from_${asset.origin.projectName || 'vault'}`;
    const shotName     = _availableShotName(targetProjectDir, baseShotName);
    const renamed      = shotName !== baseShotName;
    const shotDir  = path.join(targetProjectDir, shotName);
    const aeDst    = path.join(shotDir, 'ae');
    copyDir(aeSrc, aeDst);

    // Job.json for the new shot
    const aepBasename = path.basename(aepRel);
    const jobOut = {
        jobId:            require('crypto').randomUUID(),
        shot:             shotName,
        fps:              asset.specAtVault.fps,
        width:            asset.specAtVault.width,
        height:           asset.specAtVault.height,
        aepPath:          path.join(aeDst, aepBasename),
        label:            asset.name,
        vaultedFromAssetId: asset.assetId,
        createdAt:        new Date().toISOString(),
    };
    const jobDir = path.join(shotDir, 'source');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(jobOut, null, 2), 'utf8');

    const updated = A.appendUsage(asset, {
        toProject: targetProjectName,
        toShot:    shotName,
        mode:      'copy',
    });
    A.writeAsset(assetDir, updated);
    V.rebuildIndex(vaultRoot);

    if (fontCount && ctx.emitStatus) {
        ctx.emitStatus(`Imported ${asset.name} — ${fontCount} fonts referenced, verify on target machine.`, 'info');
    }
    return { ok: true, shotDir, shotName, renamed, aepPath: jobOut.aepPath };
}

// ---- importAssetToOpenAE (dev19) -------------------------------------------
// Asset-mode counterpart to importClipToAE's intoOpen branch. Dispatches
// scripts/ae/import_asset.jsx, which does
//
//   app.project.importFile(new ImportOptions(<asset>.aep))
//
// in the running AE — the same call AE makes when you File > Import > File
// on a .aep. The asset's comps + footage land under a top-level FolderItem
// named after the .aep basename. Footage refs inside the imported comps
// resolve to the vault's asset dir (paths in the .aep), so the user sees
// proper renders rather than missing-footage placeholders.
//
// The legacy importAssetToAE still exists for the "create a new shot from
// this asset" case — both share the asset-read / plugin-check pre-flight
// to avoid drift between branches.

async function importAssetToOpenAE(ctx, { assetId }) {
    const vaultRoot = ctx.vaultRoot;
    if (!vaultRoot || !V.isVaultRoot(vaultRoot)) return { ok: false, error: 'No vault configured' };

    const assetDir = V.assetDirOf(vaultRoot, assetId);
    const asset    = A.readAsset(assetDir);
    if (!asset) return { ok: false, error: 'Asset not found: ' + assetId };
    if (asset.type === 'clip') return { ok: false, error: 'Use importClipToAE for clip assets' };

    const aepRel = asset.files && asset.files.aeProject;
    if (!aepRel) return { ok: false, error: 'Asset has no AE project bundle' };
    const aepAbs = path.join(assetDir, aepRel);
    if (!fs.existsSync(aepAbs)) return { ok: false, error: 'AE project missing on disk: ' + aepAbs };

    // Pre-flight plugin check — same as importAssetToAE. If the user's
    // host is missing third-party effects the imported comps reference,
    // they'd see "Missing effect" placeholders without this nudge.
    if (typeof ctx.installedPlugins === 'function') {
        const have = new Set(ctx.installedPlugins() || []);
        const missing = (asset.dependencies.plugins || []).filter(p => p.builtin === false && !have.has(p.matchName));
        if (missing.length && ctx.confirmMissingPlugins) {
            const proceed = await ctx.confirmMissingPlugins(missing);
            if (!proceed) return { ok: false, error: 'User cancelled on missing plugins' };
        }
    }

    if (!ctx.IMPORT_ASSET_JSX) return { ok: false, error: 'IMPORT_ASSET_JSX path not configured' };

    const tempDir   = (ctx.tempDir || require('os').tmpdir());
    const pointer   = path.join(tempDir, 'roundtrip_current_assetimport.txt');
    const importJob = path.join(tempDir, `assetimport_${assetId}.json`);
    const doneFlag  = path.join(tempDir, `assetimport_${assetId}.done.json`);
    const errorFlag = path.join(tempDir, `assetimport_${assetId}.error.json`);
    try { fs.unlinkSync(doneFlag); }  catch (_) {}
    try { fs.unlinkSync(errorFlag); } catch (_) {}

    fs.writeFileSync(importJob, JSON.stringify({
        aepPath:   fwd(aepAbs),
        assetName: asset.name,
        doneFlag:  fwd(doneFlag),
        errorFlag: fwd(errorFlag),
    }, null, 2), 'utf8');

    // dev20 — lock the AE-resident block (see vaultShot).
    const releaseLock = ctx.acquireAELock
        ? await ctx.acquireAELock('vault:importAssetToOpenAE:' + assetId.slice(0, 8))
        : (() => {});
    let sentinel;
    try {
        try { await ctx.spawnAE(ctx.IMPORT_ASSET_JSX, pointer, importJob); }
        catch (e) {
            _quietUnlink(importJob);
            return { ok: false, error: 'AE dispatch failed: ' + e.message };
        }
        sentinel = await pollForSentinel(doneFlag, errorFlag);
    } finally {
        releaseLock();
    }
    // dev16 #5 — temp cleanup on definite outcome (not on timeout).
    if (!sentinel.timedOut) _quietUnlink(importJob);
    if (!sentinel.ok) return { ok: false, error: sentinel.error };

    const updated = A.appendUsage(asset, {
        toProject: '(open AE project)',
        toShot:    sentinel.payload.projectFile || '(unsaved)',
        mode:      'copy',
    });
    A.writeAsset(assetDir, updated);
    V.rebuildIndex(vaultRoot);

    // Font advisory — same as importAssetToAE. Doesn't block; just a heads-up.
    const fontCount = (asset.dependencies.fonts || []).length;
    if (fontCount && ctx.emitStatus) {
        ctx.emitStatus(`Imported ${asset.name} — ${fontCount} fonts referenced, verify on target machine.`, 'info');
    }

    return {
        ok:         true,
        mode:       'into-open',
        folderName: sentinel.payload.folderName || null,
    };
}

module.exports = {
    vaultShot,
    vaultExternalAep,
    clipShot,
    importAssetToResolve,
    importAssetToAE,
    importAssetToOpenAE,
    importClipToAE,
    canVaultShot,
    // exposed for tests
    findMasterInVersion,
    pollForSentinel,
    _availableShotName,
    _partitionExistingClips,
};
