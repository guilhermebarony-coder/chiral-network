// lib/spec.js — pure helpers for the Spec Lock feature (v0.4.9-rc5).
//
// Shared by main.js and the test suite. The renderer currently has its own
// small copies inlined (just formatSpec + diffSpecs), because pulling
// CommonJS modules into the preload-bridged UI isn't worth the wiring for
// three helpers. If the feature grows, promote these into preload exposure.
//
// Everything here is pure: no fs, no ipc, no electron deps. That's the whole
// point — the Python side (export_range.py) has its own equivalents, and
// these have to stay in lockstep with that file's _build_timeline_spec and
// _compare_specs. Any field/tolerance change here MUST be mirrored there,
// and vice versa. Grep anchor: SPEC_LOCK_CONTRACT.

// Fields that trigger a mismatch when they drift. Kept in sync with the
// Python HARD_FIELDS constant in export_range.py :: _compare_specs.
const HARD_FIELDS = Object.freeze(['fps', 'width', 'height']);

// fps tolerance: Resolve's GetSetting rounds 23.976 to e.g. 23.976000000001
// on some builds. 0.01 is large enough to swallow float noise and small
// enough to still catch 23.976 vs 24.0 or 29.97 vs 30.0.
const FPS_EPSILON = 0.01;

// True if two specs are equal on the HARD fields (fps within epsilon,
// width/height exact). Nullish either side = not equal.
function specsMatch(a, b) {
    if (!a || !b) return false;
    for (const k of HARD_FIELDS) {
        const av = a[k];
        const bv = b[k];
        if (k === 'fps') {
            const na = Number(av), nb = Number(bv);
            if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
            if (Math.abs(na - nb) >= FPS_EPSILON) return false;
        } else {
            if (av !== bv) return false;
        }
    }
    return true;
}

// Return an array of {field, locked, current} diffs for every HARD field
// that differs. Empty array = specs match. Used to paint the modal table
// and to build the status-strip "Spec mismatch" tooltip.
function diffSpecs(locked, current) {
    const out = [];
    if (!locked || !current) return out;
    for (const k of HARD_FIELDS) {
        const lv = locked[k];
        const cv = current[k];
        if (k === 'fps') {
            const nl = Number(lv), nc = Number(cv);
            if (Number.isFinite(nl) && Number.isFinite(nc)
                && Math.abs(nl - nc) < FPS_EPSILON) continue;
        } else if (lv === cv) {
            continue;
        }
        out.push({ field: k, locked: lv, current: cv });
    }
    return out;
}

// Human-readable one-liner for the badge. "1920×1080 · 23.976".
// Missing fields are shown as "?" so a malformed lock surfaces visually.
function formatSpec(s) {
    if (!s || typeof s !== 'object') return '?';
    const w   = (s.width  != null) ? s.width  : '?';
    const h   = (s.height != null) ? s.height : '?';
    const fps = (typeof s.fps === 'number' && Number.isFinite(s.fps))
        ? String(Math.round(s.fps * 1000) / 1000)
        : '?';
    return `${w}\u00D7${h} \u00B7 ${fps}`;   // U+00D7 multiplication sign, U+00B7 middle dot
}

module.exports = {
    HARD_FIELDS,
    FPS_EPSILON,
    specsMatch,
    diffSpecs,
    formatSpec,
};
