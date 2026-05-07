// lib/memoize.js — tiny mtime-gated memoization for filesystem-derived reads.
//
// Purpose: the v0.4.9 vertical rail tick (3s) and the jump palette summary
// each walk every shot in every project, calling readJob() + computeSanity()
// per shot. On a moderately-sized tree (10 projects × 20 shots) that's 200
// JSON.parse calls every 3 seconds even when nothing has changed on disk.
//
// The fix is surgical: wrap the pure function `fn` so repeated calls with the
// same arguments skip the work whenever the backing file's mtime is unchanged.
// A single fs.statSync is O(1) syscall and dramatically cheaper than read +
// parse, so the cache pays for itself even on the cold path.
//
// Correctness contract:
//   * `getStatPath(...args)` MUST return the file whose mtime captures every
//     input that can invalidate the result. If the wrapped fn also depends on
//     other files, either expand getStatPath to return the freshest of them or
//     don't memoize.
//   * The wrapped fn MUST be pure w.r.t. that file — same file, same result.
//   * Returned values should be treated as shared-read-only; do NOT mutate.
//     Callers that mutate the output will poison the next cache hit.
//   * Atomic writes (tmp+fsync+rename) always bump mtime, so withJob/
//     atomicWriteJSON paths invalidate cleanly.
//
// Deliberately NOT an LRU — the working set is bounded by "shots on disk",
// which is tiny. A Map with no eviction is the right call until proven wrong.

const fs = require('fs');

function memoizeByMtime(fn, getStatPath) {
    const cache = new Map();   // statPath -> { mtime, value }

    function wrapped(...args) {
        const statPath = getStatPath(...args);
        let mtime = -1;
        try { mtime = fs.statSync(statPath).mtimeMs; } catch (_) { /* missing = -1 */ }
        const hit = cache.get(statPath);
        if (hit && hit.mtime === mtime) return hit.value;
        const value = fn(...args);
        cache.set(statPath, { mtime, value });
        return value;
    }
    wrapped.clear = () => cache.clear();
    wrapped._cache = cache;   // exposed for tests; do not use in app code
    return wrapped;
}

module.exports = { memoizeByMtime };
