// detect.js — locate installed software for the Setup Wizard.
//
// Every function returns a plain object, never throws, and never blocks
// the UI for more than ~2s (execFileSync calls use a timeout). The wizard
// calls detectAll() on open; results are rendered as ✓ / ⚠ / ✗ icons.
//
// Detection is best-effort. A "not found" result is never fatal — the
// wizard surfaces it as a warning (except AE, which is the only hard
// requirement to finish setup).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- After Effects ---------------------------------------------------------
// Typical install: C:\Program Files\Adobe\Adobe After Effects YYYY\Support Files\AfterFX.exe
// Years vary per user (2022/2023/2024/2025…); we surface ALL of them so the
// wizard can offer a dropdown when more than one is installed (a common case
// for VFX shops who keep an old AE around for legacy projects). The single
// `path` field stays = the newest version for backward compat with every
// caller that only cares about "give me an AE".
//
// Return shape:
//   { path:    string|null,    // newest version's AfterFX.exe (or env override)
//     source:  'env'|'glob'|null,
//     versions: Array<{ path, year, label }>,    // newest-first; empty if none
//   }
function detectAfterEffects() {
    // Env override wins if it points at a real file.
    if (process.env.AFTERFX_EXE && fs.existsSync(process.env.AFTERFX_EXE)) {
        return {
            path: process.env.AFTERFX_EXE,
            source: 'env',
            versions: [{
                path:  process.env.AFTERFX_EXE,
                year:  null,
                label: 'After Effects (env override)',
            }],
        };
    }
    const base = 'C:\\Program Files\\Adobe';
    if (!fs.existsSync(base)) return { path: null, source: null, versions: [] };
    let entries = [];
    try { entries = fs.readdirSync(base); }
    catch (_) { return { path: null, source: null, versions: [] }; }
    // Match "Adobe After Effects YYYY" — sort newest-year first so versions[0]
    // is always the most recent install.
    const candidates = entries
        .filter(n => /^Adobe After Effects \d{4}$/.test(n))
        .sort().reverse();
    const versions = [];
    for (const c of candidates) {
        const p = path.join(base, c, 'Support Files', 'AfterFX.exe');
        if (fs.existsSync(p)) {
            const m = c.match(/(\d{4})$/);
            versions.push({
                path:  p,
                year:  m ? m[1] : null,
                label: `After Effects ${m ? m[1] : ''}`.trim(),
            });
        }
    }
    if (!versions.length) return { path: null, source: null, versions: [] };
    return { path: versions[0].path, source: 'glob', versions };
}

// ---- DaVinci Resolve scripts ----------------------------------------------
// We don't need Resolve.exe itself — just the Utility scripts folder where
// we copy our Python files, plus the API / fusionscript.dll paths used at
// runtime. These are always at the standard ProgramData / APPDATA locations
// on Windows; env overrides are kept for unusual installs.
// Resolve ships `DaVinciResolveScript.py` (the Python-side wrapper Python
// imports) under `<ScriptingRoot>/Modules/`. The folder alone existing is NOT
// enough — we've seen tester installs where the folder is present but the
// Modules subdir or the .py file is missing (Resolve Free omits the dev kit
// on some versions; uninstallers occasionally leave stubs). So the authoritative
// check is "the .py file is readable", not "the folder exists".
//
// Candidate roots, in priority order:
//   1. RESOLVE_SCRIPT_API env override (wizard / power user)
//   2. ProgramData   — the 20.x Studio default
//   3. Program Files — an older install layout some hosts ship
//   4. APPDATA       — per-user install (rare but exists)
// The first candidate whose Modules/DaVinciResolveScript.py is readable wins.
function _resolveScriptingCandidates() {
    const list = [];
    if (process.env.RESOLVE_SCRIPT_API) list.push(process.env.RESOLVE_SCRIPT_API);
    list.push('C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting');
    list.push('C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting');
    if (process.env.APPDATA) {
        list.push(path.join(process.env.APPDATA, 'Blackmagic Design', 'DaVinci Resolve',
                            'Support', 'Developer', 'Scripting'));
    }
    return list;
}

function _hasDvrModule(apiRoot) {
    if (!apiRoot) return false;
    try { return fs.existsSync(path.join(apiRoot, 'Modules', 'DaVinciResolveScript.py')); }
    catch (_) { return false; }
}

