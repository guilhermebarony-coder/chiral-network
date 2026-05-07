// wizard.js — renderer logic for the Setup Wizard.
//
// State is a plain object. Navigation is explicit function calls. No classes,
// no state manager, no async queue — just short handlers that call the IPC
// bridge and re-render the relevant pane.

const $ = id => document.getElementById(id);

// ---- State -----------------------------------------------------------------
// Holds everything the Finish step will persist. Populated by detection (Step 1)
// then by the user's manual pickers (Steps 2-3). Only sent to main via
// window.wizard.save() on Finish.
const state = {
    detect:       null,   // result of wizard:detect (ae/resolve/ffmpeg/pythonRegistry)
    aePath:       null,   // resolved AE path (from detect OR manual pick)
    ffmpegPath:   null,   // resolved ffmpeg path (detect only — no manual picker in v0.1)
    rootPath:     null,   // user-chosen roundtrip root
    rootWritable: false,  // result of last probeWritable
    resolveInstalled: false,   // true once the user clicks "Install now" on Step 4
    pythonRegistered: false,   // true when detect reports a PythonCore registry key
};

// ---- Step navigation -------------------------------------------------------
let currentStep = 1;

function showStep(n) {
    currentStep = n;
    document.querySelectorAll('.pane').forEach(p => {
        p.classList.toggle('active', Number(p.dataset.pane) === n);
    });
    document.querySelectorAll('.steps .dot').forEach(d => {
        const dn = Number(d.dataset.n);
        d.classList.toggle('active', dn === n);
        d.classList.toggle('done',   dn < n);
    });
}

// ---- Icon helpers ----------------------------------------------------------
// Set the icon + label detail on one <li> inside a checklist.
function setRow(listId, key, status, detail) {
    const li = document.querySelector(`#${listId} li[data-k="${key}"]`);
    if (!li) return;
    const ico = li.querySelector('.ico');
    const det = li.querySelector('.detail');
    const glyphs = { ok: '\u2713', warn: '\u26A0', fail: '\u2717', wait: '\u2026' };
    ico.textContent = glyphs[status] || '\u2026';
    ico.className = 'ico ' + status;
    if (det) det.textContent = detail || '';
}

// ---- Step 1: Detect --------------------------------------------------------
// In edit mode, state.aePath / state.ffmpegPath are already populated from
// config.json. Detection still runs to refresh the ✓/⚠/✗ icons, but it must
// NOT clobber the user's existing saved values — it only fills state when
// the slot is empty (first-run, or edit mode with a blank slot).
async function runDetect() {
    ['ae', 'resolve', 'resolveSdk', 'ffmpeg'].forEach(k => setRow('detect-list', k, 'wait', ''));
    let r;
    try { r = await window.wizard.detect(); }
    catch (_) { r = { ae: null, resolve: null, ffmpeg: null }; }
    state.detect = r;

    // After Effects — hard requirement, so 'fail' if nothing available.
    if (r.ae && r.ae.path) {
        if (!state.aePath) state.aePath = r.ae.path;
        setRow('detect-list', 'ae', 'ok', state.aePath || r.ae.path);
    } else if (state.aePath) {
        // Edit mode: detection didn't find AE at a standard location but the
        // user has a path saved. Trust it; wizard:save will re-validate on finish.
        setRow('detect-list', 'ae', 'ok', state.aePath);
    } else {
        setRow('detect-list', 'ae', 'fail', 'Not found');
    }

    // Resolve scripts folder — permissive; warn if not found.
    if (r.resolve && r.resolve.utilDirExists) {
        setRow('detect-list', 'resolve', 'ok', r.resolve.utilDir);
    } else {
        setRow('detect-list', 'resolve', 'warn',
               'Not found — install Resolve first, or continue without it');
    }

    // Resolve Scripting SDK — the Python wrapper that lives under
    // <ScriptingRoot>/Modules/DaVinciResolveScript.py. Without this file,
    // "Set active version" / Force relink will fail with
    // `No module named 'DaVinciResolveScript'` at Python import time.
    // Warn (not fail) because AE-only users can still finish setup.
    if (r.resolve && r.resolve.moduleExists) {
        setRow('detect-list', 'resolveSdk', 'ok', r.resolve.modulePath);
    } else if (r.resolve) {
        setRow('detect-list', 'resolveSdk', 'warn',
               'Missing — "Set active version" will fail. Reinstall Resolve Studio, or set RESOLVE_SCRIPT_API to a folder containing Modules/DaVinciResolveScript.py.');
    } else {
        setRow('detect-list', 'resolveSdk', 'warn', 'Resolve not detected');
    }

    // FFmpeg — permissive; warn if not found AND nothing saved.
    if (r.ffmpeg && r.ffmpeg.path) {
        if (!state.ffmpegPath) state.ffmpegPath = r.ffmpeg.path;
        setRow('detect-list', 'ffmpeg', 'ok', state.ffmpegPath || r.ffmpeg.path);
    } else if (state.ffmpegPath) {
        setRow('detect-list', 'ffmpeg', 'ok', state.ffmpegPath);
    } else {
        setRow('detect-list', 'ffmpeg', 'warn', 'Not found — previews will stay as .mp4');
    }

    // Python (registry) — this is what DaVinci Resolve checks to decide
    // whether to expose Workspace → Scripts → Utility entries. Warn (not fail)
    // because AE-only users can still finish setup; they just can't use the
    // Resolve half of the roundtrip until they install Python.
    state.pythonRegistered = !!(r.pythonRegistry && r.pythonRegistry.found);
    if (state.pythonRegistered) {
        const v = r.pythonRegistry.version ? ('v' + r.pythonRegistry.version) : '';
        setRow('detect-list', 'python', 'ok',
               `Detected (${r.pythonRegistry.hive} ${v})`.trim());
    } else {
        setRow('detect-list', 'python', 'warn',
               'Not installed — Resolve scripts will not be visible');
    }
}

