// lib/spawn.js — After Effects + Python process plumbing.
//
// All process-level ghosts live here: launching AE detached, dispatching JSX
// via `-r` against an already-running instance, probing the active comp, and
// spawning the Resolve relink Python. Every spawn uses `windowsHide: true`
// and (for Python) a pythonw.exe/pyw.exe "no-console" variant so background
// work never flashes a CMD window — not even for a frame.
//
// State-free: every function takes the paths it needs (AE_EXE, PYTHON_EXE,
// PROBE_SENTINEL, …) as explicit args or via a small `ctx` argument.
// main.js holds the authoritative copies and passes them in.

const fs   = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const AE_PROCESS_NAME = 'AfterFX.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- AE scripting lock (dev20) --------------------------------------------
// AE's ExtendScript host is single-threaded. Dispatching a second `-r`
// while the first JSX is still executing trips the
// "Attempt was made to run a second script while another script was
// already running" warning, and the second script never runs at all.
//
// Pre-dev20 we relied on user pacing — fine when there was one AE flow
// per click (vault, render, send-to-AE). Once the vault grew clip imports,
// asset imports, and asset-into-open-project paths, a user double-click
// or a fast sequence of vault buttons could land two `-r` calls on the
// same AE before the first sentinel was written.
//
// The lock here lives in main-process memory. acquireAELock returns a
// release fn; callers wrap their entire spawnAE + sentinel-poll block.
// Subsequent acquirers wait in a FIFO queue. A 20-minute hard ceiling
// auto-releases if a caller forgets — the lock can never leak forever.
//
// State broadcast: setAEBusyEmit lets main.js push `{busy, label,
// queueDepth}` to every BrowserWindow over IPC. Renderers grey out
// AE-bound buttons while busy.

const AE_LOCK_MAX_HOLD_MS = 20 * 60 * 1000;   // 20 min — same order as the
                                              // longest legitimate vault op
// dev26 — mandatory cooldown after a release before the next acquirer
// runs. AE's scripting host needs a beat to flush UI state between
// commands, especially when alternating between Save / reduceProject /
// importFile in the procedural-template flow. Without this, the
// "second script while another is running" warning still occasionally
// appeared even though our lock was correctly released — AE's host
// reported the previous script as "still running" for a few hundred ms
// after the JSX exited.
const AE_LOCK_COOLDOWN_MS = 800;

let _aeBusy = false;
let _aeBusyLabel = null;
let _aeBusyAcquiredAt = 0;
let _aeBusyAutoReleaseTimer = null;
let _aeCooldownUntil = 0;          // dev26 — next allowed acquire timestamp
const _aeQueue = [];
let _aeBusyEmit = null;

function setAEBusyEmit(fn) {
    _aeBusyEmit = (typeof fn === 'function') ? fn : null;
}

function _emitAEBusy() {
    if (!_aeBusyEmit) return;
    try {
        _aeBusyEmit({
            busy:       _aeBusy,
            label:      _aeBusyLabel,
            queueDepth: _aeQueue.length,
        });
    } catch (_) {}
}

function _innerReleaseAELock() {
    if (_aeBusyAutoReleaseTimer) {
        clearTimeout(_aeBusyAutoReleaseTimer);
        _aeBusyAutoReleaseTimer = null;
    }
    _aeBusy = false;
    _aeBusyLabel = null;
    _aeBusyAcquiredAt = 0;
    // dev26 — start cooldown window. Next acquirer must wait until this
    // timestamp before running. Stored as an absolute time (rather than a
    // running setTimeout) so a queued waiter that's about to wake can
    // calculate exactly how long to delay.
    _aeCooldownUntil = Date.now() + AE_LOCK_COOLDOWN_MS;
    _emitAEBusy();
    // Wake the next waiter (if any). They re-enter acquireAELock's
    // continuation, which will honor the cooldown before flipping busy.
    const next = _aeQueue.shift();
    if (next) next();
}

