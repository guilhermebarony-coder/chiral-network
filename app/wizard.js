// wizard.js — renderer logic for the Chiral Network Setup Wizard.
//
// State is a plain object. Navigation is explicit function calls. No classes,
// no state manager, no async queue — just short handlers that call the IPC
// bridge and re-render the relevant pane.
//
// dev50 — added manual After Effects version selector. detectAfterEffects()
// now returns a `versions` array (newest-first). When 2+ AE installs are
// present we reveal the dropdown on Step 1 so the user can pick the
// preferred year; when there's exactly one we silently use it. The
// `roundtripRoot` config key is intentionally preserved on disk for
// upgrade-in-place compatibility (see CHANGELOG entry for the rebrand).

const $ = id => document.getElementById(id);

// ---- State -----------------------------------------------------------------
// Holds everything the Finish step will persist. Populated by detection (Step 1)
// then by the user's manual pickers (Steps 2-3). Only sent to main via
// window.wizard.save() on Finish.
const state = {
    detect:       null,   // result of wizard:detect (ae/resolve/ffmpeg/pythonRegistry)
    aePath:       null,   // resolved AE path (from detect OR manual pick)
    aeVersions:   [],     // dev50 — all detected AE installs (newest-first)
    ffmpegPath:   null,   // resolved ffmpeg path (detect only — no manual picker)
    rootPath:     null,   // user-chosen projects root
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
    // dev52 — segments and labels are siblings in a column-flow grid;
    // both selectors live directly under .progress (no inner .lbl wrapper).
    document.querySelectorAll('.progress .seg').forEach(s => {
        const dn = Number(s.dataset.n);
        s.classList.toggle('active', dn === n);
        s.classList.toggle('done',   dn < n);
    });
    document.querySelectorAll('.progress .lbl').forEach(l => {
        const dn = Number(l.dataset.n);
        l.classList.toggle('active', dn === n);
    });
}

// ---- Icon helpers ----------------------------------------------------------
// Set the icon + label detail on one <li> inside a checklist.
function setRow(listId, key, status, detail) {
    const li = document.querySelector(`#${listId} li[data-k="${key}"]`);
    if (!li) return;
    const ico = li.querySelector('.ico');
    const det = li.querySelector('.detail');
    const glyphs = { ok: '✓', warn: '⚠', fail: '✗', wait: '…' };
    ico.textContent = glyphs[status] || '…';
    ico.className = 'ico ' + status;
    if (det) det.textContent = detail || '';
}

