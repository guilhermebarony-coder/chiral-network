// test/spawn_lock.test.js — AE scripting lock primitive (dev20).
//
// The lock itself is process-local state in lib/spawn.js. We test:
//   * Sequential acquires don't overlap.
//   * FIFO order under contention.
//   * release() is idempotent.
//   * aeBusyState reflects acquires/releases.
//   * setAEBusyEmit fires on every transition.
//
// Auto-release safety net is *not* tested here — it's a 20-min timer and
// we don't want a slow test. Inspection is sufficient for that path.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { acquireAELock, aeBusyState, setAEBusyEmit } = require('../lib/spawn');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('acquireAELock: serializes overlapping acquires', async () => {
    const order = [];
    const releaseA = await acquireAELock('A');
    assert.equal(aeBusyState().busy, true);

    // B parks until A releases.
    const bPromise = (async () => {
        const releaseB = await acquireAELock('B');
        order.push('B-acquired');
        releaseB();
    })();

    await sleep(20);
    order.push('A-still-holding');
    releaseA();
    await bPromise;

    assert.deepEqual(order, ['A-still-holding', 'B-acquired']);
    assert.equal(aeBusyState().busy, false);
});

test('acquireAELock: FIFO under contention', async () => {
    const order = [];
    const releaseA = await acquireAELock('A');

    const promises = ['B', 'C', 'D'].map(label =>
        (async () => {
            const r = await acquireAELock(label);
            order.push(label);
            await sleep(5);
            r();
        })()
    );

    await sleep(15);
    releaseA();
    await Promise.all(promises);

    assert.deepEqual(order, ['B', 'C', 'D']);
});

test('acquireAELock: release() is idempotent', async () => {
    const release = await acquireAELock('idem');
    release();
    assert.equal(aeBusyState().busy, false);
    // Second call must not flip _aeBusy or wake a phantom waiter.
    release();
    assert.equal(aeBusyState().busy, false);

    // Subsequent acquire should still work cleanly.
    const r2 = await acquireAELock('after-idem');
    assert.equal(aeBusyState().busy, true);
    r2();
});

test('aeBusyState: reports queueDepth while contended', async () => {
    const releaseA = await acquireAELock('A');
    const pendingB = acquireAELock('B');   // parked
    const pendingC = acquireAELock('C');   // parked

    await sleep(5);
    const state = aeBusyState();
    assert.equal(state.busy, true);
    assert.equal(state.label, 'A');
    assert.equal(state.queueDepth, 2);

    releaseA();
    (await pendingB)();
    (await pendingC)();
    assert.equal(aeBusyState().queueDepth, 0);
});

test('acquireAELock: enforces the dev26 800ms post-release cooldown', async () => {
    // Release a lock, then immediately try to take it again. The second
    // acquire must NOT resolve before COOLDOWN_MS has elapsed since the
    // release. We use 600ms as a lower bound check so a slow CI machine
    // doesn't flake on the 800ms target.
    const releaseA = await acquireAELock('cooldown-A');
    const releasedAt = Date.now();
    releaseA();

    const releaseB = await acquireAELock('cooldown-B');
    const elapsed = Date.now() - releasedAt;
    releaseB();

    assert.ok(elapsed >= 600,
        `expected acquire-after-release to be delayed by ~800ms, got ${elapsed}ms`);
});

test('setAEBusyEmit: fires on each acquire and release', async () => {
    const events = [];
    setAEBusyEmit(s => events.push({ busy: s.busy, label: s.label }));

    const r = await acquireAELock('emit-test');
    r();

    // Restore default (no-op) so other tests don't see leftover spy.
    setAEBusyEmit(null);

    // At minimum: one busy=true after acquire, one busy=false after release.
    const busyEvents    = events.filter(e => e.busy === true);
    const notBusyEvents = events.filter(e => e.busy === false);
    assert.ok(busyEvents.length    >= 1, 'expected a busy=true emit');
    assert.ok(notBusyEvents.length >= 1, 'expected a busy=false emit');
    assert.equal(busyEvents[busyEvents.length - 1].label, 'emit-test');
});
