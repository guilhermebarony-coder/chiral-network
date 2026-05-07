// lib/watch.js — debounced fs.watch helper, dev43.
//
// Why a tiny wrapper instead of using fs.watch directly?
//
//   1. fs.watch on Windows fires multiple events for one logical change
//      (write → rename → truncate). Coalescing is a must, otherwise the
//      renderer would see N refreshes per actual mutation.
//   2. fs.watch{ recursive: true } isn't supported on Linux (we're
//      Windows-first, so this isn't a blocker — but the wrapper keeps
//      the call site portable).
//   3. Callers don't care WHICH file changed, only that "something
//      changed in this tree." The contract is intentionally narrow:
//      one debounced callback per quiet-period.
//
// Usage:
//
//   const w = createWatcher(rootDir, { debounceMs: 250 }, () => {
//       webContents.send('projects:changed');
//   });
//   w.close();   // when done
//
// Failure modes:
//
//   * rootDir doesn't exist or isn't readable → returns a no-op handle
//     so callers don't have to null-check; the watcher silently doesn't
//     fire. The caller's debounced callback never runs.
//   * fs.watch throws on the underlying call (rare; SMB shares, network
//     drives, permission edges) → we swallow and return the no-op
//     handle. The 30s safety tick in the renderer is the backstop.
//   * Watcher is unrecoverable mid-session (e.g. the watched dir is
//     deleted) — fs.watch emits an 'error' event; we log and close
//     ourselves. Renderer falls back to safety tick until the next
//     applyConfig() rebuilds watchers.

const fs = require('fs');

const NOOP_HANDLE = { close: () => {} };

function createWatcher(rootDir, opts, onChange) {
    const debounceMs = (opts && opts.debounceMs) || 250;
    if (!rootDir) return NOOP_HANDLE;
    let exists = false;
    try { exists = fs.statSync(rootDir).isDirectory(); } catch (_) {}
    if (!exists) return NOOP_HANDLE;

    let timer = null;
    let watcher = null;

    const fire = () => {
        timer = null;
        try { onChange(); } catch (e) { console.warn('[watch] onChange threw:', e.message); }
    };
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, debounceMs);
    };

    try {
        watcher = fs.watch(rootDir, { recursive: true, persistent: false }, schedule);
        watcher.on('error', (e) => {
            console.warn('[watch] %s error:', rootDir, e.message);
            try { watcher.close(); } catch (_) {}
            watcher = null;
        });
    } catch (e) {
        console.warn('[watch] could not watch %s:', rootDir, e.message);
        return NOOP_HANDLE;
    }

    return {
        close() {
            if (timer) { clearTimeout(timer); timer = null; }
            if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
        },
    };
}

module.exports = { createWatcher };
