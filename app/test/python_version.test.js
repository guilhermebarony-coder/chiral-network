// python_version.test.js — v0.4.9-rc4 Python version gate coverage.
//
// Pure-function tests on the version parser and range check. We don't
// exercise detectPython() itself (it shells out to the real system Python)
// because that would couple the test suite to whatever's on PATH. The
// interesting logic is in the parser + predicate, and both are pure.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
    parsePythonVersionString,
    isPythonInSupportedRange,
    SUPPORTED_PYTHON,
    pickVendoredPythonDir,
    clearVendoredPythonCache,
} = require('../lib/detect');

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

test('parsePythonVersionString: typical --version outputs', () => {
    assert.deepEqual(
        parsePythonVersionString('Python 3.12.0\n'),
        { major: 3, minor: 12, patch: 0, full: '3.12.0' });
    assert.deepEqual(
        parsePythonVersionString('Python 3.14.0rc1'),
        { major: 3, minor: 14, patch: 0, full: '3.14.0' });
    assert.deepEqual(
        parsePythonVersionString('Python 3.10.11'),
        { major: 3, minor: 10, patch: 11, full: '3.10.11' });
});

test('parsePythonVersionString: garbage / empty / null', () => {
    assert.equal(parsePythonVersionString(''), null);
    assert.equal(parsePythonVersionString(null), null);
    assert.equal(parsePythonVersionString(undefined), null);
    assert.equal(parsePythonVersionString('no python here'), null);
    assert.equal(parsePythonVersionString('Python'), null);  // no numbers
});

test('isPythonInSupportedRange: boundaries', () => {
    // Documented range: 3.10 – 3.13 inclusive.
    assert.equal(SUPPORTED_PYTHON.minMinor, 10);
    assert.equal(SUPPORTED_PYTHON.maxMinor, 13);

    // In range
    assert.equal(isPythonInSupportedRange({ major: 3, minor: 10, patch: 0 }), true);
    assert.equal(isPythonInSupportedRange({ major: 3, minor: 11, patch: 9 }), true);
    assert.equal(isPythonInSupportedRange({ major: 3, minor: 12, patch: 0 }), true);
    assert.equal(isPythonInSupportedRange({ major: 3, minor: 13, patch: 99 }), true);

    // Below
    assert.equal(isPythonInSupportedRange({ major: 3, minor: 9,  patch: 19 }), false);
    assert.equal(isPythonInSupportedRange({ major: 2, minor: 7,  patch: 0  }), false);

    // Above — the tester's bug
    assert.equal(isPythonInSupportedRange({ major: 3, minor: 14, patch: 0 }), false);
    assert.equal(isPythonInSupportedRange({ major: 4, minor: 0,  patch: 0 }), false);

    // Null / undefined
    assert.equal(isPythonInSupportedRange(null), false);
    assert.equal(isPythonInSupportedRange(undefined), false);
});

test('parse + range: realistic end-to-end flow', () => {
    const ok  = parsePythonVersionString('Python 3.12.4');
    const bad = parsePythonVersionString('Python 3.14.0');
    assert.equal(isPythonInSupportedRange(ok),  true);
    assert.equal(isPythonInSupportedRange(bad), false);
});

// dev60 — vendored-Python picker.
//
// We can't ship a real fusionscript.dll fixture (Blackmagic license, plus
// it's huge), but the picker's signal is purely "does this binary buffer
// contain the literal string `python310.dll` / `python3XX.dll` / nothing".
// So the test fixtures are synthetic .dll-named files containing the
// relevant string at a deterministic offset. The heuristic doesn't care
// about valid PE structure; it scans the head as latin-1.
function _makeFakeDll(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiral-vendor-pick-'));
    const dll = path.join(dir, 'fusionscript.dll');
    fs.writeFileSync(dll, contents);
    return { dir, dll };
}
function _cleanup(t) {
    try { fs.rmSync(t.dir, { recursive: true, force: true }); } catch (_) {}
}

test('pickVendoredPythonDir: python310.dll literal -> python310', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDll('MZ...lots of bytes...python310.dll...rest of binary');
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python310');
    } finally { _cleanup(t); }
});

test('pickVendoredPythonDir: only python3.dll forwarder -> python313', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDll('MZ...stable abi only...python3.dll...rest of binary');
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python313');
    } finally { _cleanup(t); }
});

test('pickVendoredPythonDir: explicit python311+ lock -> python313', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDll('MZ...python311.dll...');
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python313');
    } finally { _cleanup(t); }
    clearVendoredPythonCache();
    const t2 = _makeFakeDll('MZ...python312.dll...');
    try {
        assert.equal(pickVendoredPythonDir(t2.dll), 'python313');
    } finally { _cleanup(t2); }
});

test('pickVendoredPythonDir: missing file / null path -> python313 default', () => {
    clearVendoredPythonCache();
    assert.equal(pickVendoredPythonDir(null),                'python313');
    assert.equal(pickVendoredPythonDir(''),                  'python313');
    assert.equal(pickVendoredPythonDir('Z:/no/such/file.dll'), 'python313');
});

test('pickVendoredPythonDir: result is cached per absolute path', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDll('python310.dll fixture');
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python310');
        // Mutate the file — second call should still return the cached
        // value because we cache by absolute path. Avoids re-reading the
        // ~MB of fusionscript.dll on every relink spawn.
        fs.writeFileSync(t.dll, 'no python lock string at all');
        assert.equal(pickVendoredPythonDir(t.dll), 'python310');
        clearVendoredPythonCache();
        assert.equal(pickVendoredPythonDir(t.dll), 'python313');
    } finally { _cleanup(t); }
});

test('pickVendoredPythonDir: case-insensitive match', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDll('PYTHON310.DLL appears in ALL CAPS in some PE tables');
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python310');
    } finally { _cleanup(t); }
});
