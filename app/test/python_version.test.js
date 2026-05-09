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

// dev63 — VS_FIXEDFILEINFO fallback. When fusionscript imports only the
// stable-ABI forwarder `python3.dll` (no hard pythonXY.dll lock), the
// picker reads fusionscript's own FileVersion and routes Resolve <21 to
// python310 (because Resolve 20 was built against 3.10 ABI without the
// strict Py_LIMITED_API discipline that would make stable-ABI forward-
// compat actually safe). Test fixtures construct a synthetic binary
// containing `python3.dll` and a VS_FIXEDFILEINFO block at a known
// offset.
function _makeFakeDllWithVersion(major, includeStableForwarder) {
    // VS_FIXEDFILEINFO struct, hand-built:
    //   dwSignature       = 0xFEEF04BD  (4 bytes, LE on disk: BD 04 EF FE)
    //   dwStrucVersion    = 0x00010000  (4 bytes, version of the struct)
    //   dwFileVersionMS   = (major << 16) | minor   (4 bytes)
    //   dwFileVersionLS   = 0  (4 bytes)
    //   dwProductVersionMS, LS, dwFileFlagsMask, dwFileFlags,
    //   dwFileOS, dwFileType, dwFileSubtype, dwFileDateMS, LS — we
    //   don't care about anything past dwFileVersionMS for this test.
    const ffi = Buffer.alloc(52);
    ffi.writeUInt32LE(0xFEEF04BD, 0);
    ffi.writeUInt32LE(0x00010000, 4);
    ffi.writeUInt32LE((major << 16) | 0, 8);
    // Pad with a `python3.dll` reference so the import-string heuristic
    // doesn't pick python310 / python311 first. Position the FFI block
    // somewhere past the import strings.
    const head = Buffer.from(
        includeStableForwarder
            ? 'MZ...prelude...python3.dll...filler...'
            : 'MZ...prelude...nothing relevant...');
    const blob = Buffer.concat([head, ffi]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiral-vendor-pick-ver-'));
    const dll = path.join(dir, 'fusionscript.dll');
    fs.writeFileSync(dll, blob);
    return { dir, dll };
}

test('pickVendoredPythonDir: stable forwarder + Resolve 20 -> python310', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDllWithVersion(20, /* stable */ true);
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python310');
    } finally { _cleanup(t); }
});

test('pickVendoredPythonDir: stable forwarder + Resolve 19 -> python310', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDllWithVersion(19, true);
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python310');
    } finally { _cleanup(t); }
});

test('pickVendoredPythonDir: stable forwarder + Resolve 21 -> python313', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDllWithVersion(21, true);
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python313');
    } finally { _cleanup(t); }
});

test('pickVendoredPythonDir: explicit python310 lock beats version scan', () => {
    // Even if the binary somehow has a major=21 VS_FIXEDFILEINFO AND
    // a python310.dll literal (e.g. a Resolve 21 build that retained a
    // legacy linkage), the explicit ABI lock wins. The version-fallback
    // is a last resort, not an override.
    clearVendoredPythonCache();
    const ffi = Buffer.alloc(12);
    ffi.writeUInt32LE(0xFEEF04BD, 0);
    ffi.writeUInt32LE(0x00010000, 4);
    ffi.writeUInt32LE((21 << 16) | 0, 8);
    const blob = Buffer.concat([
        Buffer.from('MZ...python310.dll...AND...python3.dll...'),
        ffi,
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiral-vendor-pick-mixed-'));
    const dll = path.join(dir, 'fusionscript.dll');
    fs.writeFileSync(dll, blob);
    try {
        assert.equal(pickVendoredPythonDir(dll), 'python310');
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('pickVendoredPythonDir: no version info, no python lock -> python313 default', () => {
    clearVendoredPythonCache();
    const t = _makeFakeDll('MZ...completely unrelated binary content...');
    try {
        assert.equal(pickVendoredPythonDir(t.dll), 'python313');
    } finally { _cleanup(t); }
});
