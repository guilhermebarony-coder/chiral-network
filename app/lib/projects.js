// lib/projects.js — pure path utilities for the projects tree.
//
// Every function here takes absolute paths as inputs and has no dependency on
// main.js's mutable state (currentProject / currentShot / PROJECTS_DIR). The
// two functions that DO care about "has anything changed across all projects?"
// (detectNewShotAcrossProjects / scanFastActiveShots) stay in main.js because
// they own the cross-tick state.
//
// `assertInProjects` is the critical safety net: every delete handler must
// route paths through it so a malicious symlink / path-traversal payload in a
// shot or version name can't delete files outside the projects root.

const fs   = require('fs');
const path = require('path');
const { readJob, findMaster } = require('./job');

// ---- Path safety -----------------------------------------------------------
function assertInProjects(projectsDir, target) {
    const abs = path.resolve(target);
    const root = path.resolve(projectsDir) + path.sep;
    if (!abs.startsWith(root)) {
        throw new Error('Refusing path outside projects: ' + abs);
    }
    return abs;
}

// ---- Deletion retry --------------------------------------------------------
// Windows' preview-webm release races the renderer's <video> src teardown;
// without a brief retry the folder ends up partially deleted (file gone, dir
// lingers). 6 * 120ms = 720ms ceiling, in practice always succeeds on 1st try.
function rmDirRetry(target, attempts = 6, waitMs = 120) {
    for (let i = 0; i < attempts; i++) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
        if (!fs.existsSync(target)) return true;
        const end = Date.now() + waitMs;
        while (Date.now() < end) { /* spin */ }
    }
    return !fs.existsSync(target);
}

// ---- Name sanitization -----------------------------------------------------
// Lowercase, replace runs of non-[a-z0-9._-] with _, trim edge underscores,
// cap at 48 chars. Used for project names, shot names, animation name tokens.
function sanitizeName(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
}

// ---- Project enumeration ---------------------------------------------------
function listProjects(projectsDir) {
    if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true });
    return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
}

// ---- Shot enumeration (per project) ---------------------------------------
function listShotsIn(projectAbsDir) {
    if (!projectAbsDir || !fs.existsSync(projectAbsDir)) return [];
    return fs.readdirSync(projectAbsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^Shot_/.test(d.name))
        .map(d => d.name)
        .sort();
}

// Pick the newest shot in a project, preferring job.json mtime when present
// (so a shot whose AE project was saved most recently surfaces as "current")
// and falling back to lexicographic order for shots that never got a job.json.
function newestShotIn(projectAbsDir) {
    const shots = listShotsIn(projectAbsDir);
    if (!shots.length) return null;
    let best = shots[shots.length - 1];
    let bestMtime = 0;
    for (const s of shots) {
        const jp = path.join(projectAbsDir, s, 'source', 'job.json');
        if (fs.existsSync(jp)) {
            const m = fs.statSync(jp).mtimeMs;
            if (m > bestMtime) { bestMtime = m; best = s; }
        }
    }
    return best;
}

// Allocate the next "Shot_NNN" name for a given project. 3-digit padding.
function nextShotInProject(projectAbsDir) {
    let max = 0;
    if (fs.existsSync(projectAbsDir)) {
        for (const d of fs.readdirSync(projectAbsDir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const m = d.name.match(/^Shot_(\d+)$/);
            if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
        }
    }
    return 'Shot_' + String(max + 1).padStart(3, '0');
}

// Allocate the next renders/vNN dir for a shot. Idempotent mkdir on renders/
// and on the new version dir so callers don't need to pre-create anything.
function nextVersionDir(shotDirAbs) {
    const rendersDir = path.join(shotDirAbs, 'renders');
    fs.mkdirSync(rendersDir, { recursive: true });
    const existing = fs.readdirSync(rendersDir)
        .filter(n => /^v\d+$/.test(n))
        .map(n => parseInt(n.slice(1), 10))
        .sort((a, b) => a - b);
    const next = (existing.length ? existing[existing.length - 1] : 0) + 1;
    const name = 'v' + String(next).padStart(2, '0');
    const dir = path.join(rendersDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return { name, dir };
}

// ---- Cross-project snapshot -----------------------------------------------
// { projectName: [shotNames...] }. Used by the cross-project auto-jump
// watcher in main.js — we compare snapshots tick-to-tick to notice brand-new
// shots appearing under any project.
function listShotsAllProjects(projectsDir) {
    const out = {};
    for (const p of listProjects(projectsDir)) {
        out[p] = listShotsIn(path.join(projectsDir, p));
    }
    return out;
}

module.exports = {
    assertInProjects,
    rmDirRetry,
    sanitizeName,
    listProjects,
    listShotsIn,
    newestShotIn,
    nextShotInProject,
    nextVersionDir,
    listShotsAllProjects,
    // re-export for convenience of main.js hot paths
    readJob, findMaster,
};
