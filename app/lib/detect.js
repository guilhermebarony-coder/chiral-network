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

// dev60 — Resolve major versions ship fusionscript.dll built against
// different Python ABIs. Pre-Resolve-21 fusionscript directly imports
// `python310.dll` (CPython 3.10 ABI lock); Resolve 21+ fusionscript
// imports only `python3.dll` (the limited / stable ABI forwarder) and
// is compiled against Python 3.11+ stable ABI — calling into it from
// 3.10 access-violates inside PyInit_fusionscript before any Python
// exception can be raised. We can't pick a single Python that covers
// both, so we ship two embeddables in vendor/ and pick at spawn time
// by reading fusionscript.dll's import strings.
//
// Heuristic:
//   * sees `python310.dll` literal     → vendor/python310 (3.10 ABI lock)
//   * sees only `python3.dll` literal  → vendor/python313 (stable ABI)
//   * neither found / file unreadable  → vendor/python313 (newer is the
//                                         safer default — Resolve 21 is
//                                         the only released line that
//                                         needs it; the 3.10 vendor is
//                                         only kept for legacy testers)
//
// We read the head of the .dll (first 4 MB is plenty — import tables
// are at the front of a PE), so the cost is bounded regardless of
// fusionscript size. Result is cached per absolute libPath.
const _vendoredPyCache = new Map();   // absLibPath -> 'python310' | 'python313'

// dev63 — extract the major version of a Windows binary by scanning for
// VS_FIXEDFILEINFO's signature (0xFEEF04BD) inside the resource section.
// VS_FIXEDFILEINFO is a fixed-layout struct: { dwSignature, dwStrucVersion,
// dwFileVersionMS, dwFileVersionLS, dwProductVersionMS, dwProductVersionLS,
// ... }. dwFileVersionMS = (major << 16) | minor. We just want major, so
// the first 6 bytes after the signature are enough. Returns an integer
// or null on any parse failure.
//
// Why scan, not parse-the-resource-tree: the .rsrc directory layout is
// genuinely fragile (nested IMAGE_RESOURCE_DIRECTORY entries, multiple
// languages, etc.) and writing a robust parser is ~150 lines. The
// signature is unique inside any valid VS_VERSIONINFO block, and PE
// resources with VS_VERSIONINFO are rare enough that a buffer scan is
// effectively zero-collision. We bound the scan to the first 8 MB which
// is comfortably bigger than any fusionscript.dll we've seen.
function _readMajorVersionFromBinary(absPath) {
    try {
        const fd = fs.openSync(absPath, 'r');
        try {
            const len = Math.min(8 * 1024 * 1024, fs.fstatSync(fd).size);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, 0);
            // VS_FIXEDFILEINFO signature: 0xFEEF04BD, little-endian on disk.
            const SIG = Buffer.from([0xBD, 0x04, 0xEF, 0xFE]);
            const idx = buf.indexOf(SIG);
            if (idx < 0) return null;
            // dwSignature(4) + dwStrucVersion(4) -> dwFileVersionMS(4) at +8.
            // dwFileVersionMS layout: HIWORD = major, LOWORD = minor.
            const ms = buf.readUInt32LE(idx + 8);
            const major = (ms >>> 16) & 0xFFFF;
            return major;
        } finally {
            try { fs.closeSync(fd); } catch (_) {}
        }
    } catch (_) {
        return null;
    }
}

