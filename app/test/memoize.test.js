// memoize.test.js — smoke coverage for lib/memoize.js.
//
// Run with: npm test

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { memoizeByMtime } = require('../lib/memoize');

function tmpFile(contents) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chiral-memo-'));
    const p = path.join(d, 'x.json');
    fs.writeFileSync(p, contents);
    return { dir: d, file: p };
}
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

test('memoizeByMtime: returns same value on repeated call with unchanged mtime', () => {
    const { dir, file } = tmpFile('{"v":1}');
    try {
        let calls = 0;
        const fn = memoizeByMtime(
            (p) => { calls += 1; return JSON.parse(fs.readFileSync(p, 'utf8')); },
            (p) => p,
        );
        const a = fn(file);
        const b = fn(file);
        assert.equal(a.v, 1);
        assert.equal(b.v, 1);
        assert.equal(calls, 1, 'cache should suppress second call');
    } finally { rmrf(dir); }
});

test('memoizeByMtime: invalidates when backing file mtime changes', () => {
    const { dir, file } = tmpFile('{"v":1}');
    try {
        let calls = 0;
        const fn = memoizeByMtime(
            (p) => { calls += 1; return JSON.parse(fs.readFileSync(p, 'utf8')); },
            (p) => p,
        );
        fn(file);
        // Force a distinct mtime — NTFS mtime resolution is coarse enough
        // that a same-millisecond rewrite can collide. utimesSync after the
        // rewrite pins mtime to a future timestamp deterministically.
        fs.writeFileSync(file, '{"v":2}');
        const future = new Date(Date.now() + 5_000);
        fs.utimesSync(file, future, future);
        const b = fn(file);
        assert.equal(b.v, 2);
        assert.equal(calls, 2, 'cache should miss after mtime change');
    } finally { rmrf(dir); }
});

test('memoizeByMtime: missing file uses sentinel mtime (-1) and still caches', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chiral-memo-'));
    try {
        const missing = path.join(d, 'nope.json');
        let calls = 0;
        const fn = memoizeByMtime(
            () => { calls += 1; return 'fallback'; },
            (p) => p,
        );
        fn(missing); fn(missing);
        assert.equal(calls, 1);
    } finally { rmrf(d); }
});

test('memoizeByMtime: clear() drops all entries', () => {
    const { dir, file } = tmpFile('{"v":1}');
    try {
        let calls = 0;
        const fn = memoizeByMtime(
            () => { calls += 1; return {}; },
            (p) => p,
        );
        fn(file);
        fn.clear();
        fn(file);
        assert.equal(calls, 2);
    } finally { rmrf(dir); }
});
