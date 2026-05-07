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
} = require('../lib/detect');

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