function pickVendoredPythonDir(libPath) {
    if (!libPath) return 'python313';
    const abs = path.resolve(libPath);
    if (_vendoredPyCache.has(abs)) return _vendoredPyCache.get(abs);

    let pick = 'python313';   // default — newest, broadest stable-ABI compat
    try {
        if (fs.existsSync(abs)) {
            const fd = fs.openSync(abs, 'r');
            try {
                const len = Math.min(4 * 1024 * 1024, fs.fstatSync(fd).size);
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, 0);
                // Strings in PE import tables are 7-bit ASCII, so latin1
                // decode is exact and faster than utf-8.
                const s = buf.toString('latin1');
                if (/python310\.dll/i.test(s)) {
                    pick = 'python310';
                }
                // Any explicit python3XX.dll lock (>=311) → pick 3.13. We
                // don't ship a separate vendor for each minor; 3.13 is the
                // newest stable ABI consumer in our shipping pair.
                else if (/python31[1-9]\.dll/i.test(s)) {
                    pick = 'python313';
                }
                // dev63 — Resolve <21 fallback. fusionscript imports only
                // `python3.dll` (the stable-ABI forwarder), but stable-ABI
                // claims and actual forward-compat behavior aren't the same
                // thing. Resolve 20 fusionscript was compiled against Python
                // 3.10 layout WITHOUT the strict `Py_LIMITED_API` discipline,
                // so 3.13 access-violates inside PyInit_fusionscript on
                // PyTypeObject field offsets that changed in 3.12+ (Seih's
                // crash on dev62, Resolve 20.3). When the heuristic above
                // didn't match a hard `pythonXY.dll` lock, fall back to
                // reading fusionscript's own FileVersion: Resolve major < 21
                // → python310, else python313 (the previous default).
                else {
                    const major = _readMajorVersionFromBinary(abs);
                    if (typeof major === 'number' && major > 0 && major < 21) {
                        pick = 'python310';
                    }
                    // major >= 21 OR null (parse failure) → keep python313.
                }
            } finally {
                try { fs.closeSync(fd); } catch (_) {}
            }
        }
    } catch (_) {
        // Read failure → keep the default. The caller still gets a usable
        // vendor dir; if it turns out to be the wrong one for this Resolve,
        // the relink script will surface a clear error rather than a silent
        // process abort (dev57 faulthandler captures the C-level dump).
    }
    _vendoredPyCache.set(abs, pick);
    return pick;
}

function clearVendoredPythonCache() { _vendoredPyCache.clear(); }

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
function detectPython(appRoot, libPath) {
    const tried = [];

    if (appRoot) {
        // dev60 — pick between vendor/python310 and vendor/python313 by
        // reading fusionscript.dll's import strings. The picker defaults
        // to python313 if libPath is missing or unreadable, so this stays
        // working when callers don't pass libPath (legacy callers + tests).
        const dir = pickVendoredPythonDir(libPath);
        const bundled = path.join(appRoot, 'vendor', dir, 'python.exe');
        if (fs.existsSync(bundled)) {
            const v = _probePythonVersion(bundled);
            const inRange = isPythonInSupportedRange(v);
            tried.push({ path: bundled, source: 'bundled', version: v, inRange, vendorDir: dir });
            if (inRange) {
                return { path: bundled, source: 'bundled', version: v, inRange: true, vendorDir: dir, tried };
            }
        }
        // Fallback — if the chosen vendor dir is missing for any reason
        // (manual deletion, half-extracted vendor.zip), try the OTHER
        // one before giving up. Better to relink with the wrong Python
        // and surface the clear faulthandler error than to fail at
        // detection time with no diagnostic.
        const alt = dir === 'python313' ? 'python310' : 'python313';
        const altPath = path.join(appRoot, 'vendor', alt, 'python.exe');
        if (fs.existsSync(altPath)) {
            const v = _probePythonVersion(altPath);
            const inRange = isPythonInSupportedRange(v);
            tried.push({ path: altPath, source: 'bundled-fallback', version: v, inRange, vendorDir: alt });
            if (inRange) {
                return { path: altPath, source: 'bundled-fallback', version: v, inRange: true, vendorDir: alt, tried };
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
    // dev60 — vendored-Python picker (exported so main.js can pass
    // RESOLVE_SCRIPT_LIB at startup AND so tests can exercise the
    // import-string heuristic against fixture .dll buffers).
    pickVendoredPythonDir,
    clearVendoredPythonCache,
};