// ---- Step 2: Fix AE --------------------------------------------------------
async function pickAE() {
    $('err-ae').textContent = '';
    let r;
    try { r = await window.wizard.pickAEExe(); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
        if (r.error) $('err-ae').textContent = r.error;
        return;
    }
    state.aePath = r.path;
    $('in-ae').value = r.path;
    $('btn-next-2').disabled = false;
}

// ---- Step 3: Roundtrip root ------------------------------------------------
async function initRoot() {
    // Pre-fill with Documents\Roundtrip if we don't already have a pick.
    if (!state.rootPath) {
        try {
            const d = await window.wizard.defaultRoot();
            state.rootPath = d && d.path ? d.path : '';
        } catch (_) { state.rootPath = ''; }
    }
    $('in-root').value = state.rootPath || '';
    await revalidateRoot();
}

async function pickRoot() {
    $('err-root').textContent = '';
    let r;
    try { r = await window.wizard.pickRoot(state.rootPath); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) return;
    state.rootPath = r.path;
    $('in-root').value = r.path;
    await revalidateRoot();
}

async function revalidateRoot() {
    if (!state.rootPath) {
        state.rootWritable = false;
        $('btn-next-3').disabled = true;
        $('err-root').textContent = '';
        return;
    }
    let r;
    try { r = await window.wizard.probeWritable(state.rootPath); }
    catch (_) { r = { ok: false }; }
    state.rootWritable = !!r.ok;
    $('btn-next-3').disabled = !state.rootWritable;
    $('err-root').textContent = state.rootWritable ? '' : 'Folder is not writable.';
}

// ---- Step 4: Ready ---------------------------------------------------------
// Refresh the ready-list icons and the Finish button from current state.
async function refreshReady() {
    // AE — hard gate.
    if (state.aePath) setRow('ready-list', 'ae', 'ok', state.aePath);
    else              setRow('ready-list', 'ae', 'fail', 'Not set');

    // Resolve scripts — warn if not detected and not installed by the user.
    const resolveDetected = !!(state.detect && state.detect.resolve
                            && state.detect.resolve.utilDirExists);
    const installBtn = $('btn-install-resolve');
    if (state.resolveInstalled) {
        setRow('ready-list', 'resolve', 'ok', 'Installed');
        installBtn.classList.add('hidden');
    } else if (resolveDetected) {
        setRow('ready-list', 'resolve', 'warn', 'Folder found — not installed yet');
        installBtn.classList.remove('hidden');
    } else {
        setRow('ready-list', 'resolve', 'warn', 'Resolve not detected — skip for now');
        installBtn.classList.add('hidden');
    }

    // FFmpeg — warn only.
    if (state.ffmpegPath) setRow('ready-list', 'ffmpeg', 'ok', state.ffmpegPath);
    else                  setRow('ready-list', 'ffmpeg', 'warn', 'Not found (optional)');

    // Python — expose an "Install Python" button when the registry check says
    // Resolve won't see our scripts. Button hides once registration succeeds.
    const pyBtn = $('btn-install-python');
    if (state.pythonRegistered) {
        setRow('ready-list', 'python', 'ok', 'Detected');
        pyBtn.classList.add('hidden');
    } else {
        setRow('ready-list', 'python', 'warn',
               'Required for Resolve scripts — install to enable');
        pyBtn.classList.remove('hidden');
    }

    // Root — gate.
    if (state.rootPath && state.rootWritable) {
        setRow('ready-list', 'root', 'ok', state.rootPath);
    } else {
        setRow('ready-list', 'root', 'fail', 'Not set');
    }

    // Finish button gate: AE + root must both be valid.
    const canFinish = !!(state.aePath && state.rootPath && state.rootWritable);
    $('btn-finish').disabled = !canFinish;
}

