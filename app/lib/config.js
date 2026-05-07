// config.js — persistent user config for the Setup Wizard.
//
// Stored at app.getPath('userData')/config.json so it survives app updates
// and lives outside the asar bundle. This is intentionally separate from
// app/settings.json (which holds session-scoped state like currentProject).
//
// Schema is flat — just the four user-configurable paths plus two booleans.
// Kept deliberately small; every added field is one more surface for the
// wizard to manage.

const { app } = require('electron');
const fs   = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./job');

const CONFIG_SCHEMA_VERSION = 1;

// Resolve lazily — app.getPath('userData') throws if called before app is ready.
function configPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

function defaultConfig() {
    return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        setupComplete: false,
        afterEffectsPath: null,
        ffmpegPath: null,
        roundtripRoot: null,
        resolveScriptsInstalled: false,
        // v0.5.0 — Vault MVP. Intentionally null by default: the wizard forces
        // an explicit pick (Session 4 design question #7 — no C:\ default trap).
        // When null, the Vault UI shows a "Pick a vault folder" empty state
        // instead of silently scribbling into %USERPROFILE%.
        vaultRoot: null,
        createdAt: new Date().toISOString(),
    };
}

function readConfig() {
    try {
        const raw = fs.readFileSync(configPath(), 'utf8');
        const parsed = JSON.parse(raw);
        // Be forgiving: missing fields get defaults, extra fields are preserved.
        return Object.assign(defaultConfig(), parsed);
    } catch (_) {
        return null;
    }
}

function writeConfig(cfg) {
    const p = configPath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // Atomic write (tmp+fsync+rename) — prevents a half-written config.json
        // if the app is killed mid-write. Matches the pattern used everywhere
        // else in the app (job.json, project.json, settings.json).
        atomicWriteJSON(p, cfg);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Shallow merge — pass only the fields you want to change. Returns the full
// merged config (useful for echoing back to the renderer).
function updateConfig(patch) {
    const current = readConfig() || defaultConfig();
    const next = Object.assign({}, current, patch || {});
    writeConfig(next);
    return next;
}

module.exports = {
    CONFIG_SCHEMA_VERSION,
    configPath,
    defaultConfig,
    readConfig,
    writeConfig,
    updateConfig,
};
