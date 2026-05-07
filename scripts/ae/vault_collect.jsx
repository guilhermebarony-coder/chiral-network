// vault_collect.jsx — Vault MVP (Session 4 / 0.5.0-dev2) AE handoff.
//
// Invocation (same pattern as create_comp.jsx and render_version.jsx):
//   Electron writes the vault-job JSON path to:
//     %TEMP%/roundtrip_current_vaultjob.txt
//   then runs:
//     AfterFX.exe -r vault_collect.jsx
//
// vaultjob.json keys (produced by lib/vault_pipeline.js):
//   aepPath      absolute path to the source .aep (forward slashes)
//   targetDir    absolute path to <VaultRoot>/assets/<uuid>/ae  (will be created)
//   compName     preferred comp to set as the "vaulted" comp (matches finalVersion's comp)
//   doneFlag     absolute path where the sentinel JSON must be written on success
//   errorFlag    absolute path where the sentinel JSON is written on failure
//
// What this script does, in order:
//   1. Open the source project read-only-ish (we never save back to the original).
//   2. reduceProject([targetComp]) to drop unused items.
//   3. Save a copy of the project into targetDir (Save As), then manually walk
//      every FootageItem: copy its file into targetDir/(Footage)/ and call
//      item.replace(newFile) to repoint. Re-save when done.
//      (We used to call app.project.collectFiles() here — that function does
//      NOT exist as an ExtendScript API; "Collect Files" is a menu-only
//      command in the AE UI. dev9 replaced it with the manual walk below.)
//   4. Enumerate fonts used by every text layer in every comp (unique set).
//   5. Enumerate effects used by every layer in every comp (unique matchName set).
//   6. Record AE version + build, comp settings at collect time.
//   7. Write doneFlag JSON: {ok:true, aepBasename, footageCount, fonts:[], plugins:[], aeVersion, compSettings}
//   8. On any failure, write errorFlag JSON: {ok:false, error, stack?} and return.
//
// Contract:
//   * NEVER clobbers the user's current project. We app.open() the source,
//     run collect into a fresh target dir, and leave it there. The Electron
//     side is responsible for re-opening whatever project was active before.
//   * EXACTLY ONE of {doneFlag, errorFlag} is created. Electron polls both.
//   * All paths written to JSON are RELATIVE to targetDir's parent (the asset
//     dir) — the portability contract from lib/asset.js.
//
// Grep anchor: VAULT_ASSET_SCHEMA — dependencies shape here must match
// lib/asset.js `createAsset()` dependencies block.

