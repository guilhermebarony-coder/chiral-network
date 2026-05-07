// test/shot_trash.test.js — soft-delete + 7-day retention for shots.
//
// dev35. Each test gets its own tmp PROJECTS_DIR and seeds shot folders
// directly via fs.mkdirSync. No electron, no shared state.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ST = require('../lib/shot_trash');

function tmpProjectsDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `chiral-shottrash-${prefix}-`));
}

// Seed a project with a list of shot folders, each containing one stub
// file so the dir has SOMETHING to verify is moved with it.
function seedProject(projectsDir, projectName, shots) {
    const pDir = path.join(projectsDir, projectName);
    fs.mkdirSync(pDir, { recursive: true });
    for (const s of shots) {
        const sDir = path.join(pDir, s);
        fs.mkdirSync(sDir, { recursive: true });
        fs.writeFileSync(path.join(sDir, 'marker.txt'), s);
    }
    return pDir;
}

// ---- parseEntry / makeTimestamp -------------------------------------------

test('makeTimestamp produces a filename-safe ISO string', () => {
    const ts = ST.makeTimestamp(new Date('2026-04-30T15:22:33.456Z'));
    assert.equal(ts, '2026-04-30T15-22-33-456Z');
    // No characters illegal on Windows.
    assert.equal(/[:.]/.test(ts), false);
});

test('parseEntry splits at first __', () => {
    const e = ST.parseEntry('2026-04-30T15-22-33-456Z__Shot_001');
    assert.equal(e.timestamp, '2026-04-30T15-22-33-456Z');
    assert.equal(e.shotName,  'Shot_001');
});

test('parseEntry preserves underscores in shot names', () => {
    // Single underscores in the shot name don't trigger the split.
    const e = ST.parseEntry('2026-04-30T15-22-33-456Z__shot_with_many_underscores');
    assert.equal(e.shotName, 'shot_with_many_underscores');
});

test('parseEntry returns null for malformed entries', () => {
    assert.equal(ST.parseEntry('no-separator-here'), null);
    assert.equal(ST.parseEntry('__only-shot'), null);
    assert.equal(ST.parseEntry('only-ts__'), null);
});

// ---- trashShot -------------------------------------------------------------

test('trashShot moves the shot dir into .trash/', () => {
    const projectsDir = tmpProjectsDir('trash-basic');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001']);

    const r = ST.trashShot(pDir, 'Shot_001');
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(pDir, 'Shot_001')), false);
    assert.equal(fs.existsSync(r.trashPath), true);
    // Marker file rode along.
    assert.equal(fs.readFileSync(path.join(r.trashPath, 'marker.txt'), 'utf8'), 'Shot_001');
});

test('trashShot fails cleanly when shot does not exist', () => {
    const projectsDir = tmpProjectsDir('trash-missing');
    const pDir = seedProject(projectsDir, 'p1', []);
    const r = ST.trashShot(pDir, 'Shot_404');
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
});

test('trashShot allows multiple deletes of the same name (timestamp suffix disambiguates)', async () => {
    const projectsDir = tmpProjectsDir('trash-dup');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001']);

    const a = ST.trashShot(pDir, 'Shot_001');
    assert.equal(a.ok, true);

    // Recreate the live shot, delete again.
    fs.mkdirSync(path.join(pDir, 'Shot_001'), { recursive: true });
    // Force a different timestamp tick so entry names don't collide.
    await new Promise(r => setTimeout(r, 10));
    const b = ST.trashShot(pDir, 'Shot_001');
    assert.equal(b.ok, true);
    assert.notEqual(a.entry, b.entry);

    const list = ST.listTrash(pDir);
    assert.equal(list.length, 2);
});

// ---- restoreShot -----------------------------------------------------------

test('restoreShot moves the entry back to <project>/<shotName>/', () => {
    const projectsDir = tmpProjectsDir('restore-basic');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001']);

    const t = ST.trashShot(pDir, 'Shot_001');
    const r = ST.restoreShot(pDir, t.entry);
    assert.equal(r.ok, true);
    assert.equal(r.shotName, 'Shot_001');
    assert.equal(fs.existsSync(path.join(pDir, 'Shot_001', 'marker.txt')), true);
    // .trash entry is gone.
    assert.equal(fs.existsSync(t.trashPath), false);
});

test('restoreShot refuses to overwrite a live shot with the same name', () => {
    const projectsDir = tmpProjectsDir('restore-collision');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001']);

    const t = ST.trashShot(pDir, 'Shot_001');
    // Recreate a live shot with the same name.
    fs.mkdirSync(path.join(pDir, 'Shot_001'), { recursive: true });

    const r = ST.restoreShot(pDir, t.entry);
    assert.equal(r.ok, false);
    assert.match(r.error, /already exists/);
    // Trash entry still present — refused, didn't drop it.
    assert.equal(fs.existsSync(t.trashPath), true);
});

