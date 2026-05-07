// test/vault_folders.test.js — Virtual-folder metadata module (dev24).
//
// Pure read/write unit tests against tmp dirs. Asserts the schema, the
// CRUD round-trip, and the corner cases that matter for the UI layer:
//   * missing folders.json returns empty defaults (no exception)
//   * duplicate folder names are rejected (case-insensitive)
//   * deleting a folder orphans assignments rather than nuking them
//   * assignAsset(null) un-files an asset
//   * removeAssignment is idempotent

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const VF = require('../lib/vault_folders');

function tmpVault(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `chiral-folders-${tag}-`));
}

// ---- shape primitives ------------------------------------------------------

test('newFolderId / isValidFolderId', () => {
    const id = VF.newFolderId();
    assert.match(id, /^fld_[0-9a-f]{8}$/);
    assert.equal(VF.isValidFolderId(id), true);
    assert.equal(VF.isValidFolderId('not-a-folder'), false);
    assert.equal(VF.isValidFolderId(''), false);
    assert.equal(VF.isValidFolderId(null), false);
});

// ---- read on empty / fresh vault -------------------------------------------

test('readFolders: missing file returns empty defaults', () => {
    const v = tmpVault('empty');
    const r = VF.readFolders(v);
    assert.equal(r.schemaVersion, VF.FOLDERS_SCHEMA_VERSION);
    assert.deepEqual(r.folders, []);
    assert.deepEqual(r.assignments, {});
});

test('readFolders: corrupt JSON falls back to empty defaults (no throw)', () => {
    const v = tmpVault('corrupt');
    fs.writeFileSync(VF.foldersPath(v), '{not json');
    const r = VF.readFolders(v);
    assert.deepEqual(r.folders, []);
});

// ---- create ---------------------------------------------------------------

test('createFolder: happy path returns id + persists', () => {
    const v = tmpVault('create');
    const r = VF.createFolder(v, 'Lower thirds');
    assert.equal(r.ok, true);
    assert.match(r.id, /^fld_/);
    const stored = VF.readFolders(v);
    assert.equal(stored.folders.length, 1);
    assert.equal(stored.folders[0].name, 'Lower thirds');
    assert.equal(stored.folders[0].id, r.id);
    assert.match(stored.folders[0].createdAt, /^\d{4}-/);
});

test('createFolder: rejects empty name', () => {
    const v = tmpVault('create-empty');
    const r1 = VF.createFolder(v, '');
    const r2 = VF.createFolder(v, '   ');
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
});

test('createFolder: rejects duplicate name (case-insensitive)', () => {
    const v = tmpVault('create-dup');
    VF.createFolder(v, 'Sound FX');
    const r = VF.createFolder(v, 'sound fx');
    assert.equal(r.ok, false);
    assert.match(r.error, /already exists/);
});

test('createFolder: enforces 80-char name limit', () => {
    const v = tmpVault('create-long');
    const r = VF.createFolder(v, 'x'.repeat(81));
    assert.equal(r.ok, false);
    assert.match(r.error, /too long/);
});

// ---- rename ---------------------------------------------------------------

test('renameFolder: round-trip', () => {
    const v = tmpVault('rename');
    const c = VF.createFolder(v, 'Old name');
    const r = VF.renameFolder(v, c.id, 'New name');
    assert.equal(r.ok, true);
    const stored = VF.readFolders(v);
    assert.equal(stored.folders[0].name, 'New name');
});

test('renameFolder: rejects collision with another folder', () => {
    const v = tmpVault('rename-coll');
    const a = VF.createFolder(v, 'Alpha');
    VF.createFolder(v, 'Beta');
    const r = VF.renameFolder(v, a.id, 'beta');
    assert.equal(r.ok, false);
});

test('renameFolder: bad id surfaces a clear error', () => {
    const v = tmpVault('rename-noid');
    const r = VF.renameFolder(v, 'fld_00000000', 'whatever');
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
});

// ---- delete ---------------------------------------------------------------

test('deleteFolder: removes folder AND clears affected assignments', () => {
    const v = tmpVault('delete');
    const f = VF.createFolder(v, 'Doomed');
    VF.assignAsset(v, 'asset-1', f.id);
    VF.assignAsset(v, 'asset-2', f.id);
    VF.assignAsset(v, 'asset-3', null);     // unrelated, should be unaffected (no-op)
    const r = VF.deleteFolder(v, f.id);
    assert.equal(r.ok, true);
    assert.equal(r.cleared, 2);
    const stored = VF.readFolders(v);
    assert.equal(stored.folders.length, 0);
    // Both assignments to the deleted folder should be gone.
    assert.equal(stored.assignments['asset-1'], undefined);
    assert.equal(stored.assignments['asset-2'], undefined);
});

// ---- assignAsset ----------------------------------------------------------

test('assignAsset: assign + reassign + unfile', () => {
    const v = tmpVault('assign');
    const a = VF.createFolder(v, 'A');
    const b = VF.createFolder(v, 'B');

    VF.assignAsset(v, 'asset-1', a.id);
    assert.equal(VF.readFolders(v).assignments['asset-1'], a.id);

    VF.assignAsset(v, 'asset-1', b.id);
    assert.equal(VF.readFolders(v).assignments['asset-1'], b.id);

    VF.assignAsset(v, 'asset-1', null);
    assert.equal(VF.readFolders(v).assignments['asset-1'], undefined);
});

test('assignAsset: rejects unknown folderId', () => {
    const v = tmpVault('assign-bad');
    const r = VF.assignAsset(v, 'asset-1', 'fld_deadbeef');
    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
});

test('assignAsset: rejects malformed folderId', () => {
    const v = tmpVault('assign-malformed');
    const r = VF.assignAsset(v, 'asset-1', 'just-some-string');
    assert.equal(r.ok, false);
    assert.match(r.error, /bad folderId/);
});

// ---- removeAssignment -----------------------------------------------------

test('removeAssignment: idempotent', () => {
    const v = tmpVault('remove-assign');
    const f = VF.createFolder(v, 'F');
    VF.assignAsset(v, 'asset-1', f.id);
    let r = VF.removeAssignment(v, 'asset-1');
    assert.equal(r.cleared, true);
    r = VF.removeAssignment(v, 'asset-1');
    assert.equal(r.cleared, false);   // already gone — no-op
});