function detectResolveScripting() {
    // Find the first candidate root that actually contains the Python wrapper.
    // Fall back to the ProgramData default (even if missing) so downstream
    // callers always get a string — the `moduleExists` flag tells them whether
    // the path is truly usable.
    const candidates = _resolveScriptingCandidates();
    let apiPath = candidates[0] || 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting';
    let moduleExists = false;
    for (const c of candidates) {
        if (_hasDvrModule(c)) { apiPath = c; moduleExists = true; break; }
    }

    // dev54 — search multiple candidate locations for fusionscript.dll
    // instead of hard-coding the C:\Program Files\... path. A tester on
    // dev53 hit "DLL load failed while importing fusionscript: module
    // not found" because their Resolve was installed under a different
    // letter (D:\Programs\...), and the env var we set pointed at a
    // non-existent C:\Program Files\... path. We try the env override
    // first, then both Windows install layouts (Program Files +
    // ProgramData), then fall back to the C: default for the lib STRING
    // so downstream callers always get a non-null path — the
    // libExists flag below tells them if it's usable.
    function _libCandidates() {
        const list = [];
        if (process.env.RESOLVE_SCRIPT_LIB) list.push(process.env.RESOLVE_SCRIPT_LIB);
        list.push('C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll');
        list.push('C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll');
        return list;
    }
    const libCandidates = _libCandidates();
    let libPath = libCandidates[0];
    for (const c of libCandidates) {
        try { if (fs.existsSync(c)) { libPath = c; break; } }
        catch (_) { /* keep trying */ }
    }
    const utilDir = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'Blackmagic Design', 'DaVinci Resolve',
                    'Support', 'Fusion', 'Scripts', 'Utility')
        : null;
    return {
        apiPath,
        libPath,
        utilDir,
        apiExists:     fs.existsSync(apiPath),
        moduleExists,                               // <-- authoritative
        modulePath:    path.join(apiPath, 'Modules', 'DaVinciResolveScript.py'),
        candidatesTried: candidates,
        libExists:     fs.existsSync(libPath),
        utilDirExists: !!(utilDir && fs.existsSync(utilDir)),
    };
}

// ---- FFmpeg ---------------------------------------------------------------
// Priority: env override → bundled under app's vendor/ → standard Windows
// install dir → PATH fallback (verified via `ffmpeg -version`). The PATH
// fallback is the only one we can't confirm with fs.existsSync, so we do a
// short-timeout spawn; if that fails, we report not-found.
function detectFFmpeg(appRoot) {
    const candidates = [
        process.env.FFMPEG_EXE,
        appRoot ? path.join(appRoot, 'vendor', 'ffmpeg', 'ffmpeg.exe') : null,
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return { path: p, source: 'file' };
    }
    try {
        execFileSync('ffmpeg', ['-version'], { timeout: 2000, windowsHide: true, stdio: 'ignore' });
        return { path: 'ffmpeg', source: 'path' };
    } catch (_) {
        return { path: null, source: null };
    }
}

// ---- Python ---------------------------------------------------------------
// Priority: system Python (`py` / `python` / `python3`) → bundled embeddable
// at <appRoot>/vendor/python/python.exe. System wins so existing installs
// never silently switch to the bundled interpreter.
//
// `source` tells callers which branch we hit so downstream code can decide
// whether extra setup (e.g. registry registration for Resolve) is warranted.
// v0.4.9-rc4 — supported Python range, enforced at detect time.
// The Resolve external scripting API (fusionscript.dll) is built against a
// specific CPython ABI; running the relink script under 3.14+ or <3.10 fails
// silently at scriptapp("Resolve") with no traceback. Better to catch that
// at startup and tell the user which Python to install.
const SUPPORTED_PYTHON = Object.freeze({
    minMajor: 3, minMinor: 10,
    maxMajor: 3, maxMinor: 13,
    label: '3.10 – 3.13',
});

// Exposed for tests — pure string parsing, no side effects.
function parsePythonVersionString(s) {
    if (!s) return null;
    const m = String(s).match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!m) return null;
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: m[3] ? parseInt(m[3], 10) : 0,
        full:  `${m[1]}.${m[2]}.${m[3] || 0}`,
    };
}

function isPythonInSupportedRange(v) {
    if (!v) return false;
    const { minMajor, minMinor, maxMajor, maxMinor } = SUPPORTED_PYTHON;
    if (v.major < minMajor || v.major > maxMajor) return false;
    if (v.major === minMajor && v.minor < minMinor) return false;
    if (v.major === maxMajor && v.minor > maxMinor) return false;
    return true;
}