test('restoreShot fails cleanly on unknown entry', () => {
    const projectsDir = tmpProjectsDir('restore-missing');
    const pDir = seedProject(projectsDir, 'p1', []);
    const r = ST.restoreShot(pDir, 'nope__Shot_001');
    assert.equal(r.ok, false);
});

// ---- listTrash / listAllTrash ----------------------------------------------

test('listTrash returns parsed entries with shotName + trashedAt', () => {
    const projectsDir = tmpProjectsDir('list-basic');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001', 'Shot_002']);

    ST.trashShot(pDir, 'Shot_001');
    ST.trashShot(pDir, 'Shot_002');

    const list = ST.listTrash(pDir);
    assert.equal(list.length, 2);
    const names = list.map(e => e.shotName).sort();
    assert.deepEqual(names, ['Shot_001', 'Shot_002']);
    for (const e of list) {
        assert.ok(e.trashedAt, 'every entry has a trashedAt');
        assert.match(e.entry, /__/);
    }
});

test('listTrash returns [] for a project with no .trash dir', () => {
    const projectsDir = tmpProjectsDir('list-empty');
    const pDir = seedProject(projectsDir, 'p1', []);
    assert.deepEqual(ST.listTrash(pDir), []);
});

test('listAllTrash spans projects and tags each entry with project name', () => {
    const projectsDir = tmpProjectsDir('list-all');
    const pA = seedProject(projectsDir, 'projA', ['Shot_001']);
    const pB = seedProject(projectsDir, 'projB', ['Shot_002']);
    const tA = ST.trashShot(pA, 'Shot_001');
    const tB = ST.trashShot(pB, 'Shot_002');
    // Force deterministic mtime ordering. Real-time sleeps are flaky on
    // Windows where the FS mtime resolution is ~16ms — two trashes can
    // land in the same tick. Set mtimes explicitly: tA in the past, tB
    // recent. Now the newest-first sort is guaranteed regardless of
    // host clock granularity.
    const tenSecAgo = Date.now() / 1000 - 10;
    fs.utimesSync(tA.trashPath, tenSecAgo, tenSecAgo);
    const now = Date.now() / 1000;
    fs.utimesSync(tB.trashPath, now, now);

    const all = ST.listAllTrash(projectsDir);
    assert.equal(all.length, 2);
    const projects = all.map(e => e.project).sort();
    assert.deepEqual(projects, ['projA', 'projB']);
    // Newest first.
    assert.equal(all[0].project, 'projB');
});

test('listAllTrash skips dotfile-prefixed dirs at the projects root', () => {
    const projectsDir = tmpProjectsDir('list-skip-dots');
    seedProject(projectsDir, 'p1', []);
    fs.mkdirSync(path.join(projectsDir, '.hidden'), { recursive: true });
    const all = ST.listAllTrash(projectsDir);
    assert.equal(all.length, 0);
});

// ---- purgeOldShotTrash -----------------------------------------------------

test('purgeOldShotTrash removes only entries older than the cutoff', () => {
    const projectsDir = tmpProjectsDir('purge-old');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001', 'Shot_002']);
    const t1 = ST.trashShot(pDir, 'Shot_001');
    const t2 = ST.trashShot(pDir, 'Shot_002');

    // Backdate t1 by 10 days.
    const past = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(t1.trashPath, past, past);

    const removed = ST.purgeOldShotTrash(projectsDir, 7);
    assert.equal(removed.length, 1);
    assert.equal(fs.existsSync(t1.trashPath), false);
    assert.equal(fs.existsSync(t2.trashPath), true);
});

// ---- emptyAllShotTrash -----------------------------------------------------

test('emptyAllShotTrash wipes every entry across every project', () => {
    const projectsDir = tmpProjectsDir('empty-all');
    const pA = seedProject(projectsDir, 'projA', ['Shot_001']);
    const pB = seedProject(projectsDir, 'projB', ['Shot_002', 'Shot_003']);
    ST.trashShot(pA, 'Shot_001');
    ST.trashShot(pB, 'Shot_002');
    ST.trashShot(pB, 'Shot_003');

    const removed = ST.emptyAllShotTrash(projectsDir);
    assert.equal(removed.length, 3);
    assert.deepEqual(ST.listAllTrash(projectsDir), []);
});

// ---- purgeEntry ------------------------------------------------------------

test('purgeEntry removes a single trash entry', () => {
    const projectsDir = tmpProjectsDir('purge-one');
    const pDir = seedProject(projectsDir, 'p1', ['Shot_001', 'Shot_002']);
    ST.trashShot(pDir, 'Shot_001');
    const t2 = ST.trashShot(pDir, 'Shot_002');

    const r = ST.purgeEntry(pDir, t2.entry);
    assert.equal(r.ok, true);
    const list = ST.listTrash(pDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].shotName, 'Shot_001');
});
