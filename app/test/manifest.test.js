// manifest.test.js — smoke coverage for lib/manifest.js.
//
// Run with: node --test app/test/
//
// Scope is deliberately narrow. These are NOT exhaustive unit tests — they
// cover the read/write/migrate contracts that other modules depend on, so
// a breaking change (e.g. readManifest starts throwing on ENOENT) is caught
// before it ships.
//
// We use node:test + node:assert/strict so there's no dep to install and
// the harness runs on any machine that can already run Electron.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { readManifest, writeManifest, withManifest } = require('../lib/manifest');
const { sanitizeName } = require('../lib/projects');
const {
    resolveJobFormat, resolveJobScale,
    FORMAT_EXT,
} = require('../lib/job');

// ---- Helpers ---------------------------------------------------------------
// Each test gets a fresh tmpdir so parallel runs + reruns never contaminate.
// Cleaned up in afterEach via test.after — node:test doesn't have per-test
// afterEach, but a closure-scoped dir + one cleanup at end is enough.
function makeTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chiral-manifest-'));
    return d;
}
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// ---- readManifest: missing file -------------------------------------------
test('readManifest: missing file returns defaultValue clone', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'nope.json');
        const def = { a: 1, nested: { b: 2 } };
        const r = readManifest(p, { defaultValue: def });
        assert.deepEqual(r, { a: 1, nested: { b: 2 } });
        // Must be a CLONE, not the same reference — caller mutation can't
        // poison the next read.
        r.nested.b = 999;
        const r2 = readManifest(p, { defaultValue: def });
        assert.equal(r2.nested.b, 2, 'defaultValue was mutated across reads');
        assert.equal(fs.existsSync(p), false, 'missing-file read should not create');
    } finally { rmrf(tmp); }
});

test('readManifest: createIfAbsent writes seed with schemaVersion', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'seeded.json');
        const r = readManifest(p, {
            defaultValue:  { foo: 'bar' },
            targetVersion: 3,
            createIfAbsent: true,
        });
        assert.equal(r.foo, 'bar');
        assert.equal(r.schemaVersion, 3);
        assert.equal(fs.existsSync(p), true);
        const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.equal(onDisk.schemaVersion, 3);
    } finally { rmrf(tmp); }
});

// ---- readManifest: malformed + wrong shape --------------------------------
test('readManifest: malformed JSON returns default (no throw)', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'broken.json');
        fs.writeFileSync(p, '{ this is not json');
        const r = readManifest(p, { defaultValue: { fallback: true } });
        assert.deepEqual(r, { fallback: true });
    } finally { rmrf(tmp); }
});

test('readManifest: top-level array is rejected as default', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'arr.json');
        fs.writeFileSync(p, '[1, 2, 3]');
        const r = readManifest(p, { defaultValue: {} });
        assert.deepEqual(r, {});
    } finally { rmrf(tmp); }
});

// ---- writeManifest: schemaVersion stamping --------------------------------
test('writeManifest: stamps schemaVersion when absent', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 's.json');
        writeManifest(p, { lockedSpec: { fps: 24 } }, { targetVersion: 1 });
        const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.equal(onDisk.schemaVersion, 1);
        assert.equal(onDisk.lockedSpec.fps, 24);
    } finally { rmrf(tmp); }
});

test('writeManifest: preserves caller-set schemaVersion', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 's.json');
        writeManifest(p, { schemaVersion: 7, foo: 1 }, { targetVersion: 1 });
        const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.equal(onDisk.schemaVersion, 7, 'caller version should not be overwritten');
    } finally { rmrf(tmp); }
});

// ---- Migrations ------------------------------------------------------------
test('readManifest: runs v0->v1->v2 migrations in order + flushes to disk', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'm.json');
        // Legacy unversioned file (schemaVersion=0 is implicit).
        fs.writeFileSync(p, JSON.stringify({ legacyName: 'old' }));
        const migrations = [
            // v0 → v1: rename legacyName → name
            (o) => { o.name = o.legacyName; delete o.legacyName; },
            // v1 → v2: add emptyArr
            (o) => { o.emptyArr = []; },
        ];
        const r = readManifest(p, {
            defaultValue:  {},
            targetVersion: 2,
            migrations,
        });
        assert.equal(r.schemaVersion, 2);
        assert.equal(r.name, 'old');
        assert.equal(r.legacyName, undefined);
        assert.deepEqual(r.emptyArr, []);
        // Flushed back to disk so the next read skips migrations.
        const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.equal(onDisk.schemaVersion, 2);
        assert.equal(onDisk.name, 'old');
    } finally { rmrf(tmp); }
});

