// spec.test.js — v0.4.9-rc5 Spec Lock pure-helper coverage.
//
// These are the JS siblings of export_range.py's _compare_specs and
// _specs_equal_for_ack. If the tolerance rules drift between the two,
// the badge will flip-flop (Python says match, JS says mismatch) — which
// is exactly the kind of bug this suite exists to catch. Update both
// files together. Grep anchor: SPEC_LOCK_CONTRACT.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { specsMatch, diffSpecs, formatSpec, HARD_FIELDS, FPS_EPSILON }
    = require('../lib/spec');

// ---- specsMatch -----------------------------------------------------------
test('specsMatch: identical specs match', () => {
    const s = { fps: 23.976, width: 1920, height: 1080 };
    assert.equal(specsMatch(s, { ...s }), true);
});

test('specsMatch: fps within epsilon matches (float-noise)', () => {
    // Resolve sometimes returns 23.976000000001 for 23.976 — must still match.
    assert.equal(specsMatch(
        { fps: 23.976,           width: 1920, height: 1080 },
        { fps: 23.976000000001,  width: 1920, height: 1080 },
    ), true);
});

test('specsMatch: fps outside epsilon does not match', () => {
    assert.equal(specsMatch(
        { fps: 23.976, width: 1920, height: 1080 },
        { fps: 24.000, width: 1920, height: 1080 },
    ), false);
    assert.equal(specsMatch(
        { fps: 29.97,  width: 1920, height: 1080 },
        { fps: 30.00,  width: 1920, height: 1080 },
    ), false);
});

test('specsMatch: width/height must be exact', () => {
    assert.equal(specsMatch(
        { fps: 24, width: 1920, height: 1080 },
        { fps: 24, width: 1921, height: 1080 },
    ), false);
    assert.equal(specsMatch(
        { fps: 24, width: 1920, height: 1080 },
        { fps: 24, width: 1920, height: 1081 },
    ), false);
});

test('specsMatch: null/undefined inputs return false (fail closed)', () => {
    const s = { fps: 24, width: 1920, height: 1080 };
    assert.equal(specsMatch(null, s),       false);
    assert.equal(specsMatch(s, null),       false);
    assert.equal(specsMatch(undefined, s),  false);
    assert.equal(specsMatch({}, s),         false);
});

// ---- diffSpecs ------------------------------------------------------------
test('diffSpecs: matching specs → empty array', () => {
    const s = { fps: 23.976, width: 1920, height: 1080 };
    assert.deepEqual(diffSpecs(s, { ...s }), []);
});

test('diffSpecs: single-field drift → one entry', () => {
    const diffs = diffSpecs(
        { fps: 23.976, width: 1920, height: 1080 },
        { fps: 29.97,  width: 1920, height: 1080 },
    );
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].field, 'fps');
    assert.equal(diffs[0].locked, 23.976);
    assert.equal(diffs[0].current, 29.97);
});

test('diffSpecs: all-three drift → three entries in HARD_FIELDS order', () => {
    const diffs = diffSpecs(
        { fps: 23.976, width: 1920, height: 1080 },
        { fps: 29.97,  width: 3840, height: 2160 },
    );
    assert.deepEqual(diffs.map(d => d.field), [...HARD_FIELDS]);
});

test('diffSpecs: epsilon fps drift is NOT reported', () => {
    const diffs = diffSpecs(
        { fps: 23.976,           width: 1920, height: 1080 },
        { fps: 23.976000000001,  width: 1920, height: 1080 },
    );
    assert.deepEqual(diffs, []);
});

// ---- formatSpec -----------------------------------------------------------
test('formatSpec: renders width×height · fps', () => {
    assert.equal(formatSpec({ fps: 23.976, width: 1920, height: 1080 }),
                 '1920\u00D71080 \u00B7 23.976');
});

test('formatSpec: rounds fps to 3 decimals', () => {
    assert.equal(formatSpec({ fps: 23.976000000001, width: 1920, height: 1080 }),
                 '1920\u00D71080 \u00B7 23.976');
});

test('formatSpec: null / missing fields produce ?', () => {
    assert.equal(formatSpec(null),       '?');
    assert.equal(formatSpec({}),         '?\u00D7? \u00B7 ?');
    assert.equal(formatSpec({ width: 1920 }),
                 '1920\u00D7? \u00B7 ?');
});

// ---- Invariants -----------------------------------------------------------
test('HARD_FIELDS / FPS_EPSILON: contract stays stable', () => {
    // If these change, update export_range.py's HARD_FIELDS + fps-epsilon
    // in _compare_specs IN THE SAME COMMIT. Grep SPEC_LOCK_CONTRACT.
    assert.deepEqual([...HARD_FIELDS], ['fps', 'width', 'height']);
    assert.equal(FPS_EPSILON, 0.01);
});
