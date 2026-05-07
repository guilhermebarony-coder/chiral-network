// test/vault.test.js — VaultRoot lifecycle, index rebuild, trash, portability.
//
// Every test gets its own tmp vault dir. No electron. No shared state.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const V = require('../lib/vault');
const { createAsset, writeAsset } = require('../lib/asset');

function tmpVault(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `chiral-vault-${prefix}-`));
}

// Shorthand: writes a valid asset at <vault>/assets/<id>/asset.json with
// optional overrides and returns the asset object.
function seedAsset(vaultRoot, overrides = {}) {
    const a = createAsset({
        name: overrides.name || 'sample',
        kind: 'shot',
        origin: { projectName: overrides.projectName || 'P', shotName: 'S1', chiralVersion: '0.5.0' },
        specAtVault: { fps: 23.976, width: 1920, height: 1080 },
        assetId: overrides.assetId,
    });
    if (overrides.tags) a.tags = overrides.tags;
    a.files.master    = 'master.mov';
    a.files.thumbnail = 'thumb.jpg';
    const dir = V.assetDirOf(vaultRoot, a.assetId);
    fs.mkdirSync(dir, { recursive: true });
    writeAsset(dir, a);
    return a;
}

// ---- init + marker ---------------------------------------------------------

test('initVault creates layout and marker; isVaultRoot flips true', () => {
    const v = tmpVault('init');
    assert.equal(V.isVaultRoot(v), false);
    V.initVault(v, { chiralVersion: '0.5.0' });
    assert.equal(V.isVaultRoot(v), true);
    assert.ok(fs.existsSync(V.assetsDirOf(v)));
    assert.ok(fs.existsSync(V.trashDirOf(v)));
    assert.ok(fs.existsSync(V.locksDirOf(v)));
});

test('initVault is idempotent — second call does not overwrite marker', () => {
    const v = tmpVault('idem');
    V.initVault(v, { chiralVersion: '0.5.0' });
    const first = JSON.parse(fs.readFileSync(V.vaultMarkerPath(v), 'utf8'));
    V.initVault(v, { chiralVersion: '9.9.9' });
    const second = JSON.parse(fs.readFileSync(V.vaultMarkerPath(v), 'utf8'));
    assert.equal(second.createdAt, first.createdAt);       // unchanged
    assert.equal(second.chiralVersion, '0.5.0');           // not clobbered
});

test('isVaultRoot false for random dir', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-vault-'));
    assert.equal(V.isVaultRoot(d), false);
});

// ---- dirSizeBytes (dev37) --------------------------------------------------

test('dirSizeBytes sums every file under a directory tree', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dirsize-basic-'));
    fs.writeFileSync(path.join(d, 'a.txt'), 'hello');                  // 5 bytes
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'sub', 'b.bin'), Buffer.alloc(100)); // 100
    fs.mkdirSync(path.join(d, 'sub', 'deep'));
    fs.writeFileSync(path.join(d, 'sub', 'deep', 'c'), 'xx');          // 2

    assert.equal(V.dirSizeBytes(d), 107);
});

test('dirSizeBytes returns 0 for an empty / missing dir', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dirsize-empty-'));
    assert.equal(V.dirSizeBytes(d), 0);
    assert.equal(V.dirSizeBytes(path.join(d, 'does-not-exist')), 0);
});

test('rebuildIndex stamps sizeBytes onto every projected row', () => {
    const v = tmpVault('size-rebuild');
    V.initVault(v, { chiralVersion: '0.5.0' });
    const a = seedAsset(v, { name: 'with-size' });
    // Drop a master.mov stub of known size into the asset dir so
    // rebuildIndex's dirSizeBytes call has something to total.
    fs.writeFileSync(path.join(V.assetDirOf(v, a.assetId), 'master.mov'),
                     Buffer.alloc(2048));
    V.rebuildIndex(v);
    const idx = V.readIndex(v);
    assert.equal(idx.assets.length, 1);
    assert.equal(typeof idx.assets[0].sizeBytes, 'number');
    assert.ok(idx.assets[0].sizeBytes >= 2048,
              'sizeBytes covers at least the master stub we wrote');
});

// ---- index rebuild ---------------------------------------------------------

test('rebuildIndex walks assets/ and produces projections', () => {
    const v = tmpVault('idx');
    V.initVault(v);
    const a1 = seedAsset(v, { name: 'one',   tags: ['hero'] });
    const a2 = seedAsset(v, { name: 'two',   tags: ['transition', 'q1'] });
    const res = V.rebuildIndex(v);
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.deepEqual(res.skipped, []);
    const idx = V.readIndex(v);
    assert.equal(idx.assets.length, 2);
    const names = idx.assets.map(a => a.name).sort();
    assert.deepEqual(names, ['one', 'two']);
    const one = idx.assets.find(a => a.name === 'one');
    assert.deepEqual(one.tags, ['hero']);
    assert.equal(one.assetId, a1.assetId);
    assert.equal(one.thumbnailRel, 'thumb.jpg');
    assert.equal(one.originProject, 'P');
    assert.equal(one.usageCount, 0);
    // Hush unused-warning
    void a2;
});