test('readManifest: already-current file skips migration pass', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'cur.json');
        fs.writeFileSync(p, JSON.stringify({ schemaVersion: 2, k: 'v' }));
        const mtimeBefore = fs.statSync(p).mtimeMs;
        // A throwing migration would fail the test if invoked — proof that
        // current-version reads skip the migration chain entirely.
        const migrations = [
            () => { throw new Error('v0->v1 should not run'); },
            () => { throw new Error('v1->v2 should not run'); },
        ];
        const r = readManifest(p, {
            defaultValue:  {},
            targetVersion: 2,
            migrations,
        });
        assert.equal(r.schemaVersion, 2);
        assert.equal(r.k, 'v');
        const mtimeAfter = fs.statSync(p).mtimeMs;
        assert.equal(mtimeBefore, mtimeAfter, 'file should not be rewritten on no-op read');
    } finally { rmrf(tmp); }
});

test('readManifest: gap in migrations stops climb without crashing', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'gap.json');
        fs.writeFileSync(p, JSON.stringify({ schemaVersion: 0 }));
        // Only migrations[0] provided — we expect the climb to v1 then stop.
        const migrations = [ (o) => { o.stepOneRan = true; } ];
        const r = readManifest(p, {
            defaultValue:  {},
            targetVersion: 3,
            migrations,
        });
        assert.equal(r.schemaVersion, 1);
        assert.equal(r.stepOneRan, true);
    } finally { rmrf(tmp); }
});

// ---- withManifest ----------------------------------------------------------
test('withManifest: truthy mutator → commit to disk', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'w.json');
        fs.writeFileSync(p, JSON.stringify({ count: 1 }));
        withManifest(p, { targetVersion: 1 }, (m) => {
            m.count = 2;
            return true;
        });
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).count, 2);
    } finally { rmrf(tmp); }
});

test('withManifest: falsy mutator → no write', () => {
    const tmp = makeTmp();
    try {
        const p = path.join(tmp, 'w.json');
        fs.writeFileSync(p, JSON.stringify({ count: 1 }));
        const mtimeBefore = fs.statSync(p).mtimeMs;
        withManifest(p, {}, (_m) => false);
        const mtimeAfter = fs.statSync(p).mtimeMs;
        assert.equal(mtimeBefore, mtimeAfter);
    } finally { rmrf(tmp); }
});

// ---- Sanity checks on sibling modules we lean on -------------------------
// Cheap coverage for the other pure helpers the vault work will exercise.
// Not a replacement for dedicated test files — just smoke that they load.
test('projects.sanitizeName: basic rules', () => {
    assert.equal(sanitizeName('Hello World'), 'hello_world');
    assert.equal(sanitizeName('  A B  '), 'a_b');
    assert.equal(sanitizeName('a/b:c*d'), 'a_b_c_d');
    assert.equal(sanitizeName(''), '');
    assert.equal(sanitizeName('_leading_'), 'leading');
    // 48-char cap
    assert.equal(sanitizeName('a'.repeat(100)).length, 48);
});

test('job.resolveJobFormat / resolveJobScale: explicit fields win', () => {
    assert.equal(resolveJobFormat({ renderFormat: 'mp4' }), 'mp4');
    assert.equal(resolveJobFormat({ renderFormat: 'prores_422' }), 'prores_422');
    // Legacy quality → format mapping
    assert.equal(resolveJobFormat({ renderQuality: 'superfast' }), 'mp4');
    assert.equal(resolveJobFormat({ renderQuality: 'final' }), 'prores_4444');
    // Scale: explicit numeric rounds to nearest valid scale
    assert.equal(resolveJobScale({ renderScale: 0.73 }), 0.75);
    assert.equal(resolveJobScale({ renderScale: 1.0  }), 1.0);
    // No hints → final
    assert.equal(resolveJobScale({}), 1.0);
    assert.equal(FORMAT_EXT['mp4'], '.mp4');
    assert.equal(FORMAT_EXT['prores_4444'], '.mov');
});
