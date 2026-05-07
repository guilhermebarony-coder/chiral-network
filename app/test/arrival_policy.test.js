// test/arrival_policy.test.js — dev44 cross-project arrival policy.
//
// Covers the decision table:
//
//   newArrival | currentShot | sameProject? | → outcome
//   -----------+-------------+--------------+----------
//   null       | *           | *            | none
//   {…}        | null        | n/a          | auto-jump
//   {…}        | set         | yes          | intra-project
//   {…}        | set         | no           | cross-project-banner
//
// This is the rule that prevents the pre-dev44 "user gets teleported
// into another project mid-edit" bug. If you change this table, audit
// every call site — the policy is the contract.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { classifyArrival } = require('../lib/arrival_policy');

test('no arrival → none', () => {
    assert.equal(classifyArrival({ newArrival: null, currentProject: 'a', currentShot: 'Shot_001' }), 'none');
    assert.equal(classifyArrival({ newArrival: undefined, currentProject: null, currentShot: null }), 'none');
});

test('cold start (no shot pinned) → auto-jump regardless of project match', () => {
    // No project, no shot — boot state.
    assert.equal(
        classifyArrival({ newArrival: { project: 'a', shot: 'Shot_001' }, currentProject: null, currentShot: null }),
        'auto-jump'
    );
    // Project seeded from settings.json but shot null — still cold from
    // the user's POV; auto-pick is helpful.
    assert.equal(
        classifyArrival({ newArrival: { project: 'a', shot: 'Shot_001' }, currentProject: 'a', currentShot: null }),
        'auto-jump'
    );
    // Cold, but the arrival is in a DIFFERENT project from the seeded
    // one. Still auto-jump — user has nothing pinned.
    assert.equal(
        classifyArrival({ newArrival: { project: 'b', shot: 'Shot_005' }, currentProject: 'a', currentShot: null }),
        'auto-jump'
    );
});

test('user on a shot, arrival in SAME project → intra-project (caller decides)', () => {
    // Same project — policy hands off to the caller's existing
    // intra-project rule. We don't broadcast a banner saying "appeared
    // in [the same project you're already in]".
    assert.equal(
        classifyArrival({
            newArrival:    { project: 'proj_a', shot: 'Shot_010' },
            currentProject: 'proj_a',
            currentShot:    'Shot_001',
        }),
        'intra-project'
    );
});

test('user on a shot, arrival in DIFFERENT project → cross-project-banner', () => {
    // The case dev44 fixes: user is mid-edit in proj_a, a shot pops
    // up in proj_b. Pre-dev44 this silently teleported the user.
    // dev44: banner only.
    assert.equal(
        classifyArrival({
            newArrival:    { project: 'proj_b', shot: 'Shot_005' },
            currentProject: 'proj_a',
            currentShot:    'Shot_001',
        }),
        'cross-project-banner'
    );
});

test('outcome is purely a function of the inputs (no side-effects observed)', () => {
    // Same inputs twice → same outcome. (The function is pure; this
    // mostly documents the contract for future maintainers.)
    const inputs = {
        newArrival:    { project: 'proj_b', shot: 'Shot_005' },
        currentProject: 'proj_a',
        currentShot:    'Shot_001',
    };
    const a = classifyArrival(inputs);
    const b = classifyArrival(inputs);
    assert.equal(a, b);
    assert.equal(a, 'cross-project-banner');
});
