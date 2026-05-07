// test/asset.test.js — pure-module coverage for the Vault asset schema.
//
// We deliberately do NOT spin up electron here. lib/asset.js is pure; if a
// test needs electron, it belongs somewhere else. The one concession is that
// writeAsset() uses atomicWriteJSON which touches fs — we give it a tmp dir.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
    ASSET_SCHEMA_VERSION,
    newAssetId,
    isValidAssetId,
    validateAsset,
    createAsset,
    readAsset,
    writeAsset,
    appendUsage,
    findAbsolutePathFields,
} = require('../lib/asset');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `chiral-asset-${prefix}-`));
}

// ---- id + validate ---------------------------------------------------------

test('newAssetId returns UUIDv4-shaped string', () => {
    const id = newAssetId();
    assert.equal(typeof id, 'string');
    assert.ok(isValidAssetId(id), `not a v4: ${id}`);
});

test('isValidAssetId rejects non-v4 strings', () => {
    assert.equal(isValidAssetId(''), false);
    assert.equal(isValidAssetId('nope'), false);
    // v1 UUID (third group starts with 1, not 4) — should reject
    assert.equal(isValidAssetId('8f3a9c12-3a4b-1234-8abc-0011223344ff'), false);
    // valid v4
    assert.equal(isValidAssetId('8f3a9c12-3a4b-4abc-89de-0011223344ff'), true);
});

test('validateAsset accepts a minimal valid asset', () => {
    const a = createAsset({
        name: 'hero shot',
        kind: 'shot',
        origin: { projectName: 'P', shotName: 'S001', chiralVersion: '0.5.0' },
        specAtVault: { fps: 23.976, width: 1920, height: 1080 },
    });
    const v = validateAsset(a);
    assert.equal(v.ok, true, v.errors.join(', '));
    assert.deepEqual(v.errors, []);
});

test('validateAsset rejects absolute paths in files block', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.files.master = 'C:\\Users\\nope\\master.mov';
    const v = validateAsset(a);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => e.includes('must be relative')), `got: ${v.errors.join(' | ')}`);
});

test('validateAsset rejects .. in path fields', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.files.master = '../outside/master.mov';
    const v = validateAsset(a);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => e.includes('must not contain ..')));
});

test('validateAsset rejects non-positive dimensions', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 0, height: -1 },
    });
    const v = validateAsset(a);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => e.includes('width')));
    assert.ok(v.errors.some(e => e.includes('height')));
});

test('validateAsset warns (not errors) on future schemaVersion', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.schemaVersion = 999;
    const v = validateAsset(a);
    assert.equal(v.ok, true);                 // shape still valid
    assert.ok(v.warnings.some(w => w.includes('schemaVersion=999')));
});

// ---- createAsset defaults --------------------------------------------------

test('createAsset stamps schemaVersion and vaultedAt', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    assert.equal(a.schemaVersion, ASSET_SCHEMA_VERSION);
    assert.ok(a.origin.vaultedAt.match(/^\d{4}-\d{2}-\d{2}T/));
    assert.deepEqual(a.files, {
        master: null, proxy: null, thumbnail: null, aeProject: null, aeRoot: null, clips: null,
    });
    assert.deepEqual(a.usage, []);
});

// ---- dev13 — clip type discriminator + files.clips ------------------------

test('createAsset defaults type to "asset"', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    assert.equal(a.type, 'asset');
});