// Download + silent-install Python from python.org. Slow operation (20–60s),
// so we disable the button and show "Installing..." while it runs. On
// success, re-detection is implicit in the IPC response and refreshReady
// flips the row to ✓. On failure we surface the error and a manual-fallback
// URL so the tester isn't stuck.
async function installPythonNow() {
    const btn = $('btn-install-python');
    $('err-finish').textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Installing\u2026'; }
    let r;
    try { r = await window.wizard.installPython(); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (btn) { btn.disabled = false; btn.textContent = 'Install Python'; }
    if (r.ok) {
        state.pythonRegistered = true;
        // Refresh the detect block too so both screens stay consistent.
        state.detect = state.detect || {};
        state.detect.pythonRegistry = r.registry || { found: true };
    } else {
        const extra = r.manualUrl
            ? ` Install manually from ${r.manualUrl}.`
            : '';
        $('err-finish').textContent =
            'Python install failed: ' + (r.error || 'unknown') + '.' + extra;
    }
    await refreshReady();
}

async function installResolveNow() {
    let r;
    try { r = await window.wizard.installResolveScripts(); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (r.ok) {
        state.resolveInstalled = true;
    } else {
        $('err-finish').textContent = 'Could not install Resolve scripts: ' + (r.error || 'unknown');
    }
    await refreshReady();
}

async function clickFinish() {
    $('err-finish').textContent = '';
    const payload = {
        afterEffectsPath:        state.aePath,
        ffmpegPath:              state.ffmpegPath,
        roundtripRoot:           state.rootPath,
        resolveScriptsInstalled: state.resolveInstalled,
    };
    let r;
    try { r = await window.wizard.save(payload); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
        $('err-finish').textContent = r.error || 'Could not save config.';
        return;
    }
    try { await window.wizard.finish(); } catch (_) {}
}

async function clickCancel() {
    try { await window.wizard.cancel(); } catch (_) {}
}

// ---- Wiring ----------------------------------------------------------------
$('btn-cancel-1').onclick = clickCancel;
$('btn-next-1').onclick = () => {
    // If AE wasn't detected, force through Step 2 to pick it manually.
    // Otherwise skip straight to Step 3 (root picker).
    if (!state.aePath) { showStep(2); }
    else               { showStep(3); initRoot(); }
};

$('btn-back-2').onclick = () => showStep(1);
$('btn-next-2').onclick = () => { showStep(3); initRoot(); };
$('pick-ae').onclick    = pickAE;

$('btn-back-3').onclick = () => showStep(state.aePath && state.detect && state.detect.ae
                                            && state.detect.ae.path ? 1 : 2);
$('btn-next-3').onclick = () => { showStep(4); refreshReady(); };
$('pick-root').onclick  = pickRoot;

$('btn-back-4').onclick = () => showStep(3);
$('btn-retry').onclick  = async () => { await runDetect(); await refreshReady(); };
$('btn-install-resolve').onclick = installResolveNow;
$('btn-install-python').onclick  = installPythonNow;
$('btn-finish').onclick = clickFinish;

// ---- Boot ------------------------------------------------------------------
// On startup we ask main for the mode + current config. In edit mode the
// state is pre-populated from config.json and button labels are adjusted;
// otherwise we behave as first-run.
async function boot() {
    let info = { mode: 'first-run', cfg: null };
    try { info = await window.wizard.getMode(); } catch (_) {}

    if (info.mode === 'edit' && info.cfg) {
        const c = info.cfg;
        state.aePath          = c.afterEffectsPath || null;
        state.ffmpegPath      = c.ffmpegPath || null;
        state.rootPath        = c.roundtripRoot || null;
        state.resolveInstalled = !!c.resolveScriptsInstalled;

        $('btn-finish').textContent  = 'Save changes';
        $('btn-cancel-1').textContent = 'Close';
        // In edit mode the user already has a working setup; rootWritable is
        // implied for their existing path (wizard:save will revalidate anyway).
        if (state.rootPath) state.rootWritable = true;
    }

    await runDetect();
}
boot();