async function acquireAELock(label) {
    if (_aeBusy) {
        // Park until our turn. Resolved by _innerReleaseAELock's shift+call.
        await new Promise(resolve => _aeQueue.push(resolve));
    }
    // dev26 — honor the post-release cooldown. Whether we just woke from
    // the queue OR walked in fresh, if a previous holder released within
    // the last AE_LOCK_COOLDOWN_MS, sleep the remainder. Gives AE's host
    // time to fully unwind the previous script before we kick off another.
    const now = Date.now();
    if (_aeCooldownUntil > now) {
        await new Promise(r => setTimeout(r, _aeCooldownUntil - now));
    }
    _aeBusy = true;
    _aeBusyLabel = label || 'ae-job';
    _aeBusyAcquiredAt = Date.now();
    _aeBusyAutoReleaseTimer = setTimeout(() => {
        if (_aeBusy) {
            // Safety net (point #3). A caller forgot to release, or
            // something blocked their finally{}. Force-release with a
            // log line so the failure is visible in dev tools.
            console.warn(`[ae-lock] auto-release after ${AE_LOCK_MAX_HOLD_MS}ms — caller did not release (label="${_aeBusyLabel}")`);
            _innerReleaseAELock();
        }
    }, AE_LOCK_MAX_HOLD_MS);
    _emitAEBusy();

    let released = false;
    return function release() {
        // Idempotent — finally{} blocks frequently call us twice if a
        // caller wraps multiple try blocks. Quietly ignore re-release.
        if (released) return;
        released = true;
        _innerReleaseAELock();
    };
}

function aeBusyState() {
    return {
        busy:       _aeBusy,
        label:      _aeBusyLabel,
        queueDepth: _aeQueue.length,
        heldForMs:  _aeBusy ? Date.now() - _aeBusyAcquiredAt : 0,
    };
}

// ---- Python no-console variant --------------------------------------------
// Windows "ghost" variant of a Python interpreter: the GUI-subsystem binary
// that has NO console attached. Required for detached background spawns —
// windowsHide: true only hides an already-allocated console, it can't
// prevent the allocation. `pythonw.exe` / `pyw.exe` never allocate one.
function resolveNoConsolePython(pyExe) {
    if (!pyExe) return pyExe;
    const base = path.basename(pyExe).toLowerCase();
    if (pyExe === base) {
        if (base === 'py')     return 'pyw';
        if (base === 'python') return 'pythonw';
        return pyExe;
    }
    const dir = path.dirname(pyExe);
    let candidate = null;
    if (base === 'python.exe')  candidate = path.join(dir, 'pythonw.exe');
    else if (base === 'py.exe') candidate = path.join(dir, 'pyw.exe');
    if (candidate && fs.existsSync(candidate)) return candidate;
    return pyExe;
}

// ---- ffmpeg resolution -----------------------------------------------------
// env override -> default Windows install path -> PATH fallback. `verified`
// flags whether we could existsSync the binary; PATH fallbacks return the
// literal 'ffmpeg' and let spawn() fail gracefully if not on PATH.
const DEFAULT_FFMPEG = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
function resolveFFmpegPath() {
    if (process.env.FFMPEG_EXE && fs.existsSync(process.env.FFMPEG_EXE)) {
        return { path: process.env.FFMPEG_EXE, verified: true };
    }
    if (fs.existsSync(DEFAULT_FFMPEG)) {
        return { path: DEFAULT_FFMPEG, verified: true };
    }
    return { path: 'ffmpeg', verified: false };
}