test('createAsset accepts type:"clip"', () => {
    const a = createAsset({
        name: 'x', kind: 'shot', type: 'clip',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    assert.equal(a.type, 'clip');
});

test('createAsset coerces unknown type to "asset"', () => {
    const a = createAsset({
        name: 'x', kind: 'shot', type: 'banana',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    assert.equal(a.type, 'asset');
});

test('validateAsset accepts a clip-mode asset with files.clips array', () => {
    const a = createAsset({
        name: 'pack', kind: 'shot', type: 'clip',
        origin: { projectName: 'P', shotName: 'S' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.files.clips = ['clips/foo.psd', 'clips/bar.png'];
    const v = validateAsset(a);
    assert.equal(v.ok, true, v.errors.join(';'));
});

test('validateAsset rejects absolute paths inside files.clips', () => {
    const a = createAsset({
        name: 'pack', kind: 'shot', type: 'clip',
        origin: { projectName: 'P', shotName: 'S' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.files.clips = ['C:\\stolen\\foo.psd'];
    const v = validateAsset(a);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /must be relative/.test(e)));
});

test('validateAsset rejects non-array files.clips', () => {
    const a = createAsset({
        name: 'pack', kind: 'shot', type: 'clip',
        origin: { projectName: 'P', shotName: 'S' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.files.clips = 'clips/foo.psd';   // wrong shape
    const v = validateAsset(a);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /must be an array/.test(e)));
});

test('createAsset coerces unknown kind to "shot"', () => {
    const a = createAsset({
        name: 'x', kind: 'banana',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    assert.equal(a.kind, 'shot');
});

// ---- read/write roundtrip --------------------------------------------------

test('writeAsset + readAsset roundtrip', () => {
    const d = tmpDir('rw');
    const a = createAsset({
        name: 'round trip', kind: 'shot',
        origin: { projectName: 'P', shotName: 'S1', chiralVersion: '0.5.0' },
        specAtVault: { fps: 23.976, width: 1920, height: 1080 },
    });
    a.files.master = 'master.mov';
    a.files.proxy  = 'proxy.mp4';
    writeAsset(d, a);
    const b = readAsset(d);
    assert.deepEqual(b, a);
});

test('writeAsset throws on invalid asset', () => {
    const d = tmpDir('invalid');
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.assetId = 'not-a-uuid';
    assert.throws(() => writeAsset(d, a), /validation failed/);
});

test('readAsset returns null for missing dir', () => {
    assert.equal(readAsset(path.join(os.tmpdir(), 'definitely-not-there-' + Date.now())), null);
});

// ---- usage log -------------------------------------------------------------

test('appendUsage is append-only and defaults mode=copy', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    const b = appendUsage(a, { toProject: 'B', toShot: 'S1' });
    assert.equal(b.usage.length, 1);
    assert.equal(b.usage[0].toProject, 'B');
    assert.equal(b.usage[0].mode, 'copy');
    // original untouched
    assert.equal(a.usage.length, 0);

    const c = appendUsage(b, { toProject: 'C', toShot: 'S2', mode: 'link' });
    assert.equal(c.usage.length, 2);
    assert.equal(c.usage[1].mode, 'link');
    // first entry still intact
    assert.equal(c.usage[0].toProject, 'B');
});

test('appendUsage coerces unknown mode to copy', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    const b = appendUsage(a, { toProject: 'B', toShot: 'S1', mode: 'teleport' });
    assert.equal(b.usage[0].mode, 'copy');
});

// ---- findAbsolutePathFields ------------------------------------------------

test('findAbsolutePathFields catches C:\\ paths nested anywhere', () => {
    const obj = {
        name: 'x',
        files: { master: 'ok.mov', proxy: 'C:\\bad\\proxy.mp4' },
        dependencies: {
            footage: [{ relPath: 'ae/(Footage)/plate.mov' }, { relPath: '/etc/absolute' }],
        },
    };
    const hits = findAbsolutePathFields(obj);
    const fields = hits.map(h => h.field);
    assert.ok(fields.includes('files.proxy'),                        fields.join(','));
    assert.ok(fields.includes('dependencies.footage[1].relPath'),    fields.join(','));
    assert.equal(hits.length, 2);
});

test('findAbsolutePathFields returns empty for a clean asset', () => {
    const a = createAsset({
        name: 'x', kind: 'shot',
        origin: { projectName: 'P' },
        specAtVault: { fps: 24, width: 1920, height: 1080 },
    });
    a.files.master = 'master.mov';
    assert.deepEqual(findAbsolutePathFields(a), []);
});
