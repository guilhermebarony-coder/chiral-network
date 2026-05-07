// test/vault_pipeline.test.js — pure-ish pieces of the Vault orchestrator.
//
// The full vaultShot() path requires a running AE. What we CAN test without
// electron / AE / ffmpeg is:
//   * pollForSentinel — done/error flag contract
//   * findMasterInVersion — the render-selection heuristic
//   * proxy.enqueue — single-slot FIFO queue ordering

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
    pollForSentinel, findMasterInVersion, canVaultShot,
    _availableShotName, _partitionExistingClips,
} = require('../lib/vault_pipeline');
const { enqueue, queueDepth, buildProxyArgs, buildThumbArgs } = require('../lib/proxy');

function tmpDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `chiral-pipe-${tag}-`));
}

// ---- pollForSentinel -------------------------------------------------------

test('pollForSentinel: returns payload when done flag appears', async () => {
    const d = tmpDir('done');
    const done  = path.join(d, '.vault.done.json');
    const err   = path.join(d, '.vault.error.json');

    setTimeout(() => {
        fs.writeFileSync(done, JSON.stringify({ ok: true, footageCount: 3 }));
    }, 50);

    const r = await pollForSentinel(done, err, 3000, 20);
    assert.equal(r.ok, true);
    assert.equal(r.payload.footageCount, 3);
    // Sentinel gets consumed after read.
    assert.equal(fs.existsSync(done), false);
});

test('pollForSentinel: returns error when error flag appears', async () => {
    const d = tmpDir('err');
    const done = path.join(d, '.vault.done.json');
    const err  = path.join(d, '.vault.error.json');

    setTimeout(() => {
        fs.writeFileSync(err, JSON.stringify({ ok: false, error: 'AE crashed' }));
    }, 50);

    const r = await pollForSentinel(done, err, 3000, 20);
    assert.equal(r.ok, false);
    assert.match(r.error, /AE crashed/);
    assert.equal(fs.existsSync(err), false);
});

test('pollForSentinel: returns timeout after window', async () => {
    const d = tmpDir('to');
    const done = path.join(d, '.vault.done.json');
    const err  = path.join(d, '.vault.error.json');
    const r = await pollForSentinel(done, err, 150, 30);
    assert.equal(r.ok, false);
    assert.match(r.error, /timeout/);
    // dev16 — timedOut flag distinguishes "AE wrote an error" from "AE
    // never came back," so callers can decide whether to clean up the
    // temp job file or keep it for forensics.
    assert.equal(r.timedOut, true);
});

test('pollForSentinel: error sentinel does NOT set timedOut', async () => {
    const d = tmpDir('errnotim');
    const done = path.join(d, '.vault.done.json');
    const err  = path.join(d, '.vault.error.json');
    setTimeout(() => {
        fs.writeFileSync(err, JSON.stringify({ ok: false, error: 'boom' }));
    }, 30);
    const r = await pollForSentinel(done, err, 1000, 20);
    assert.equal(r.ok, false);
    assert.notEqual(r.timedOut, true);
});

// ---- findMasterInVersion ---------------------------------------------------

test('findMasterInVersion: picks the largest non-preview file', () => {
    const d = tmpDir('master');
    // Larger master.mov (1 MB zeroes), smaller preview.mp4 (1 KB).
    fs.writeFileSync(path.join(d, 'shot_v01.mov'), Buffer.alloc(1024 * 1024));
    fs.writeFileSync(path.join(d, 'shot_v01_preview.mp4'), Buffer.alloc(1024));
    const r = findMasterInVersion(d);
    assert.equal(path.basename(r), 'shot_v01.mov');
});

test('findMasterInVersion: ignores preview-only dirs', () => {
    const d = tmpDir('preview-only');
    fs.writeFileSync(path.join(d, 'shot_v01_preview.mp4'), Buffer.alloc(1024));
    const r = findMasterInVersion(d);
    assert.equal(r, null);
});

test('findMasterInVersion: returns null for missing dir', () => {
    assert.equal(findMasterInVersion(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), null);
});

// ---- canVaultShot ----------------------------------------------------------
// The precondition check the UI consults before offering "Vault this shot".
// We stage a fake shot layout and walk through the four refusal branches.

