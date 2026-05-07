// lib/proxy.js — FFmpeg proxy + thumbnail generation for the Vault.
//
// Command shapes are locked by the Session 4 design doc §3:
//   proxy.mp4  — H.264 yuv420p, 480p cap, CRF 28, keyframe every 1s, no audio,
//                faststart, 24fps. Target ~1-3 MB per 10s source.
//   thumb.jpg  — single frame at 50% duration, 640px wide, q:v 3.
//
// Concurrency: a single-slot queue. Vaulting 5 shots in a row shouldn't
// saturate the CPU while the user is editing in AE/Resolve. Caller enqueues
// `generateProxy()` / `generateThumbnail()`; both resolve when their specific
// job completes (NOT when the queue drains).
//
// State-free at module level except for the queue head — and that's process-
// local, acceptable. Tests can `enqueue(() => Promise.resolve())` to exercise
// the queue without spawning ffmpeg.

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---- Single-slot FIFO queue ------------------------------------------------
// Simple Promise chain: each enqueue appends a .then(), so jobs run strictly
// in order with max concurrency = 1. Errors in one job don't poison later
// jobs — we catch+wrap so the chain keeps flowing.
let _queueTail = Promise.resolve();
let _queueDepth = 0;

function queueDepth() { return _queueDepth; }

function enqueue(jobFn) {
    _queueDepth++;
    const run = _queueTail.then(
        async () => {
            try { return await jobFn(); }
            finally { _queueDepth--; }
        },
        async () => {
            // Previous job failed — don't cascade. Still run this one.
            try { return await jobFn(); }
            finally { _queueDepth--; }
        }
    );
    _queueTail = run.catch(() => {});  // isolate tail from individual failures
    return run;
}

// ---- ffmpeg invocation -----------------------------------------------------

// Resolve which ffmpeg to invoke. Priority matches lib/spawn.js: env override
// → bundled vendor → system PATH. Returned path is either an absolute file
// (verified to exist) or the literal 'ffmpeg' (PATH fallback, unverified).
function resolveFFmpeg(ctx) {
    if (ctx && ctx.FFMPEG_EXE && fs.existsSync(ctx.FFMPEG_EXE)) {
        return { path: ctx.FFMPEG_EXE, verified: true, source: 'ctx' };
    }
    if (process.env.FFMPEG_EXE && fs.existsSync(process.env.FFMPEG_EXE)) {
        return { path: process.env.FFMPEG_EXE, verified: true, source: 'env' };
    }
    return { path: 'ffmpeg', verified: false, source: 'path' };
}

// Run ffmpeg to completion. Returns { ok, code, logPath }. stderr is appended
// to logPath — ffmpeg writes everything to stderr (even normal progress), so
// having the log is indispensable for debugging encode failures.
function runFFmpeg(ffmpegExe, args, logPath) {
    return new Promise((resolve) => {
        let logFd = null;
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            logFd = fs.openSync(logPath, 'a');
            // Header for readability when multiple invocations append.
            fs.writeSync(logFd, `\n---- ffmpeg ${new Date().toISOString()} ----\n`
                              + `CMD: ${ffmpegExe} ${args.join(' ')}\n`);
        } catch (_) { logFd = null; }

        const child = spawn(ffmpegExe, args, {
            stdio: ['ignore', 'ignore', logFd != null ? logFd : 'ignore'],
            windowsHide: true,
            shell: false,
        });
        child.on('error', (err) => {
            // spawn-time failure (binary missing). Append to log if we can.
            try {
                if (logFd != null) fs.writeSync(logFd, `SPAWN ERROR: ${err.message}\n`);
            } catch (_) {}
            try { if (logFd != null) fs.closeSync(logFd); } catch (_) {}
            resolve({ ok: false, code: -1, logPath, spawnError: err.message });
        });
        child.on('close', (code) => {
            try { if (logFd != null) fs.closeSync(logFd); } catch (_) {}
            resolve({ ok: code === 0, code, logPath });
        });
    });
}

// ---- proxy.mp4 -------------------------------------------------------------
//
// inputPath → outputPath (typically <assetDir>/master.<ext> → <assetDir>/proxy.mp4).
// The command below is the DESIGN LOCK from Session 4 §3 — any change here
// should also update the CHANGELOG's proxy section so future-you can reason
// about file size / hover-play snappiness regressions.

function buildProxyArgs(inputPath, outputPath) {
    return [
        '-y',
        '-i', inputPath,
        // -2 width forces even dimension (H.264 requirement) while preserving AR.
        // fps=24 normalizes scrub granularity across 24/30/48/60 sources.
        '-vf', 'scale=-2:480,fps=24',
        '-c:v', 'libx264',
        '-profile:v', 'main', '-level', '4.0',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', '28',
        // Keyframe every 1s (at 24fps) — instant seek on hover scrub.
        '-g', '24', '-keyint_min', '24',
        '-movflags', '+faststart',
        '-an',
        outputPath,
    ];
}

async function generateProxy({ inputPath, outputPath, logPath, ffmpegExe }) {
    if (!fs.existsSync(inputPath)) {
        return { ok: false, error: 'input not found: ' + inputPath };
    }
    const exe = ffmpegExe || resolveFFmpeg().path;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const res = await runFFmpeg(exe, buildProxyArgs(inputPath, outputPath), logPath);
    if (!res.ok) {
        return { ok: false, error: `ffmpeg exit ${res.code}`, logPath: res.logPath, spawnError: res.spawnError };
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        return { ok: false, error: 'ffmpeg exited 0 but output is empty', logPath: res.logPath };
    }
    return { ok: true, outputPath, bytes: fs.statSync(outputPath).size, logPath: res.logPath };
}

// ---- thumb.jpg -------------------------------------------------------------
// Single frame at ~50% of the source duration, 640px wide, q:v 3 (≈85% JPEG).
// durationSec is passed in from the AE-side compSettings so we don't need to
// ffprobe — saves a spawn per vault.

function buildThumbArgs(inputPath, outputPath, durationSec) {
    const mid = Math.max(0, (durationSec || 1) / 2);
    return [
        '-y',
        // -ss BEFORE -i = fast seek (input-accurate enough for a thumbnail).
        '-ss', mid.toFixed(3),
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=640:-2',
        '-q:v', '3',
        outputPath,
    ];
}

async function generateThumbnail({ inputPath, outputPath, logPath, ffmpegExe, durationSec }) {
    if (!fs.existsSync(inputPath)) {
        return { ok: false, error: 'input not found: ' + inputPath };
    }
    const exe = ffmpegExe || resolveFFmpeg().path;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const res = await runFFmpeg(exe, buildThumbArgs(inputPath, outputPath, durationSec), logPath);
    if (!res.ok) return { ok: false, error: `ffmpeg exit ${res.code}`, logPath: res.logPath };
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        return { ok: false, error: 'ffmpeg exited 0 but output is empty', logPath: res.logPath };
    }
    return { ok: true, outputPath, bytes: fs.statSync(outputPath).size, logPath: res.logPath };
}

module.exports = {
    enqueue,
    queueDepth,
    resolveFFmpeg,
    buildProxyArgs,
    buildThumbArgs,
    runFFmpeg,
    generateProxy,
    generateThumbnail,
};