// ---- Step 1: Detect --------------------------------------------------------
// In edit mode, state.aePath / state.ffmpegPath are already populated from
// config.json. Detection still runs to refresh the ✓/⚠/✗ icons, but it must
// NOT clobber the user's existing saved values — it only fills state when
// the slot is empty (first-run, or edit mode with a blank slot).
async function runDetect() {
    ['ae', 'resolve', 'resolveSdk', 'ffmpeg', 'python'].forEach(k =>
        setRow('detect-list', k, 'wait', ''));
    let r;
    try { r = await window.wizard.detect(); }
    catch (_) { r = { ae: null, resolve: null, ffmpeg: null }; }
    state.detect = r;

    // After Effects — hard requirement, so 'fail' if nothing available.
    // dev50 — surface ALL detected versions; the dropdown is always
    // visible (dev51), with a Browse… button for manual picks.
    // Default selection: state.aePath (if it matches a detected install
    // — edit mode) else versions[0] (newest).
    //
    // dev51 — re-detect (Step-4 Re-check, edit-mode boot) MUST NOT wipe
    // user-added manual entries. Merge: detected versions first
    // (newest-first), then any prior manual entries not represented.
    {
        const fresh = (r.ae && Array.isArray(r.ae.versions)) ? r.ae.versions : [];
        const freshPaths = new Set(fresh.map(v => v.path));
        const carry = (state.aeVersions || []).filter(v => !freshPaths.has(v.path));
        state.aeVersions = fresh.concat(carry);
    }
    populateAeVersionDropdown();

    if (r.ae && r.ae.path) {
        if (!state.aePath) state.aePath = r.ae.path;
        const det = aeDetailLabel();
        setRow('detect-list', 'ae', 'ok', det);
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

    // FFmpeg — vendored under resources/vendor/ffmpeg/ in packaged builds, so
    // detection should normally succeed via the bundled candidate. We still
    // accept env / system / PATH fallbacks for from-source dev.
    if (r.ffmpeg && r.ffmpeg.path) {
        if (!state.ffmpegPath) state.ffmpegPath = r.ffmpeg.path;
        setRow('detect-list', 'ffmpeg', 'ok', state.ffmpegPath || r.ffmpeg.path);
    } else if (state.ffmpegPath) {
        setRow('detect-list', 'ffmpeg', 'ok', state.ffmpegPath);
    } else {
        // Vendored ffmpeg should make this branch unreachable in packaged
        // builds; if a tester hits it, vendor/ffmpeg/ wasn't shipped.
        setRow('detect-list', 'ffmpeg', 'warn',
               'Vendored copy missing — previews will stay as .mp4');
    }

    // Python (registry) — Resolve discovers Python via the Windows registry,
    // not via PATH and not via our vendored embeddable. The vendored 3.10.11
    // under resources/vendor/python/ runs the relink/export scripts itself
    // (spawned from main.js); the registry check here is purely about whether
    // Resolve will surface "Workspace → Scripts → Utility → Chiral Network".
    state.pythonRegistered = !!(r.pythonRegistry && r.pythonRegistry.found);
    if (state.pythonRegistered) {
        const v = r.pythonRegistry.version ? ('v' + r.pythonRegistry.version) : '';
        setRow('detect-list', 'python', 'ok',
               `Registered for Resolve (${r.pythonRegistry.hive} ${v})`.trim());
    } else {
        setRow('detect-list', 'python', 'warn',
               'Vendored 3.10.11 ready — register to expose Resolve scripts');
    }
}

// dev51 — the version row is ALWAYS visible, even when a single install
// (or zero installs) is detected. Per tester feedback, the auto-pick of
// the newest year felt too fast and gave the user no say. The
// "Browse…" button next to the dropdown handles portable AE builds,
// custom install paths, and versions our `Adobe After Effects YYYY`
// glob missed.
//
// Header copy adapts to the count: 0 detected → "No After Effects
// install detected"; 1 detected → "After Effects detected"; 2+ →
// "Multiple After Effects installs detected".
function populateAeVersionDropdown() {
    const row  = $('ae-version-row');
    const sel  = $('ae-version-select');
    const head = row && row.querySelector('.ae-row-head');
    const hint = row && row.querySelector('.ae-row-hint');
    if (!row || !sel) return;

    const n = state.aeVersions.length;
    if (n === 0) {
        if (head) head.textContent = 'No After Effects install detected';
        if (hint) hint.textContent = 'Click “Browse…” to point us at AfterFX.exe.';
    } else if (n === 1) {
        if (head) head.textContent = 'After Effects detected';
        if (hint) hint.textContent = 'Confirm this build, or pick a different copy with “Browse…”.';
    } else {
        if (head) head.textContent = 'Multiple After Effects installs detected';
        if (hint) hint.textContent = 'Pick the version you’d like Chiral Network to drive. You can change this later from the wizard’s edit mode.';
    }

    sel.innerHTML = '';
    if (n === 0) {
        // Disabled placeholder so the dropdown reads as "nothing here yet"
        // rather than empty — and so its width matches the populated case.
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— No installs found —';
        placeholder.disabled = true;
        placeholder.selected = true;
        sel.appendChild(placeholder);
        sel.disabled = true;
    } else {
        sel.disabled = false;
        state.aeVersions.forEach((v, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            // "(newest)" suffix only meaningful when there's something to
            // compare against. With a single detected install it's noise.
            opt.textContent = v.label + (idx === 0 && n > 1 ? '  (newest)' : '');
            sel.appendChild(opt);
        });
    }

    // Default selection.
    if (n === 0) {
        state.aePath = null;
    } else {
        let initial = 0;
        if (state.aePath) {
            const found = state.aeVersions.findIndex(v => v.path === state.aePath);
            if (found >= 0) initial = found;
        }
        sel.value = String(initial);
        state.aePath = state.aeVersions[initial].path;
    }

    row.classList.remove('hidden');
}

// dev51 — derive a label/year from any AfterFX.exe path. Used when the
// user picks a version manually — the path may or may not match the
// canonical `C:\Program Files\Adobe\Adobe After Effects YYYY\…` layout
// (portable builds, beta channels, dev installs all break the glob).
function deriveAeMeta(p) {
    if (!p) return null;
    const m = String(p).match(/Adobe After Effects (\d{4})/i);
    if (m) return { path: p, year: m[1], label: 'After Effects ' + m[1] };
    // Fallback — surface the parent folder's tail so the dropdown entry
    // still tells the user *which* manual pick this is, instead of just
    // "Custom".
    const segs = String(p).split(/[\\/]+/).filter(Boolean);
    const tail = segs.length >= 3 ? segs[segs.length - 3] : (segs[0] || p);
    return { path: p, year: null, label: 'Custom: ' + tail };
}

// AE detail label for the Step 1 row — includes the year when known and a
// "(N installs)" suffix when multiple are present, so the user understands
// why the dropdown appeared without having to read the help text.
function aeDetailLabel() {
    const n = state.aeVersions.length;
    const pick = state.aeVersions.find(v => v.path === state.aePath)
              || state.aeVersions[0];
    if (!pick) return state.aePath || '';
    const label = pick.label || state.aePath;
    return n > 1 ? `${label}  ·  ${n} installs detected` : label;
}

// dev52 — the legacy `pickAE()` helper (tied to the now-removed
// #pick-ae button + #in-ae input on Step 2) was retired in favour of
// the unified `_aeBrowse()` flow further down. All Step 2 picker
// state — dropdown, file/folder browse, selected-path readout, Next
// gate — now flows through `refreshAeStep()`.

// ---- Step 3: Projects root -------------------------------------------------
async function initRoot() {
    // Pre-fill with Documents\Roundtrip if we don't already have a pick.
    // Path name is preserved from the rebrand for upgrade-in-place.
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
    if (state.aePath) {
        const pick = state.aeVersions.find(v => v.path === state.aePath);
        const label = pick ? `${pick.label} — ${state.aePath}` : state.aePath;
        setRow('ready-list', 'ae', 'ok', label);
    } else {
        setRow('ready-list', 'ae', 'fail', 'Not set');
    }

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
        setRow('ready-list', 'python', 'ok', 'Registered for Resolve scripting');
        pyBtn.classList.add('hidden');
    } else {
        setRow('ready-list', 'python', 'warn',
               'Vendored 3.10.11 runs the bridge — register to expose Resolve menu');
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
    if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
    let r;
    try { r = await window.wizard.installPython(); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (btn) { btn.disabled = false; btn.textContent = 'Register for Resolve'; }
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
        // Config key intentionally preserved as `roundtripRoot` for
        // upgrade-in-place — pre-rename installs already have this key
        // pointing at their data folder. See CHANGELOG.
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
// dev52 — ALWAYS go to Step 2, even when AE was auto-detected. Tester
// feedback: the auto-skip left users with no chance to confirm or
// override the picked version. Step 2 now owns all AE picker UI.
$('btn-next-1').onclick = () => {
    showStep(2);
    refreshAeStep();
};

$('btn-back-2').onclick = () => showStep(1);
$('btn-next-2').onclick = () => { showStep(3); initRoot(); };

// dev52 — back from Step 3 always returns to Step 2 (the canonical AE
// confirmation point). Pre-dev52 we used to short-cut to Step 1 when
// AE was detected, which was a dead-end for users who wanted to
// re-pick.
$('btn-back-3').onclick = () => { showStep(2); refreshAeStep(); };
$('btn-next-3').onclick = () => { showStep(4); refreshReady(); };
$('pick-root').onclick  = pickRoot;

$('btn-back-4').onclick = () => showStep(3);
$('btn-retry').onclick  = async () => { await runDetect(); await refreshReady(); };
$('btn-install-resolve').onclick = installResolveNow;
$('btn-install-python').onclick  = installPythonNow;
$('btn-finish').onclick = clickFinish;

// dev50/dev51/dev52 — Step 2 AE selector. Dropdown for detected
// installs; "Browse file…" for AfterFX.exe; "Browse folder…" for
// the parent install folder (portable / non-standard layouts where
// we resolve AfterFX.exe inside the chosen directory).
const aeSel          = $('ae-version-select');
const aeBrowse       = $('ae-browse-btn');
const aeBrowseFolder = $('ae-browse-folder-btn');

// Step 2 refresh — sync the selected-path readout, the Next button,
// and the heading hint with current state. Called on every state
// change inside Step 2 (dropdown, file pick, folder pick) AND every
// time we navigate INTO Step 2.
function refreshAeStep() {
    populateAeVersionDropdown();
    const ok  = !!state.aePath;
    const sel = $('ae-selected-path');
    if (sel) {
        sel.classList.remove('ok', 'empty');
        if (ok) {
            sel.textContent = 'Will use: ' + state.aePath;
            sel.classList.add('ok');
        } else {
            sel.textContent = 'No path selected yet — pick one above.';
            sel.classList.add('empty');
        }
    }
    const next = $('btn-next-2');
    if (next) next.disabled = !ok;
    const hint = $('ae-step-hint');
    if (hint) {
        const n = state.aeVersions.length;
        if (n === 0) {
            hint.textContent = 'No After Effects install was found in the standard locations. Use Browse file… or Browse folder… to point Chiral Network at AfterFX.exe.';
        } else if (n === 1) {
            hint.textContent = 'One After Effects install detected. Confirm it below, or Browse to pick a different copy.';
        } else {
            hint.textContent = n + ' After Effects installs detected. Pick which one Chiral Network should drive.';
        }
    }
    $('err-ae').textContent = '';
}

if (aeSel) {
    aeSel.addEventListener('change', () => {
        const idx = parseInt(aeSel.value, 10);
        if (Number.isFinite(idx) && state.aeVersions[idx]) {
            state.aePath = state.aeVersions[idx].path;
            // Mirror to Step 1's status row so the back-and-forth user
            // sees the pick reflected there too.
            setRow('detect-list', 'ae', 'ok', aeDetailLabel());
            refreshAeStep();
        }
    });
}

// Shared handler for both Browse buttons. `kind` selects file vs folder
// IPC; the resulting path goes through the same dedup + select flow.
async function _aeBrowse(kind) {
    let r;
    try {
        r = (kind === 'folder')
            ? await window.wizard.pickAEFolder()
            : await window.wizard.pickAEExe();
    } catch (e) {
        r = { ok: false, error: e && e.message };
    }
    if (!r || !r.ok) {
        if (r && r.error) $('err-ae').textContent = r.error;
        return;
    }
    let idx = state.aeVersions.findIndex(x => x.path === r.path);
    if (idx < 0) {
        state.aeVersions.push(deriveAeMeta(r.path));
        idx = state.aeVersions.length - 1;
    }
    state.aePath = r.path;
    setRow('detect-list', 'ae', 'ok', aeDetailLabel());
    refreshAeStep();
    if (aeSel) aeSel.value = String(idx);
}

if (aeBrowse)       aeBrowse.addEventListener('click',       () => _aeBrowse('file'));
if (aeBrowseFolder) aeBrowseFolder.addEventListener('click', () => _aeBrowse('folder'));

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