function _probePythonVersion(cmd) {
    try {
        // Python <3.4 printed --version to stderr; 3.4+ to stdout. Capture
        // both by piping and concatenating — resilient to either.
        const out = execFileSync(cmd, ['--version'], {
            timeout: 2000, windowsHide: true, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return parsePythonVersionString(out);
    } catch (e) {
        // Some launchers (old Windows `py`) print to stderr AND exit nonzero.
        const tail = e && (e.stderr || e.stdout);
        return parsePythonVersionString(tail);
    }
}

// Priority: bundled embeddable at <appRoot>/vendor/python/python.exe (if
// present AND in-range) → system Python (`py` / `python` / `python3`, first
// in-range hit wins). The old "system first" order was flipped in rc4 — a
// known-good bundled runtime we control is safer than the tester's PATH.
//
// Returns { path, source, version, inRange, tried[] }.
// * `version` is {major, minor, patch, full} or null.
// * `inRange` is true iff the returned version ∈ supported range.
// * `tried` lists every candidate probed (for diagnostic logging).
// When nothing in-range is found but SOMETHING runs, the out-of-range best
// hit is returned so callers can paint a precise error ("Python 3.14 found
// but needs 3.10-3.13") instead of the ambiguous "missing".
function detectPython(appRoot) {
    const tried = [];

    if (appRoot) {
        const bundled = path.join(appRoot, 'vendor', 'python', 'python.exe');
        if (fs.existsSync(bundled)) {
            const v = _probePythonVersion(bundled);
            const inRange = isPythonInSupportedRange(v);
            tried.push({ path: bundled, source: 'bundled', version: v, inRange });
            if (inRange) {
                return { path: bundled, source: 'bundled', version: v, inRange: true, tried };
            }
        }
    }

    for (const cmd of ['py', 'python', 'python3']) {
        const v = _probePythonVersion(cmd);
        if (!v) continue;
        const inRange = isPythonInSupportedRange(v);
        tried.push({ path: cmd, source: 'system', version: v, inRange });
        if (inRange) {
            return { path: cmd, source: 'system', version: v, inRange: true, tried };
        }
    }

    if (tried.length) {
        const best = tried[tried.length - 1];
        return { ...best, tried };
    }
    return { path: null, source: null, version: null, inRange: false, tried };
}

// ---- Python (Windows registry) --------------------------------------------
// DaVinci Resolve discovers Python via the Windows registry, NOT the PATH
// and NOT our bundled embeddable. If neither hive has a PythonCore install
// registered, Resolve's Workspace → Scripts → Utility menu is empty. This
// detector is what the wizard uses to decide whether to offer "Install
// Python automatically".
//
// Keys checked (Resolve uses both hives):
//     HKCU\Software\Python\PythonCore\<ver>\InstallPath
//     HKLM\Software\Python\PythonCore\<ver>\InstallPath
function detectPythonRegistry() {
    for (const hive of ['HKCU', 'HKLM']) {
        try {
            const out = execFileSync('reg', [
                'query', `${hive}\\Software\\Python\\PythonCore`, '/s',
            ], { timeout: 3000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            // A populated InstallPath subkey is what Resolve actually looks at.
            if (/\\InstallPath\b/i.test(out)) {
                const v = out.match(/PythonCore\\([0-9][0-9.\-]*)/);
                return { found: true, hive, version: v ? v[1] : null };
            }
        } catch (_) { /* hive absent — try next */ }
    }
    return { found: false, hive: null, version: null };
}

// ---- Writable-path probe --------------------------------------------------
// Returns true if we can create files inside `dir` (creating `dir` itself if
// it doesn't exist yet). Used by the wizard's roundtrip-root picker. Cleans
// up after itself; never leaves stray files.
function isWritableDir(dir) {
    if (!dir) return false;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.rt_probe_' + process.pid);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (_) {
        return false;
    }
}

// ---- Default roundtrip root ----------------------------------------------
// Suggest Documents\Roundtrip on Windows. Falls back to home dir if
// USERPROFILE isn't set (shouldn't happen on Windows, but be defensive).
function defaultRoundtripRoot() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) return null;
    return path.join(home, 'Documents', 'Roundtrip');
}

// ---- Aggregate ------------------------------------------------------------
function detectAll(appRoot) {
    return {
        ae:      detectAfterEffects(),
        resolve: detectResolveScripting(),
        ffmpeg:  detectFFmpeg(appRoot),
        python:  detectPython(appRoot),   // internal — not surfaced in UI
        pythonRegistry: detectPythonRegistry(),  // Resolve's discovery path
    };
}

module.exports = {
    detectAfterEffects,
    detectResolveScripting,
    detectFFmpeg,
    detectPython,
    detectPythonRegistry,
    detectAll,
    isWritableDir,
    defaultRoundtripRoot,
    // v0.4.9-rc4 — Python version gate (exported for tests + callers).
    SUPPORTED_PYTHON,
    parsePythonVersionString,
    isPythonInSupportedRange,
};