(function () {
    var LOG_PATH = Folder.temp.fsName + "/roundtrip_ae.log";
    var POINTER_PATH = Folder.temp.fsName + "/roundtrip_current_vaultjob.txt";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln(new Date().toString() + "  [vault_collect] " + msg);
            f.close();
        } catch (e) {}
    }

    function readText(p) {
        var f = new File(p);
        if (!f.exists) return null;
        f.open("r"); var s = f.read(); f.close();
        return s;
    }
    function readJSON(p) {
        var s = readText(p);
        if (s === null) throw new Error("File not found: " + p);
        return eval("(" + s + ")");
    }
    function writeJSON(p, obj) {
        // dev18 #3 — atomic write via tmp + rename. The Node side polls
        // existsSync(doneFlag) and JSON.parses immediately. Writing
        // directly to `p` opens a window where the file exists but the
        // OS write buffer hasn't flushed: Node sees a 0-byte or partially
        // written file and JSON.parse throws "malformed done flag".
        //
        // Renaming within the same folder is atomic on NTFS and POSIX,
        // so the poller either sees no flag or the complete flag.
        var f = new File(p);
        var parent = f.parent;
        if (!parent.exists) parent.create();
        var tmp = new File(p + ".tmp");
        tmp.encoding = "UTF-8";
        tmp.open("w");
        tmp.write(jsonStringify(obj));
        tmp.close();
        // File.rename refuses to overwrite on Windows — drop any stale
        // target first. (We already unlink stale sentinels Node-side
        // before dispatch, so this is a belt-and-braces.)
        if (f.exists) { try { f.remove(); } catch (_) {} }
        if (!tmp.rename(f.name)) throw new Error("sentinel rename failed: " + tmp.fsName);
    }

    // Minimal JSON.stringify for ExtendScript (no native JSON in older AE).
    // Modern AE (2018+) has JSON, but vault_collect must survive on CS6-era
    // scripting hosts some studios still run — cheap defensive code.
    function jsonStringify(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number" || t === "boolean") return String(v);
        if (t === "string") {
            return "\"" + v
                .replace(/\\/g, "\\\\")
                .replace(/"/g, "\\\"")
                .replace(/\n/g, "\\n")
                .replace(/\r/g, "\\r")
                .replace(/\t/g, "\\t") + "\"";
        }
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(jsonStringify(v[i]));
            return "[" + parts.join(",") + "]";
        }
        if (t === "object") {
            var out = [];
            for (var k in v) {
                if (!v.hasOwnProperty(k)) continue;
                out.push(jsonStringify(k) + ":" + jsonStringify(v[k]));
            }
            return "{" + out.join(",") + "}";
        }
        return "null";
    }

    // Ensure targetDir and any parents exist before we save the project copy
    // or start copying footage into (Footage)/.
    function ensureFolder(pathStr) {
        var f = new Folder(pathStr);
        if (!f.exists) {
            var created = f.create();
            if (!created) throw new Error("Could not create folder: " + pathStr);
        }
        return f;
    }

    // Walk up the item tree: returns every CompItem in the project.
    function allComps() {
        var out = [];
        for (var i = 1; i <= app.project.items.length; i++) {
            var it = app.project.items[i];
            if (it instanceof CompItem) out.push(it);
        }
        return out;
    }

    // Read comp markers as an array of comment strings. Wraps the awkward
    // 1-indexed numKeys / keyValue iteration of the MarkerValue property.
    // Returns [] for comps without markers or for AE versions where
    // markerProperty doesn't exist (pre-CS6 — we tolerate it silently).
    function compMarkerComments(comp) {
        var out = [];
        try {
            var mp = comp.markerProperty;
            if (!mp) return out;
            for (var k = 1; k <= mp.numKeys; k++) {
                try {
                    var mv = mp.keyValue(k);
                    if (mv && typeof mv.comment === "string") out.push(mv.comment);
                } catch (e) { /* one bad marker shouldn't kill the read */ }
            }
        } catch (e) { /* markerProperty not supported */ }
        return out;
    }

    // Does any comp marker comment contain an exact CHIRAL:VAULT token?
    // Case-insensitive, trim-tolerant. Used to override the longest-comp
    // heuristic when the user wants a specific comp vaulted.
    function hasVaultMarker(comp) {
        var comments = compMarkerComments(comp);
        for (var i = 0; i < comments.length; i++) {
            var c = (comments[i] || "").toUpperCase().replace(/\s+/g, "");
            if (c === "CHIRAL:VAULT" || c.indexOf("CHIRAL:VAULT;") === 0 || c.indexOf("CHIRAL:VAULT,") === 0) return true;
        }
        return false;
    }

    // Extract tag values from CHIRAL:TAG=<value> markers on the given comp.
    // Tolerates whitespace and supports multiple tags per comment separated
    // by semicolons or commas (e.g. "CHIRAL:TAG=hero;CHIRAL:TAG=approved").
    // Tag values are normalized to lowercase, trimmed, and deduped.
    function collectCompMarkerTags(comp) {
        var tags = {};
        var comments = compMarkerComments(comp);
        for (var i = 0; i < comments.length; i++) {
            var raw = comments[i] || "";
            // Split on ; or , so a single marker can carry multiple tags.
            var parts = raw.split(/[;,]/);
            for (var p = 0; p < parts.length; p++) {
                var m = parts[p].match(/^\s*CHIRAL:TAG\s*=\s*([^\s]+)\s*$/i);
                if (m && m[1]) {
                    var t = m[1].toLowerCase();
                    if (t.length > 0 && t.length <= 40) tags[t] = true;
                }
            }
        }
        var out = [];
        for (var k in tags) if (tags.hasOwnProperty(k)) out.push(k);
        return out;
    }

    // Given a preferred comp name, pick the CompItem to set as the "primary"
    // vaulted comp. Pick order:
    //   1. Any comp bearing a CHIRAL:VAULT comp marker (user override).
    //   2. A comp whose name matches preferredName (shotName heuristic).
    //   3. The longest comp — in a real shot this is almost always the master.
    function pickPrimaryComp(preferredName) {
        var comps = allComps();
        if (comps.length === 0) return null;
        // (1) explicit CHIRAL:VAULT override
        for (var m = 0; m < comps.length; m++) {
            if (hasVaultMarker(comps[m])) return comps[m];
        }
        // (2) name match
        if (preferredName) {
            for (var i = 0; i < comps.length; i++) {
                if (comps[i].name === preferredName) return comps[i];
            }
        }
        // (3) longest
        var best = comps[0];
        for (var j = 1; j < comps.length; j++) {
            if (comps[j].duration > best.duration) best = comps[j];
        }
        return best;
    }

    // Enumerate fonts used by every text layer in every comp. Dedup via a
    // plain object keyed by "family|style". Missing font data (null fontLocation
    // on AE side) still emits the family name — that's the signal the import
    // side needs.
    function collectFonts(comps) {
        var seen = {};
        var fonts = [];
        for (var i = 0; i < comps.length; i++) {
            var comp = comps[i];
            for (var j = 1; j <= comp.numLayers; j++) {
                var layer = comp.layer(j);
                if (!(layer instanceof TextLayer)) continue;
                try {
                    var srcText = layer.property("Source Text");
                    if (!srcText) continue;
                    var doc = srcText.value;
                    if (!doc) continue;
                    var family = doc.font || "";
                    var style  = "";
                    // fontFamily / fontStyle are 14.2+; guard with try.
                    try { family = doc.fontFamily || family; } catch (e) {}
                    try { style  = doc.fontStyle  || "";     } catch (e) {}
                    var key = family + "|" + style;
                    if (family && !seen[key]) {
                        seen[key] = true;
                        fonts.push({ family: family, style: style || null });
                    }
                } catch (e) {
                    log("font read failed on layer " + j + " of comp '" + comp.name + "': " + e.toString());
                }
            }
        }
        return fonts;
    }

    // Enumerate every effect applied to every layer in every comp. Built-in
    // AE effects have matchNames starting with "ADBE " — we flag anything
    // else as `builtin:false` so the import side can warn strict.
    function collectPlugins(comps) {
        var seen = {};
        var plugins = [];
        for (var i = 0; i < comps.length; i++) {
            var comp = comps[i];
            for (var j = 1; j <= comp.numLayers; j++) {
                var layer = comp.layer(j);
                var effects;
                try { effects = layer.property("ADBE Effect Parade"); } catch (e) { continue; }
                if (!effects) continue;
                for (var k = 1; k <= effects.numProperties; k++) {
                    var fx;
                    try { fx = effects.property(k); } catch (e) { continue; }
                    if (!fx) continue;
                    var match = "";
                    var disp  = "";
                    try { match = fx.matchName || ""; } catch (e) {}
                    try { disp  = fx.name      || ""; } catch (e) {}
                    if (!match || seen[match]) continue;
                    seen[match] = true;
                    plugins.push({
                        matchName:   match,
                        displayName: disp,
                        builtin:     match.indexOf("ADBE ") === 0,
                    });
                }
            }
        }
        return plugins;
    }

    // Manual footage collector — replaces app.project.collectFiles(), which
    // does NOT exist as an ExtendScript API (it's menu-only: File > Dependencies
    // > Collect Files). For each FootageItem with a file on disk:
    //   * skip SolidSource / PlaceholderSource (no real file)
    //   * skip image sequences for MVP (replaceWithSequence has surprising
    //     behavior across AE versions — log and continue)
    //   * copy file into targetDir/(Footage)/, dedup on filename collision
    //   * item.mainSource.file = newFile to repoint AE at the collected copy
    //     (preserves PSD/AI layer bindings, alpha mode, pulldown, loop count —
    //     item.replace() would drop those, see dev11 notes inside the loop)
    // Returns { collected: [...], skipped: [...] } for logging.
    function collectFootageManually(targetFolder) {
        var footageRoot = new Folder(targetFolder.fsName + "/(Footage)");
        if (!footageRoot.exists) footageRoot.create();

        var collected = [];
        var skipped   = [];
        var usedNames = {};

        // Snapshot the item list first — replace() can mutate the project's
        // item collection order/length in surprising ways across AE versions.
        var items = [];
        for (var i = 1; i <= app.project.items.length; i++) items.push(app.project.items[i]);

        for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (!(it instanceof FootageItem)) continue;
            var src = null;
            try { src = it.mainSource; } catch (e) {}
            // FileSource = real file on disk. SolidSource / PlaceholderSource
            // have no file to collect — just skip silently.
            if (!src || !(src instanceof FileSource)) continue;

            var srcFile = null;
            try { srcFile = it.file; } catch (e) {}
            if (!srcFile || !srcFile.exists) {
                skipped.push({ name: it.name, reason: "missing on disk" });
                log("Skip (missing): " + it.name);
                continue;
            }

            // Sequence heuristic: FileSource with isStill=false that's NOT a
            // known movie container extension. Movies are not still but live
            // in one file; sequences span many frame files.
            var ext = srcFile.name.replace(/^.*\./, "").toLowerCase();
            var isMovieExt = /^(mov|mp4|mxf|avi|mkv|webm|mpg|mpeg|m4v|wmv|braw|r3d)$/.test(ext);
            // dev12: layered containers (PSD/PSB/AI/EPS imported as Composition)
            // cannot have their path updated via ExtendScript without losing
            // the per-layer binding — AE re-interprets the file as flat
            // footage and every layer becomes the full composite. We still
            // copy the file into (Footage)/ for portability, but we leave
            // the AE reference at its original absolute path. If the vault
            // is later moved cross-machine the user relinks via AE's UI
            // (File > Replace Footage), which preserves layer binding.
            var isLayeredContainer = /^(psd|psb|ai|eps)$/.test(ext);
            var isStill    = true;
            try { isStill = !!src.isStill; } catch (e) {}
            if (!isStill && !isMovieExt) {
                skipped.push({ name: it.name, reason: "image sequence (MVP skips)" });
                log("Skip (sequence): " + it.name + " — " + srcFile.fsName);
                continue;
            }

            // Dedup on filename — two different source paths can share a
            // basename ("plate.mov" from two shoots). Suffix with _N before
            // the extension to keep AE's import-format detection happy.
            var baseName = srcFile.name;
            var destName = baseName;
            var n = 1;
            while (usedNames[destName.toLowerCase()]) {
                var dot = baseName.lastIndexOf(".");
                if (dot > 0) destName = baseName.substring(0, dot) + "_" + n + baseName.substring(dot);
                else         destName = baseName + "_" + n;
                n++;
            }
            usedNames[destName.toLowerCase()] = true;

            var destFile = new File(footageRoot.fsName + "/" + destName);
            var copied = false;
            try { copied = srcFile.copy(destFile.fsName); } catch (e) {
                log("copy threw: " + e.toString());
            }
            if (!copied || !destFile.exists) {
                skipped.push({ name: it.name, reason: "copy failed" });
                log("Copy FAILED: " + srcFile.fsName + " -> " + destFile.fsName);
                continue;
            }

            // dev12: for layered containers, copy but skip the repoint.
            // Neither item.replace() nor mainSource.file= preserve the
            // per-layer binding across a path change — verified by user
            // testing on dev11. We copy the file so the vault is still
            // self-contained, but leave the AE reference alone.
            if (isLayeredContainer) {
                collected.push({ name: it.name, dst: destFile.fsName, repointed: false, reason: "layered container — path preserved" });
                log("Collected (no repoint, layered): " + it.name + " -> (Footage)/" + destName);
                continue;
            }

            // Repoint strategy — dev11 fix for PSD/AI shape loss:
            //
            // Layered containers (PSD, PSB, AI, EPS) imported as "Composition"
            // create one FootageItem per layer. Each item's mainSource.file
            // points to the container, but the layer binding is stored in
            // project-level metadata, not in the FileSource itself.
            //
            // item.replace(newFile) throws that layer binding away — AE
            // re-imports the file as flat footage and every layer collapses
            // into the full composite ("became a square" in user testing).
            //
            // Setting mainSource.file = newFile only rewrites the path and
            // leaves alpha mode, pulldown, loop count, AND layer binding
            // intact. That's what we want for collect-files — we're moving
            // the same bits to a new location, not swapping the asset.
            //
            // We use mainSource.file= universally because replace() has the
            // same risk for AI alpha settings, interpret-footage choices, etc.
            // Fallback to replace() only if the assignment path throws.
            var repointed = false;
            try {
                it.mainSource.file = destFile;
                repointed = true;
            } catch (eAssign) {
                log("mainSource.file= failed on '" + it.name + "': " + eAssign.toString() + " — falling back to replace()");
                try {
                    it.replace(destFile);
                    repointed = true;
                } catch (eReplace) {
                    skipped.push({ name: it.name, reason: "repoint failed: " + eReplace.toString() });
                    log("Replace FAILED: " + it.name + " — " + eReplace.toString());
                }
            }
            if (repointed) {
                collected.push({ name: it.name, dst: destFile.fsName });
                log("Collected: " + it.name + " -> (Footage)/" + destName);
            }
        }

        return { collected: collected, skipped: skipped };
    }

    // Scan targetDir/(Footage) recursively and count files. Our manual
    // collector writes everything under a "(Footage)" sibling of the .aep;
    // we walk it to produce a count + list for the asset manifest.
    function scanFootage(targetFolder) {
        var footageRoot = new Folder(targetFolder.fsName + "/(Footage)");
        if (!footageRoot.exists) return { count: 0, files: [] };
        var out = [];
        function walk(folder) {
            var items = folder.getFiles();
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it instanceof Folder) { walk(it); }
                else if (it instanceof File) {
                    var sz = 0; try { sz = it.length; } catch (e) {}
                    // relPath is relative to the targetFolder parent (asset dir);
                    // collect files always produces forward-slash-ok paths on
                    // Windows when used this way — normalize defensively.
                    var rel = it.fsName.replace(/\\/g, "/");
                    out.push({ relPath: rel, bytes: sz });
                }
            }
        }
        walk(footageRoot);
        return { count: out.length, files: out };
    }

    // Try to find the .aep file that Collect Files created inside targetDir.
    // Behavior: AE writes a copy of the project (same basename) at the root
    // of the collect target. We look for *.aep at depth 1.
    function findCollectedAep(targetFolder) {
        var items = targetFolder.getFiles("*.aep");
        if (items && items.length > 0) return items[0];
        return null;
    }

    log("==== vault_collect start ====");
    log("AE version: " + app.version);

    var job = null;
    var errorFlag = null;
    var doneFlag  = null;

    try {
        // ---- Resolve job pointer ---------------------------------------------
        var jobPath = null;
        try {
            if ($.arguments && $.arguments.length > 0 && String($.arguments[0]).length > 0) {
                jobPath = String($.arguments[0]);
                log("Got job path from $.arguments: " + jobPath);
            }
        } catch (e) {}
        if (!jobPath) {
            var pointed = readText(POINTER_PATH);
            if (pointed) jobPath = pointed.replace(/^\s+|\s+$/g, "");
            log("Got job path from pointer file: " + jobPath);
        }
        if (!jobPath) throw new Error("No job path available (pointer: " + POINTER_PATH + ")");

        job = readJSON(jobPath);
        errorFlag = job.errorFlag;
        doneFlag  = job.doneFlag;
        if (!job.aepPath)   throw new Error("job.aepPath missing");
        if (!job.targetDir) throw new Error("job.targetDir missing");
        if (!job.doneFlag)  throw new Error("job.doneFlag missing");
        if (!job.errorFlag) throw new Error("job.errorFlag missing");

        // ---- Open the source project -----------------------------------------
        var srcFile = new File(job.aepPath);
        if (!srcFile.exists) throw new Error("Source .aep not found: " + job.aepPath);
        log("Opening source project: " + srcFile.fsName);
        // app.open() prompts to save if current project is dirty — desired.
        app.open(srcFile);

        // ---- Pick primary comp -----------------------------------------------
        var primary = pickPrimaryComp(job.compName);
        if (!primary) throw new Error("No CompItem in source project.");
        log("Primary comp: '" + primary.name + "' " + primary.width + "x" + primary.height
            + " @ " + primary.frameRate + "fps, dur=" + primary.duration + "s");

        // ---- Harvest tags from comp markers (CHIRAL:TAG=<value>) -------------
        // Read BEFORE reduceProject/collectFiles so we can't lose them to
        // project mutation. These become the asset's initial tags[] array
        // (the user can edit them later in the vault window).
        var markerTags = collectCompMarkerTags(primary);
        if (markerTags.length > 0) log("Marker tags: " + markerTags.join(", "));

        // Capture comp settings BEFORE reduceProject (it doesn't change specs
        // but we want to record what the user saw).
        var compSettings = {
            name:           primary.name,
            width:          primary.width,
            height:         primary.height,
            frameRate:      primary.frameRate,
            duration:       primary.duration,
            durationFrames: Math.round(primary.duration * primary.frameRate),
            pixelAspect:    primary.pixelAspect,
        };

        // ---- Ensure target dir and collect -----------------------------------
        var targetFolder = ensureFolder(job.targetDir);
        log("Target dir: " + targetFolder.fsName);

        app.beginUndoGroup("Chiral Vault: collect files");
        var collectReport = { collected: [], skipped: [] };
        try {
            // Reduce first — drops unused items so we don't ship footage
            // from unrelated comps. Keeps the primary comp + its dependencies.
            try {
                app.project.reduceProject([primary]);
                log("reduceProject done.");
            } catch (e) {
                // Some AE versions throw if the project is already minimal.
                log("reduceProject skipped: " + e.toString());
            }

            // Save a copy of the project into targetDir BEFORE we repoint
            // footage. app.project.save(file) is AE's "Save As" — afterwards
            // app.project refers to the copy, leaving the user's original
            // untouched on disk.
            var aepName = srcFile.name; // e.g. "Shot_042.aep"
            var destAep = new File(targetFolder.fsName + "/" + aepName);
            log("Saving project copy to: " + destAep.fsName);
            app.project.save(destAep);

            // Manual footage collect — see collectFootageManually() comment.
            // This is the replacement for the nonexistent collectFiles() API.
            collectReport = collectFootageManually(targetFolder);
            log("Footage collected=" + collectReport.collected.length
                + " skipped=" + collectReport.skipped.length);

            // Re-save so the repointed footage paths persist in the .aep.
            try { app.project.save(); log("Project re-saved."); }
            catch (e) { log("Re-save failed: " + e.toString()); }
        } finally {
            try { app.endUndoGroup(); } catch (e) {}
        }

        // ---- Enumerate fonts + plugins ---------------------------------------
        // NOTE: after collectFiles, AE may have replaced the project in memory
        // with the collected copy. We re-walk comps from the (now-current)
        // project — same logical content, different footage paths.
        var comps = allComps();
        var fonts   = collectFonts(comps);
        var plugins = collectPlugins(comps);
        log("Fonts collected: "   + fonts.length);
        log("Plugins collected: " + plugins.length);

        // ---- Find the collected .aep relpath ---------------------------------
        var collectedAep = findCollectedAep(targetFolder);
        var aepBasename  = collectedAep ? collectedAep.name : null;
        if (!aepBasename) log("WARNING: no .aep found in targetDir after collect");

        // ---- Scan footage ----------------------------------------------------
        var footage = scanFootage(targetFolder);
        log("Footage count: " + footage.count);

        // Make the footage relPaths relative to the ASSET dir (targetFolder.parent)
        // so they align with lib/asset.js's files.aeRoot = "ae/" convention.
        var assetDirFs  = targetFolder.parent.fsName.replace(/\\/g, "/");
        var normalized  = [];
        for (var i = 0; i < footage.files.length; i++) {
            var abs = footage.files[i].relPath;
            var rel = abs;
            if (abs.toLowerCase().indexOf(assetDirFs.toLowerCase() + "/") === 0) {
                rel = abs.substring(assetDirFs.length + 1);
            }
            normalized.push({ relPath: rel, bytes: footage.files[i].bytes });
        }

        // ---- AE version info -------------------------------------------------
        var aeVersion = {
            version: app.version,
            buildName: (app.buildName || null),
            buildNumber: (app.buildNumber || null),
        };

        // ---- Write done sentinel ---------------------------------------------
        writeJSON(doneFlag, {
            ok: true,
            aepBasename: aepBasename,                  // e.g. "Shot_042.aep"
            aepRelPath:  aepBasename ? ("ae/" + aepBasename) : null,
            aeRootRel:   "ae/",
            footageCount: footage.count,
            footage: normalized,
            fonts: fonts,
            plugins: plugins,
            aeVersion: aeVersion,
            compSettings: compSettings,
            markerTags: markerTags,
            collectedAt: new Date().toString(),
            collectSkipped: collectReport.skipped,
        });
        log("==== vault_collect OK ====");
    } catch (e) {
        log("ERROR: " + e.toString());
        // Best-effort error sentinel. If errorFlag isn't set yet (job parse
        // failed before we got there), write to a fixed temp fallback so the
        // Electron side can still surface something.
        var fallback = Folder.temp.fsName + "/roundtrip_vault_error.json";
        var target = errorFlag || fallback;
        try {
            writeJSON(target, {
                ok: false,
                error: e.toString(),
                line: (e.line || null),
                file: (e.fileName || null),
                at: new Date().toString(),
            });
        } catch (ee) {
            log("Could not write errorFlag: " + ee.toString());
        }
        try { app.endUndoGroup(); } catch (ee) {}
    }
})();