// stageShot mirrors the real project layout: renders/vNN/ (NOT versions/).
// dev8 — folder-name fix: earlier tests used versions/ which matched the
// broken implementation but not the actual app on disk.
function stageShot(tag, { hasJob = true, finalVersion = 'v01', hasVersionDir = true, masterBytes = 1024 * 1024, aepExists = true } = {}) {
    const root = tmpDir('shot-' + tag);
    const shotName = 'Shot_001';
    const shotDir  = path.join(root, shotName);
    fs.mkdirSync(path.join(shotDir, 'source'), { recursive: true });
    const aepPath = path.join(root, 'fake.aep');
    if (aepExists) fs.writeFileSync(aepPath, 'not a real .aep');
    if (hasJob) {
        const job = { finalVersion, aepPath };
        fs.writeFileSync(path.join(shotDir, 'source', 'job.json'), JSON.stringify(job));
    }
    if (hasVersionDir && finalVersion) {
        const vd = path.join(shotDir, 'renders', finalVersion);
        fs.mkdirSync(vd, { recursive: true });
        if (masterBytes > 0) fs.writeFileSync(path.join(vd, 'Shot_001_v01.mov'), Buffer.alloc(masterBytes));
    }
    return { projectDir: root, shotName };
}

test('canVaultShot: ok path with final master returns finalVersion + masterPath', () => {
    const { projectDir, shotName } = stageShot('ok');
    const r = canVaultShot(projectDir, shotName);
    assert.equal(r.ok, true);
    assert.equal(r.hasMaster, true);
    assert.equal(r.finalVersion, 'v01');
    assert.match(r.masterPath, /Shot_001_v01\.mov$/);
});

test('canVaultShot: refuses when job.json missing', () => {
    const { projectDir, shotName } = stageShot('nojob', { hasJob: false });
    const r = canVaultShot(projectDir, shotName);
    assert.equal(r.ok, false);
    assert.match(r.reason, /no job\.json/i);
});

test('canVaultShot: ALLOWS when finalVersion not set (dev8 relaxed)', () => {
    // Per user feedback: WIP shots without a marked final version are still
    // vaultable — the .aep + collected footage are the primary value.
    const { projectDir, shotName } = stageShot('nofv', { finalVersion: null });
    const r = canVaultShot(projectDir, shotName);
    assert.equal(r.ok, true);
    assert.equal(r.hasMaster, false);
    assert.equal(r.finalVersion, null);
});

test('canVaultShot: ALLOWS when version dir has only a preview (dev8 relaxed)', () => {
    const { projectDir, shotName } = stageShot('prev', { masterBytes: 0 });
    const vd = path.join(projectDir, shotName, 'renders', 'v01');
    fs.writeFileSync(path.join(vd, 'Shot_001_v01_preview.mp4'), Buffer.alloc(1024));
    const r = canVaultShot(projectDir, shotName);
    assert.equal(r.ok, true);
    assert.equal(r.hasMaster, false);
});

test('canVaultShot: auto-picks newest rendered version when finalVersion not set', () => {
    // Shot with v01 + v02 renders but no marked final — we should discover
    // v02 as the master source (reverse-sort of vNN names).
    const { projectDir, shotName } = stageShot('auto', { finalVersion: null });
    const rendersRoot = path.join(projectDir, shotName, 'renders');
    fs.mkdirSync(path.join(rendersRoot, 'v01'), { recursive: true });
    fs.mkdirSync(path.join(rendersRoot, 'v02'), { recursive: true });
    fs.writeFileSync(path.join(rendersRoot, 'v01', 'a.mov'), Buffer.alloc(512));
    fs.writeFileSync(path.join(rendersRoot, 'v02', 'b.mov'), Buffer.alloc(1024));
    const r = canVaultShot(projectDir, shotName);
    assert.equal(r.ok, true);
    assert.equal(r.hasMaster, true);
    assert.equal(r.finalVersion, 'v02');
    assert.match(r.masterPath, /b\.mov$/);
});

test('canVaultShot: refuses when .aep is missing', () => {
    const { projectDir, shotName } = stageShot('noaep', { aepExists: false });
    const r = canVaultShot(projectDir, shotName);
    assert.equal(r.ok, false);
    assert.match(r.reason, /AE project file missing/i);
});

// ---- _availableShotName (dev15 #1 — collision suffix) ---------------------

test('_availableShotName: returns base name when nothing exists', () => {
    const d = tmpDir('avail-clean');
    assert.equal(_availableShotName(d, 'Shot_002_from_X'), 'Shot_002_from_X');
});

test('_availableShotName: suffixes _2 when base exists', () => {
    const d = tmpDir('avail-collide');
    fs.mkdirSync(path.join(d, 'Shot_X'));
    assert.equal(_availableShotName(d, 'Shot_X'), 'Shot_X_2');
});