// ---- AE process detection --------------------------------------------------
function isAERunning() {
    try {
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${AE_PROCESS_NAME}`], {
            encoding: 'utf8', windowsHide: true,
        });
        return out.toLowerCase().includes(AE_PROCESS_NAME.toLowerCase());
    } catch (_) { return false; }
}

async function waitForAE(maxMs = 60000, intervalMs = 500) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
        if (isAERunning()) return true;
        await sleep(intervalMs);
    }
    return false;
}

// Check AE's main window title. When fully loaded the title starts with
// "Adobe After Effects YYYY"; during splash it's "N/A" or blank. CSV parse
// of tasklist /V; we read the LAST quoted field of each data row so the
// image-name column and the CLI path (which both contain "After Effects")
// don't false-positive.
function isAEWindowReady() {
    try {
        const out = execFileSync('tasklist', [
            '/FI', `IMAGENAME eq ${AE_PROCESS_NAME}`,
            '/V', '/FO', 'CSV',
        ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        const lines = out.split(/\r?\n/);
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const lastQuote = line.lastIndexOf('"');
            const penQuote  = line.lastIndexOf('"', lastQuote - 1);
            if (penQuote < 0) continue;
            const windowTitle = line.substring(penQuote + 1, lastQuote);
            if (/^Adobe After Effects \d{4}/i.test(windowTitle)) return true;
        }
        return false;
    } catch (_) { return false; }
}

async function waitForAEWindow(maxMs = 120000, intervalMs = 1000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
        if (isAEWindowReady()) return true;
        await sleep(intervalMs);
    }
    return false;
}

// ---- AE launch / dispatch --------------------------------------------------
function launchAEDetached(AE_EXE) {
    const child = spawn(AE_EXE, [], {
        detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
}

function runJSXInExistingAE(AE_EXE, jsxPath) {
    const child = spawn(AE_EXE, ['-r', jsxPath], {
        detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
}

// Sentinel-file probe for "is AE scripting engine alive right now?". Only
// valid when AE is already running. ~1.5s round-trip.
async function quickProbe(AE_EXE, PROBE_SENTINEL, PROBE_JSX) {
    try { fs.unlinkSync(PROBE_SENTINEL); } catch (_) {}
    runJSXInExistingAE(AE_EXE, PROBE_JSX);
    await sleep(1500);
    if (fs.existsSync(PROBE_SENTINEL)) {
        try { fs.unlinkSync(PROBE_SENTINEL); } catch (_) {}
        return true;
    }
    return false;
}

// Dump AE's active-comp metadata via probe_comp.jsx. Ensures AE is running
// and the scripting engine is alive before dispatching. Returns parsed JSON
// ({ok:true, ...} or {ok:false, error}). Throws on timeout.
async function runAEProbeComp(AE_EXE, PROBE_COMP_JSX, COMP_PROBE_SENTINEL, timeoutMs = 20000) {
    try { fs.unlinkSync(COMP_PROBE_SENTINEL); } catch (_) {}

    if (!isAERunning()) {
        launchAEDetached(AE_EXE);
        const appeared = await waitForAE(60000, 500);
        if (!appeared) throw new Error('After Effects failed to launch (process not found within 60s).');
    }
    const winReady = await waitForAEWindow(90000, 1000);
    if (winReady) await sleep(2000);

    runJSXInExistingAE(AE_EXE, PROBE_COMP_JSX);

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        await sleep(400);
        if (fs.existsSync(COMP_PROBE_SENTINEL)) {
            try {
                const raw = fs.readFileSync(COMP_PROBE_SENTINEL, 'utf8');
                try { fs.unlinkSync(COMP_PROBE_SENTINEL); } catch (_) {}
                return JSON.parse(raw);
            } catch (e) {
                throw new Error('Could not parse probe_comp.jsx output: ' + e.message);
            }
        }
    }
    throw new Error('After Effects did not respond within ' + Math.round(timeoutMs/1000) + 's. '
                  + 'Make sure a composition is open and try again.');
}

// The primary "send AE a job" entry point. Writes the pointer file BEFORE
// dispatching the JSX (which reads it), then makes sure AE is fully up
// (process + window + scripting-engine settle) before calling `-r`.
async function spawnAE(AE_EXE, jsxPath, pointerPath, jobPath) {
    fs.writeFileSync(pointerPath, jobPath, 'utf8');

    if (isAERunning()) {
        if (isAEWindowReady()) {
            runJSXInExistingAE(AE_EXE, jsxPath);
            return;
        }
        const winReady = await waitForAEWindow(90000, 1000);
        if (winReady) await sleep(5000);
        runJSXInExistingAE(AE_EXE, jsxPath);
        return;
    }

    launchAEDetached(AE_EXE);
    const appeared = await waitForAE(60000, 500);
    if (!appeared) return;
    const winReady = await waitForAEWindow(120000, 1000);
    if (winReady) await sleep(3000);
    runJSXInExistingAE(AE_EXE, jsxPath);
}

// ---- Resolve relink spawn --------------------------------------------------
// Fire-and-forget Python. Caller handles result-file polling (.relink.json)
// if it needs a completion signal — this function only guarantees dispatch.
//
// ctx = {
//   PYTHON_EXE: 'python.exe' or similar — the CONSOLE variant. v0.4.9-rc4
//     deliberately switched off pythonw.exe here: pythonw swallows
//     unhandled tracebacks on crash (observed on Python 3.14 + Resolve 21),
//     leaving the log truncated mid-script with no diagnostic. The console
//     variant is hidden via `windowsHide: true` (CREATE_NO_WINDOW) so
//     there's no visible console flash — we still get stderr capture.
//   RELINK_PY: absolute path to relink_latest_render.py,
//   RESOLVE_SCRIPT_API / RESOLVE_SCRIPT_LIB: env vars Resolve's scripting
//     module requires (see script header for details).
// }
//
// v0.4.7 — per-shot in-flight lock. The auto-relink path (render-complete
// watcher) and the manual "Send to Resolve" button both call runRelink and
// the user has been observed clicking the manual button while the auto
// pass is still running, because Resolve takes a second or two to visibly
// update the timeline. Two concurrent Python processes then ImportMedia
// the same file (dedups to one MediaPoolItem on the Resolve side) and
// both call AppendToTimeline, which DOES land two clip instances on the
// timeline. The inFlight map key is the absolute shot dir; entries are
// cleared by clearRelinkInFlight() which waitForRelinkResult calls on
// terminal completion.
const _relinkInFlight = new Map();   // shotDirAbs -> { startedAt }

function isRelinkInFlight(shotDirAbs) {
    return _relinkInFlight.has(shotDirAbs);
}

function clearRelinkInFlight(shotDirAbs) {
    _relinkInFlight.delete(shotDirAbs);
}

function runRelink(ctx, shotDirAbs, versionOverride, atPlayhead, opts) {
    if (_relinkInFlight.has(shotDirAbs)) {
        // Hard refuse. The caller is expected to check isRelinkInFlight()
        // first and emit a user-facing "already relinking" status; this
        // branch is the defensive last line so we never spawn concurrent
        // Python processes for the same shot.
        return { dispatched: false, reason: 'already-in-flight' };
    }
    _relinkInFlight.set(shotDirAbs, { startedAt: Date.now() });

    const fwd = p => (p || '').replace(/\\/g, '/');
    // dev55 — prepend the Resolve install directory to PATH for the
    // child process. add_dll_directory (set inside the Python script)
    // covers the explicit LoadLibraryEx search path, but some delay-
    // loaded dependencies of fusionscript.dll consult PATH at runtime
    // — and a tester saw python.exe terminate silently when the
    // import hit one of those. Belt-and-braces: list the install dir
    // in BOTH places so the loader has it whichever search mode it
    // ends up using.
    let resolveDir = '';
    if (ctx.RESOLVE_SCRIPT_LIB) {
        try { resolveDir = path.dirname(ctx.RESOLVE_SCRIPT_LIB); }
        catch (_) { resolveDir = ''; }
    }
    const env = Object.assign({}, process.env, {
        RESOLVE_SCRIPT_API: ctx.RESOLVE_SCRIPT_API,
        RESOLVE_SCRIPT_LIB: ctx.RESOLVE_SCRIPT_LIB,
        PYTHONPATH: (process.env.PYTHONPATH ? process.env.PYTHONPATH + ';' : '')
                    + path.join(ctx.RESOLVE_SCRIPT_API, 'Modules'),
        PATH: resolveDir
            ? (resolveDir + ';' + (process.env.PATH || ''))
            : (process.env.PATH || ''),
    });
    const args = [ctx.RELINK_PY, fwd(shotDirAbs)];
    if (versionOverride) args.push(versionOverride);
    if (atPlayhead)      args.push('--at-playhead');
    if (opts && opts.forceReconnect) args.push('--force-reconnect');

    // v0.4.9-rc4 — pipe stderr to a per-shot file so silent crashes (e.g.
    // scriptapp("Resolve") failing under the wrong Python version) leave a
    // traceback on disk. Without this, pythonw.exe (the old variant) or
    // stdio:'ignore' (this one, now console python.exe) would both drop
    // the traceback on the floor. The file is a crash log — overwritten
    // each run ('w' flag) so it always reflects the most recent spawn.
    const stderrLogPath = path.join(shotDirAbs, '.relink.stderr.log');
    let stderrFd = 'ignore';
    try {
        stderrFd = fs.openSync(stderrLogPath, 'w');
    } catch (_) {
        // If we can't create the log (read-only filesystem?), fall back to
        // silent — we still spawn, just without crash-log capture.
    }

    // Prefer PYTHON_EXE (console variant); accept legacy _NOCONSOLE if an
    // older caller still passes it, but log a dev-side warning so the
    // plumbing gets updated.
    const pyExe = ctx.PYTHON_EXE || ctx.PYTHON_EXE_NOCONSOLE;
    if (!ctx.PYTHON_EXE && ctx.PYTHON_EXE_NOCONSOLE) {
        console.warn('[spawn.runRelink] ctx.PYTHON_EXE_NOCONSOLE is deprecated; '
                   + 'pass ctx.PYTHON_EXE (console python.exe) so stderr can be captured.');
    }

    const child = spawn(pyExe, args, {
        env,
        detached: true,
        stdio: ['ignore', 'ignore', stderrFd],
        windowsHide: true,   // maps to CREATE_NO_WINDOW — no console flash
        shell: false,
    });
    child.unref();
    // Close OUR copy of the fd; the child keeps its inherited copy and will
    // flush writes through it until exit. Leaving our fd open would leak.
    if (typeof stderrFd === 'number') {
        try { fs.closeSync(stderrFd); } catch (_) {}
    }
    return { dispatched: true, args, stderrLogPath };
}

// ---- Relink result round-trip ---------------------------------------------
// `runRelink` is detached — there's no exit-code channel. The Python side
// writes a `.relink.json` result file in the shot dir when it finishes (OK
// or error). This helper polls for that file for a short window and returns
// the parsed result, or { ok:false, error:'timeout' } if Python never wrote.
// We tear the file down after reading so the next relink starts clean.
//
// Timeout default is generous (6s) — even slow Resolve projects usually
// finish ReplaceClip in 1-2s. We stop polling early on first appearance.
async function waitForRelinkResult(shotDirAbs, timeoutMs = 6000, pollMs = 200) {
    const resultPath = path.join(shotDirAbs, '.relink.json');
    try { fs.unlinkSync(resultPath); } catch (_) {}
    const t0 = Date.now();
    try {
        while (Date.now() - t0 < timeoutMs) {
            await sleep(pollMs);
            if (fs.existsSync(resultPath)) {
                let parsed = null;
                try {
                    parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                } catch (e) {
                    return { ok: false, error: 'malformed .relink.json: ' + e.message };
                } finally {
                    try { fs.unlinkSync(resultPath); } catch (_) {}
                }
                return parsed || { ok: false, error: 'empty result' };
            }
        }
        return { ok: false, error: 'timeout' };
    } finally {
        // v0.4.7 — always release the per-shot relink lock when this waiter
        // terminates. Even on timeout we release: the Python process may be
        // wedged, but a wedged process shouldn't hold the lock forever and
        // block every future relink for this shot. If the user retries
        // after a timeout, a fresh spawn is the right behavior.
        clearRelinkInFlight(shotDirAbs);
    }
}

// ---- Wait-for-stable-file (master render stabilization) --------------------
// Poll a file until its size has been unchanged for 3 seconds AND non-zero.
// Used to know when AE has finished writing the master .mov so we can start
// the Resolve relink + ffmpeg webm conversion chain.
async function waitForStableFile(filePath, timeoutMs = 600000) {
    const t0 = Date.now();
    let lastSize = -1;
    let lastChange = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        await sleep(1000);
        if (!fs.existsSync(filePath)) { lastChange = Date.now(); continue; }
        const sz = fs.statSync(filePath).size;
        if (sz !== lastSize) { lastSize = sz; lastChange = Date.now(); continue; }
        if (Date.now() - lastChange > 3000 && sz > 0) return true;
    }
    return false;
}

module.exports = {
    AE_PROCESS_NAME,
    sleep,
    resolveNoConsolePython,
    resolveFFmpegPath,
    isAERunning, waitForAE,
    isAEWindowReady, waitForAEWindow,
    launchAEDetached, runJSXInExistingAE,
    quickProbe, runAEProbeComp,
    spawnAE,
    runRelink, waitForRelinkResult,
    isRelinkInFlight, clearRelinkInFlight,
    waitForStableFile,
    // dev20 — AE scripting lock primitive.
    acquireAELock, setAEBusyEmit, aeBusyState,
};