test('rebuildIndex skips dirs whose name does not match assetId', () => {
    const v = tmpVault('idx-mismatch');
    V.initVault(v);
    const a = seedAsset(v);
    // Rename the folder — simulates manual tampering.
    const wrongDir = path.join(V.assetsDirOf(v), 'not-a-uuid-folder');
    fs.renameSync(V.assetDirOf(v, a.assetId), wrongDir);
    const res = V.rebuildIndex(v);
    assert.equal(res.count, 0);
    assert.equal(res.skipped.length, 1);
    assert.ok(res.skipped[0].reason.includes('folder name'));
});

test('rebuildIndex skips dirs with no asset.json', () => {
    const v = tmpVault('idx-empty');
    V.initVault(v);
    fs.mkdirSync(path.join(V.assetsDirOf(v), 'ghost'));
    const res = V.rebuildIndex(v);
    assert.equal(res.count, 0);
    assert.equal(res.skipped.length, 1);
});

test('rebuildIndex is safe on an empty vault', () => {
    const v = tmpVault('idx-zero');
    V.initVault(v);
    const res = V.rebuildIndex(v);
    assert.equal(res.count, 0);
    assert.deepEqual(res.skipped, []);
});

// ---- soft delete + restore + purge ----------------------------------------

test('trashAsset moves asset dir to .trash/ with timestamp suffix', () => {
    const v = tmpVault('trash');
    V.initVault(v);
    const a = seedAsset(v);
    const res = V.trashAsset(v, a.assetId);
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(V.assetDirOf(v, a.assetId)), false);
    assert.ok(fs.existsSync(res.trashPath));
    // Trash dir name starts with the assetId.
    assert.ok(path.basename(res.trashPath).startsWith(a.assetId));
});

test('trashAsset returns ok:false for unknown id', () => {
    const v = tmpVault('trash-miss');
    V.initVault(v);
    const res = V.trashAsset(v, '00000000-0000-4000-8000-000000000000');
    assert.equal(res.ok, false);
});

test('restoreAsset moves it back; listTrash enumerates entries', () => {
    const v = tmpVault('restore');
    V.initVault(v);
    const a = seedAsset(v);
    const t = V.trashAsset(v, a.assetId);
    const listing = V.listTrash(v);
    assert.equal(listing.length, 1);
    assert.equal(listing[0].assetId, a.assetId);
    const r = V.restoreAsset(v, path.basename(t.trashPath));
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(V.assetDirOf(v, a.assetId)));
    assert.equal(V.listTrash(v).length, 0);
});

test('restoreAsset refuses if a live asset with same id exists', () => {
    const v = tmpVault('restore-conflict');
    V.initVault(v);
    const a = seedAsset(v);
    const t = V.trashAsset(v, a.assetId);
    // Create a fresh asset with the SAME id (simulates re-vault after delete).
    seedAsset(v, { assetId: a.assetId, name: 'new-one' });
    const r = V.restoreAsset(v, path.basename(t.trashPath));
    assert.equal(r.ok, false);
    assert.match(r.error, /already exists/);
});

test('purgeOldTrash removes entries older than retention', () => {
    const v = tmpVault('purge');
    V.initVault(v);
    const a = seedAsset(v);
    const t = V.trashAsset(v, a.assetId);
    // Backdate the trash dir's mtime by 10 days — older than default 7d.
    const old = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(t.trashPath, old, old);
    const removed = V.purgeOldTrash(v);
    assert.equal(removed.length, 1);
    assert.equal(V.listTrash(v).length, 0);
});

test('purgeOldTrash leaves fresh entries alone', () => {
    const v = tmpVault('purge-fresh');
    V.initVault(v);
    const a = seedAsset(v);
    V.trashAsset(v, a.assetId);
    const removed = V.purgeOldTrash(v);
    assert.equal(removed.length, 0);
    assert.equal(V.listTrash(v).length, 1);
});

// ---- portability audit -----------------------------------------------------

test('verifyPortability passes on a clean vault', () => {
    const v = tmpVault('port-clean');
    V.initVault(v);
    seedAsset(v);
    seedAsset(v);
    const r = V.verifyPortability(v);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.offenders, []);
});

test('verifyPortability flags assets with absolute paths', () => {
    const v = tmpVault('port-dirty');
    V.initVault(v);
    const a = seedAsset(v);
    // Hand-poke an absolute path into the manifest (bypass writeAsset's
    // validation — simulates a manual edit or a bug in a future handler).
    const { manifestPathFor } = require('../lib/asset');
    const raw = JSON.parse(fs.readFileSync(manifestPathFor(V.assetDirOf(v, a.assetId)), 'utf8'));
    raw.files.master = 'D:\\bad\\master.mov';
    fs.writeFileSync(manifestPathFor(V.assetDirOf(v, a.assetId)), JSON.stringify(raw));
    const r = V.verifyPortability(v);
    assert.equal(r.ok, false);
    assert.equal(r.offenders.length, 1);
    assert.equal(r.offenders[0].assetId, a.assetId);
});