test('_availableShotName: walks suffixes 2..N until free', () => {
    const d = tmpDir('avail-walk');
    fs.mkdirSync(path.join(d, 'A'));
    fs.mkdirSync(path.join(d, 'A_2'));
    fs.mkdirSync(path.join(d, 'A_3'));
    assert.equal(_availableShotName(d, 'A'), 'A_4');
});

test('_availableShotName: collides on file too, not just dir', () => {
    // If someone leaves a file with the same name (shouldn't happen, but
    // we use existsSync which is file/dir agnostic), still suffix.
    const d = tmpDir('avail-file');
    fs.writeFileSync(path.join(d, 'B'), 'whatever');
    assert.equal(_availableShotName(d, 'B'), 'B_2');
});

// ---- _partitionExistingClips (dev16 #2 — skip-and-warn) -------------------

test('_partitionExistingClips: all present', () => {
    const d = tmpDir('part-all');
    const a = path.join(d, 'a.psd'); fs.writeFileSync(a, 'x');
    const b = path.join(d, 'b.png'); fs.writeFileSync(b, 'x');
    const r = _partitionExistingClips([a, b]);
    assert.deepEqual(r.present, [a, b]);
    assert.deepEqual(r.missing, []);
});

test('_partitionExistingClips: mixed — keeps order, splits cleanly', () => {
    const d = tmpDir('part-mix');
    const a = path.join(d, 'a.psd');     fs.writeFileSync(a, 'x');
    const ghost = path.join(d, 'gone.png'); /* not created */
    const c = path.join(d, 'c.mov');     fs.writeFileSync(c, 'x');
    const r = _partitionExistingClips([a, ghost, c]);
    assert.deepEqual(r.present, [a, c]);
    assert.deepEqual(r.missing, [ghost]);
});

test('_partitionExistingClips: all missing', () => {
    const r = _partitionExistingClips(['/no/such/a.psd', '/no/such/b.psd']);
    assert.equal(r.present.length, 0);
    assert.equal(r.missing.length, 2);
});

// ---- proxy queue ordering --------------------------------------------------

test('proxy.enqueue: jobs run in FIFO order, not concurrently', async () => {
    const order = [];
    const p1 = enqueue(async () => {
        await new Promise(r => setTimeout(r, 40));
        order.push(1);
    });
    const p2 = enqueue(async () => {
        order.push(2);
    });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, [1, 2]);
});

test('proxy.enqueue: one job throwing does not break the chain', async () => {
    const order = [];
    const p1 = enqueue(async () => { throw new Error('boom'); }).catch(() => { order.push('err'); });
    const p2 = enqueue(async () => { order.push(2); });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['err', 2]);
});

test('proxy.enqueue: queueDepth tracks pending + running jobs', async () => {
    // Prime with a slow job so we can observe depth going up.
    let release;
    const blocker = new Promise(r => { release = r; });
    const p1 = enqueue(() => blocker);
    const p2 = enqueue(async () => {});
    // At this point p1 is running, p2 pending — depth should be 2.
    assert.equal(queueDepth(), 2);
    release();
    await Promise.all([p1, p2]);
    assert.equal(queueDepth(), 0);
});

// ---- ffmpeg arg construction (design lock — see lib/proxy.js §3) -----------

test('buildProxyArgs: locks the documented flags (design lock)', () => {
    const args = buildProxyArgs('in.mov', 'out.mp4');
    // Contract points from Session 4 design doc §3 — changes here should
    // bump CHANGELOG's proxy section so size/quality regressions are auditable.
    assert.ok(args.includes('-i') && args[args.indexOf('-i') + 1] === 'in.mov');
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('yuv420p'));
    assert.ok(args.includes('veryfast'));
    assert.ok(args.includes('-crf') && args[args.indexOf('-crf') + 1] === '28');
    assert.ok(args.includes('-an'));
    assert.ok(args.some(a => a === 'scale=-2:480,fps=24'));
    assert.ok(args.includes('+faststart'));
    assert.equal(args[args.length - 1], 'out.mp4');
});

test('buildThumbArgs: seeks to midpoint with fast -ss', () => {
    const args = buildThumbArgs('in.mov', 'thumb.jpg', 10);
    const ssIdx = args.indexOf('-ss');
    const iIdx  = args.indexOf('-i');
    assert.ok(ssIdx >= 0 && iIdx >= 0 && ssIdx < iIdx, '-ss must come before -i for fast seek');
    assert.equal(args[ssIdx + 1], '5.000');   // 10s / 2
    assert.ok(args.includes('-frames:v') && args[args.indexOf('-frames:v') + 1] === '1');
});
