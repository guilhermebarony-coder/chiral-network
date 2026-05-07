// test/watch.test.js — debounced fs.watch wrapper. dev43.
//
// Covers the contract of lib/watch.js#createWatcher:
//
//   * fires onChange after debounceMs of quiet
//   * coalesces bursts into a single fire
//   * returns a noop handle for missing / unreadable dirs
//   * close() stops further fires
//   * close() on a noop handle is safe
//
// The fs.watch backend itself is the OS — we don't unit-test that.
// We DO assert the wrapper's debounce + lifecycle behaviour, which
// is the only logic this lib owns.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createWatcher } = require('../lib/watch');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `chiral-watch-${prefix}-`));
}

// Helper — touch a file inside the watched dir. Used to provoke the
// fs.watch backend.
function touch(dir, name) {
    fs.writeFileSync(path.join(dir, name), String(Date.now()));
}

test('createWatcher returns a noop handle for a missing dir', () => {
    const w = createWatcher(path.join(os.tmpdir(), 'definitely-not-a-real-dir-xyz'),
                            { debounceMs: 50 }, () => assert.fail('should not fire'));
    // Just close it — this asserts no throw + the close function exists.
    w.close();
});

test('createWatcher returns a noop handle for null / undefined', () => {
    const w1 = createWatcher(null, {}, () => {});
    const w2 = createWatcher(undefined, {}, () => {});
    w1.close(); w2.close();   // no throw
});

test('createWatcher fires onChange once after a single write (debounced)', (t, done) => {
    const d = tmpDir('single-write');
    let calls = 0;
    const w = createWatcher(d, { debounceMs: 80 }, () => { calls++; });

    setTimeout(() => touch(d, 'a.txt'), 20);
    setTimeout(() => {
        try {
            assert.equal(calls, 1, 'expected exactly one fire');
            w.close();
            done();
        } catch (e) { w.close(); done(e); }
    }, 250);
});

test('createWatcher coalesces a burst of writes into a single fire', (t, done) => {
    const d = tmpDir('burst');
    let calls = 0;
    const w = createWatcher(d, { debounceMs: 100 }, () => { calls++; });

    // 5 writes within ~50ms — well inside the debounce window.
    for (let i = 0; i < 5; i++) {
        setTimeout(() => touch(d, `f${i}.txt`), i * 10);
    }
    // Check after 250ms (debounce + slack).
    setTimeout(() => {
        try {
            // On Windows fs.watch can fire multiple events per write
            // (write + truncate + rename); the wrapper's job is to
            // collapse all of them into ONE call. Tolerate exactly 1.
            assert.equal(calls, 1, 'expected exactly one fire from a burst');
            w.close();
            done();
        } catch (e) { w.close(); done(e); }
    }, 300);
});

test('createWatcher fires twice for two writes separated by > debounceMs', (t, done) => {
    const d = tmpDir('two-windows');
    let calls = 0;
    const w = createWatcher(d, { debounceMs: 60 }, () => { calls++; });

    setTimeout(() => touch(d, 'a.txt'), 20);
    setTimeout(() => touch(d, 'b.txt'), 220);
    setTimeout(() => {
        try {
            assert.equal(calls, 2, 'expected two separate fires');
            w.close();
            done();
        } catch (e) { w.close(); done(e); }
    }, 400);
});

test('close() stops further fires', (t, done) => {
    const d = tmpDir('close-stops');
    let calls = 0;
    const w = createWatcher(d, { debounceMs: 50 }, () => { calls++; });

    // Cause one fire, then close, then write again — second write must
    // not increment calls.
    setTimeout(() => touch(d, 'a.txt'), 20);
    setTimeout(() => w.close(), 150);
    setTimeout(() => touch(d, 'b.txt'), 200);
    setTimeout(() => {
        try {
            assert.equal(calls, 1, 'second write must not fire after close');
            done();
        } catch (e) { done(e); }
    }, 350);
});

test('close() is safe to call multiple times', () => {
    const d = tmpDir('double-close');
    const w = createWatcher(d, { debounceMs: 50 }, () => {});
    w.close();
    w.close();   // no throw
});
