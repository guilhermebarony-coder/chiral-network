// vault_clip.jsx — Clip / Template-clip Vault handoff (0.5.0-dev23).
//
// Three vault flavors now flow through this one script:
//   * File clip (dev13)  — bare file (PSD, jpg, mov, …). The user marks
//                          a footage item with a real file on disk; we
//                          copy the file into the asset's clips/ folder.
//   * Comp template (dev23) — a CompItem the user wants to reuse. We
//                          save a miniature .aep containing JUST that
//                          comp + its dependencies (reduceProject
//                          scoped to the comp).
//   * Layer template (dev23) — a Solid / Text / Null / Shape /
//                          Adjustment layer the user wants to reuse as
//                          a procedural element. We synthesize a
//                          wrapper comp matching the source comp's
//                          specs, copyToComp the layer in, then save
//                          + reduce. Lets users vault things that
//                          don't exist as files (the user-requested
//                          "Black Solid 1 with my mask + effect stack"
//                          case).
//
// One asset per procedural mark — they're independent reusable
// templates. File clips still bundle into ONE shared asset (existing
// dev13 behavior) since they're fundamentally a list of files.
//
// Marker convention — THREE places work (dev22), pick whichever is
// closest to hand:
//
//   (A) Project panel — set the "Comment" column on a FootageItem.
//       Also works on a CompItem, but we can't actually clip a comp
//       (no file on disk); see the Pass 1 skip message below.
//   (B) Timeline panel — set the "Comment" column on a layer that
//       points at a FootageItem.
//   (C) Layer markers (Shift+8) — set the marker comment to the same
//       string. Useful when you want to mark a moment in time AND
//       flag the layer for vaulting in one gesture.
//
// All three accept the same vocabulary:
//   CHIRAL:CLIP                    -> include this file in the clip vault
//                                     (no tag — rarely used; prefer the
//                                     tagged form below for traceability)
//   CHIRAL:TAG=hero                -> include this file AND tag it "hero"
//                                     (dev21: TAG on an item/layer implies
//                                     inclusion — you don't need both)
//   "CHIRAL:CLIP; CHIRAL:TAG=hero" -> equivalent to just CHIRAL:TAG=hero
//
// Tags merge across surfaces — marking the same layer in (B) AND adding
// a Shift+8 marker in (C) doesn't duplicate the clip; we collect once
// with the union of all tags found.
//
// dev23 — what used to be skipped (solids / placeholders / precomp
// layers, comps marked in the project panel) is now PROCEDURAL and
// gets its own mini-.aep. The only remaining skip cases are layers
// that have literally no source AND are not a layer type AE can wrap
// (e.g. damaged layers, third-party-plugin shapes that refuse
// copyToComp). Those still go to skipped[] so the user knows.
//
// Dedup: marking the same FootageItem in both places (Project + a layer
// using it) doesn't duplicate the clip — we collect one entry and merge
// the tag sets.
//
// Invocation (same pattern as vault_collect.jsx):
//   Electron writes the clip-job JSON path to:
//     %TEMP%/roundtrip_current_clipjob.txt
//   then runs:
//     AfterFX.exe -r vault_clip.jsx
//
// clipjob.json keys:
//   aepPath      absolute path to the source .aep
//   targetDir    <VaultRoot>/assets/<uuid>/  (the file-clip asset dir)
//   vaultRoot    <VaultRoot>/                (NEW dev23 — needed because
//                                             procedural marks each get
//                                             their own asset dir minted
//                                             on the fly)
//   doneFlag     where to drop the success sentinel
//   errorFlag    where to drop the failure sentinel
//
// Output (done sentinel) — dev23:
//   {
//     ok: true,
//     type: "clip",
//     clips: [ { relPath, bytes, name, tags:[], originalPath } ],
//     skipped: [ { name, reason } ],
//     markerTags: [...],          // union of all CHIRAL:TAG values
//     proceduralAssets: [         // dev23 — one per comp/layer mark
//       {
//         assetId, assetDir, aeProject,    // mini.aep relpath
//         name, kind: "comp" | "layer",
//         tags, specAtVault: { fps, width, height, durationFrames }
//       }
//     ],
//     aeVersion: { version, ... },
//     collectedAt: ISO,
//   }
//
// Contract:
//   * NEVER modifies the source .aep. We open it read-only-ish, scan for
//     tagged items, copy out, close without saving.
//   * EXACTLY ONE of {doneFlag, errorFlag} is created.
//   * All clip relPaths are RELATIVE to the asset dir (start with "clips/").

(function () {
    var LOG_PATH     = Folder.temp.fsName + "/roundtrip_ae.log";
    var POINTER_PATH = Folder.temp.fsName + "/roundtrip_current_clipjob.txt";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln(new Date().toString() + "  [vault_clip] " + msg);
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

    // Minimal JSON.stringify — see vault_collect.jsx for rationale.
    function jsonStringify(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number" || t === "boolean") return String(v);
        if (t === "string") {
            return "\"" + v
                .replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
                .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + "\"";
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
    function writeJSON(p, obj) {
        // dev18 #3 — atomic sentinel write. See vault_collect.jsx for the
        // full rationale; tl;dr: rename within a folder is atomic, so the
        // Node-side poller never reads a partially-written done/error flag.
        var f = new File(p);
        var parent = f.parent;
        if (!parent.exists) parent.create();
        var tmp = new File(p + ".tmp");
        tmp.encoding = "UTF-8";
        tmp.open("w");
        tmp.write(jsonStringify(obj));
        tmp.close();
        if (f.exists) { try { f.remove(); } catch (_) {} }
        if (!tmp.rename(f.name)) throw new Error("sentinel rename failed: " + tmp.fsName);
    }
    function ensureFolder(pathStr) {
        var f = new Folder(pathStr);
        if (!f.exists) {
            var ok = f.create();
            if (!ok) throw new Error("Could not create folder: " + pathStr);
        }
        return f;
    }

    // dev23 — UUID v4-ish for procedural asset IDs. ExtendScript has no
    // crypto.randomUUID; this is a Math.random-based v4 pattern. Not
    // crypto-secure but unique enough for asset IDs (collision probability
    // is astronomical for a single-user vault). Pattern matches the regex
    // in lib/asset.js so the Node side validates it.
    function generateUUID() {
        var hex = "0123456789abcdef";
        function r(n) {
            var s = "";
            for (var i = 0; i < n; i++) s += hex.charAt(Math.floor(Math.random() * 16));
            return s;
        }
        // RFC 4122 v4 layout: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        // y must be 8, 9, a, or b.
        var y = hex.charAt(8 + Math.floor(Math.random() * 4));
        return r(8) + "-" + r(4) + "-4" + r(3) + "-" + y + r(3) + "-" + r(12);
    }

    // dev23 — strip filesystem-hostile characters from a comp/layer name
    // so we can use it as a .aep filename. Keeps letters/digits/dashes/
    // underscores; collapses everything else to "_".
    function sanitizeFilename(s) {
        var raw = String(s || "template");
        return raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "template";
    }

    // dev23 — find the first CompItem whose name matches. Used after a
    // Save As reload to re-locate a comp by name (the in-memory items
    // survive Save As, but defensive code helps if AE ever changes that).
    function findCompByName(name) {
        for (var i = 1; i <= app.project.items.length; i++) {
            var it = app.project.items[i];
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }

    // Parse a FootageItem comment. Returns { isClip:bool, tags:[string] }.
    // Tolerant of mixed separators and case. Skips empty/whitespace-only
    // comments cheaply so the iteration is fast on large projects.
    function parseClipComment(comment) {
        var out = { isClip: false, tags: [] };
        if (!comment) return out;
        var raw = String(comment);
        if (!raw.replace(/\s+/g, "")) return out;

        // dev31 — multi-tag fix. Pre-dev31 we split on /[;,\s]+/ FIRST
        // and then matched each chunk against ^CHIRAL:TAG=value$. That
        // worked for `CHIRAL:TAG=a CHIRAL:TAG=b` but NOT for
        // `CHIRAL:TAG=a,b,c` — splitting on commas turned `a,b,c` into
        // three separate chunks, and only the first carried the prefix.
        // Several testers tried the comma form (it's the natural way
        // to read "give me three tags"), and only got the first one.
        //
        // New strategy: don't split first. Walk the raw string, find
        // every CHIRAL:TAG= run (terminated by whitespace or semicolon),
        // capture its value, then split that value on commas/semicolons
        // for additional tags. Both forms work now.

        // CHIRAL:CLIP detection — anywhere the bare token appears,
        // bracketed by whitespace, semicolon, comma, or string boundary.
        if (/(^|[\s;,])CHIRAL:CLIP(?=$|[\s;,])/i.test(raw)) {
            out.isClip = true;
        }

        // CHIRAL:TAG= captures. The capture group greedily consumes up
        // to the next whitespace or semicolon (NOT comma — commas live
        // inside the value list). Tag values are then split on
        // [,;] internally.
        var seen = {};
        var re = /CHIRAL:TAG=([^\s;]+)/gi;
        var m;
        while ((m = re.exec(raw)) !== null) {
            var values = m[1].split(/[,]/);
            for (var i = 0; i < values.length; i++) {
                var t = String(values[i] || "").replace(/^\s+|\s+$/g, "").toLowerCase();
                if (t.length > 0 && t.length <= 40 && !seen[t]) {
                    seen[t] = true;
                    out.tags.push(t);
                }
            }
        }

        // dev21 — TAG implies CLIP. If the user bothered to label a
        // specific item with `CHIRAL:TAG=…`, they mean to vault THAT
        // item even without an explicit `CHIRAL:CLIP` token.
        if (out.tags.length > 0) out.isClip = true;
        return out;
    }

    log("==== vault_clip start ====");
    log("AE version: " + app.version);

    var job = null;
    var doneFlag = null, errorFlag = null;
    var srcFile = null;     // captured early so the procedural loop can reopen

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
        doneFlag  = job.doneFlag;
        errorFlag = job.errorFlag;
        if (!job.aepPath)   throw new Error("job.aepPath missing");
        if (!job.targetDir) throw new Error("job.targetDir missing");
        if (!job.doneFlag)  throw new Error("job.doneFlag missing");
        if (!job.errorFlag) throw new Error("job.errorFlag missing");

        // ---- Open source project --------------------------------------------
        srcFile = new File(job.aepPath);
        if (!srcFile.exists) throw new Error("Source .aep not found: " + job.aepPath);
        log("Opening source project: " + srcFile.fsName);
        app.open(srcFile);

        // ---- Discover marked items (dev22 — 3 surfaces) --------------------
        // Two-pass scan that builds a map keyed by FootageItem id. Each entry
        // accumulates the union of tags found across every place the item
        // (or a layer using it) is marked.
        //
        // Pass 1: every item in app.project.items — Project-panel `Comment`
        //         column (Item.comment). FootageItems with a real file get
        //         included; CompItems get a friendly skip ("can't clip a
        //         comp — mark its layers instead"); solids/placeholders get
        //         a "no file on disk" skip.
        //
        // Pass 2: every layer of every CompItem. Two metadata sources per
        //         layer, scanned together so tags merge:
        //           - layer.comment (Timeline `Comment` column)
        //           - layer markers (Shift+8 markers' `.comment` field)
        //         We resolve layer.source to its FootageItem; if it's a
        //         Solid/Placeholder/precomp we record a skip reason.
        var assetFolder = ensureFolder(job.targetDir);
        var clipsFolder = ensureFolder(assetFolder.fsName + "/clips");

        var marks   = {};                // itemId -> { item, tags:{} }
        var skipped = [];                // { name, reason }
        var examined = {
            items: 0, layers: 0, layerMarkers: 0,
            foundProjectMarks: 0, foundLayerCommentMarks: 0, foundLayerMarkerMarks: 0,
        };

        // Read every Shift+8 layer marker on this layer and return its
        // .comment strings. Layer markers live on layer.property("Marker"),
        // which is the same MarkerValue-keyed property as a comp's
        // markerProperty — 1-indexed numKeys, keyValue(i).comment.
        // Tolerant of layers that don't expose the property at all (text
        // layers in some AE versions, etc.).
        function getLayerMarkerComments(layer) {
            var out = [];
            try {
                var mp = layer.property("Marker");
                if (!mp) return out;
                for (var k = 1; k <= mp.numKeys; k++) {
                    try {
                        var mv = mp.keyValue(k);
                        if (mv && typeof mv.comment === "string") out.push(mv.comment);
                    } catch (e) { /* one bad marker shouldn't kill the read */ }
                }
            } catch (e) { /* layer.property("Marker") not available */ }
            return out;
        }

        // Parse multiple comment strings together and return the union of
        // their parsed results. A layer marked via comment AND a Shift+8
        // marker collapses to one entry with merged tags.
        function parseClipCommentSet(comments) {
            var union = { isClip: false, tags: [] };
            var seen  = {};
            for (var i = 0; i < comments.length; i++) {
                var p = parseClipComment(comments[i]);
                if (p.isClip) union.isClip = true;
                for (var t = 0; t < p.tags.length; t++) {
                    if (!seen[p.tags[t]]) { seen[p.tags[t]] = true; union.tags.push(p.tags[t]); }
                }
            }
            return union;
        }

        // Procedural plans — collected during scan, executed after the
        // file-clip pass. Each plan creates one mini-.aep + asset.json.
        // Captured by name/index so we can re-find references after a
        // app.open() reopens the source between iterations.
        //
        // Plan shape:
        //   { kind: "comp",  compName, tags }           — vault that comp
        //   { kind: "layer", parentCompName, layerIndex,
        //                    layerName, tags }          — wrap layer in
        //                                                  a synth comp
        var proceduralPlans = [];
        function addProcPlanComp(comp, tags) {
            proceduralPlans.push({ kind: "comp", compName: comp.name, tags: tags });
        }
        function addProcPlanLayer(layer, parentComp, tags) {
            proceduralPlans.push({
                kind: "layer",
                parentCompName: parentComp.name,
                layerIndex: layer.index,
                layerName: layer.name,
                tags: tags,
            });
        }

        function recordMark(item, tags, originLayer, originComp) {
            // dev23 — three branches:
            //   FootageItem + FileSource -> file clip (existing)
            //   CompItem                  -> comp template (procedural)
            //   else                      -> layer template (procedural)
            //                                using the layer that bore
            //                                the mark, since solids/etc
            //                                only exist as layer instances
            //                                with their own properties.
            if (item instanceof CompItem) {
                addProcPlanComp(item, tags);
                return;
            }
            if (item instanceof FootageItem) {
                var src = null; try { src = item.mainSource; } catch (e) {}
                if (src instanceof FileSource) {
                    // Real file on disk — file-clip path (existing).
                    var key = item.id;
                    if (!marks[key]) marks[key] = { item: item, tags: {} };
                    for (var t = 0; t < tags.length; t++) marks[key].tags[tags[t]] = true;
                    return;
                }
                // SolidSource / PlaceholderSource — wrap the layer if we
                // know which layer carried the mark; otherwise skip with
                // a hint. Project-panel marks on a solid item don't tell
                // us WHICH usage to wrap; we ask the user to mark the
                // layer instead.
                if (originLayer && originComp) {
                    addProcPlanLayer(originLayer, originComp, tags);
                    return;
                }
                skipped.push({
                    name: item.name,
                    reason: "solid/placeholder item — mark the layer that uses it (in the timeline) instead of the project-panel item",
                });
                return;
            }
            // Anything else (shouldn't normally land here from Pass 1)
            skipped.push({ name: (item && item.name) || "?", reason: "unsupported item type" });
        }

        // Pass 1 — Project panel Comment column on every Item.
        var items = [];
        for (var i = 1; i <= app.project.items.length; i++) items.push(app.project.items[i]);
        for (var j = 0; j < items.length; j++) {
            examined.items++;
            var it = items[j];
            var itComment = "";
            try { itComment = it.comment || ""; } catch (e) {}
            var parsed = parseClipComment(itComment);
            if (!parsed.isClip) continue;
            examined.foundProjectMarks++;
            recordMark(it, parsed.tags, null, null);
        }

        // Pass 2 — Per layer: comment column AND Shift+8 layer markers.
        for (var c = 0; c < items.length; c++) {
            var comp = items[c];
            if (!(comp instanceof CompItem)) continue;
            for (var L = 1; L <= comp.numLayers; L++) {
                examined.layers++;
                var layer = comp.layer(L);

                var lc = "";
                try { lc = layer.comment || ""; } catch (e) {}
                var lmComments = getLayerMarkerComments(layer);
                examined.layerMarkers += lmComments.length;

                var sources = [];
                if (lc) sources.push(lc);
                for (var lmi = 0; lmi < lmComments.length; lmi++) sources.push(lmComments[lmi]);
                if (sources.length === 0) continue;

                var commentMatch = lc ? parseClipComment(lc).isClip : false;
                var markerMatch  = false;
                for (var mci = 0; mci < lmComments.length; mci++) {
                    if (parseClipComment(lmComments[mci]).isClip) { markerMatch = true; break; }
                }

                var parsedL = parseClipCommentSet(sources);
                if (!parsedL.isClip) continue;
                if (commentMatch) examined.foundLayerCommentMarks++;
                if (markerMatch)  examined.foundLayerMarkerMarks++;

                // dev23 — branch on the layer's source:
                //   FootageItem with FileSource -> recordMark routes to file-clip
                //   CompItem (precomp)           -> recordMark routes to comp template
                //   FootageItem with SolidSource / PlaceholderSource -> wrap layer
                //   layer.source === null (text/null/shape/camera/light) -> wrap layer
                var lsrc = null; try { lsrc = layer.source; } catch (e) {}
                if (lsrc) {
                    recordMark(lsrc, parsedL.tags, layer, comp);
                } else {
                    // Sourceless layer types: text/null/shape/camera/light/adjustment.
                    // Wrap the layer itself.
                    addProcPlanLayer(layer, comp, parsedL.tags);
                }
            }
        }
        var fileMarkCount = 0;
        for (var _fk in marks) if (marks.hasOwnProperty(_fk)) fileMarkCount++;
        log("Scan: " + examined.items + " items, " + examined.layers + " layers, "
            + examined.layerMarkers + " layer-markers; "
            + examined.foundProjectMarks + " project-panel marks, "
            + examined.foundLayerCommentMarks + " layer-comment marks, "
            + examined.foundLayerMarkerMarks + " layer-marker marks; "
            + fileMarkCount + " file-clip targets, "
            + proceduralPlans.length + " procedural plans");

        // ---- Copy + record ---------------------------------------------------
        var clips      = [];
        var markerTags = {};
        var usedNames  = {};

        for (var keyId in marks) {
            if (!marks.hasOwnProperty(keyId)) continue;
            var rec   = marks[keyId];
            var fItem = rec.item;
            var fTags = [];
            for (var tk in rec.tags) if (rec.tags.hasOwnProperty(tk)) {
                fTags.push(tk);
                markerTags[tk] = true;
            }

            var srcF = null; try { srcF = fItem.file; } catch (e) {}
            if (!srcF || !srcF.exists) {
                skipped.push({ name: fItem.name, reason: "missing on disk" });
                log("Skip (missing): " + fItem.name);
                continue;
            }

            // Dedup on filename — two items with same basename get _N suffix.
            var baseName = srcF.name;
            var destName = baseName;
            var n = 1;
            while (usedNames[destName.toLowerCase()]) {
                var dot = baseName.lastIndexOf(".");
                if (dot > 0) destName = baseName.substring(0, dot) + "_" + n + baseName.substring(dot);
                else         destName = baseName + "_" + n;
                n++;
            }
            usedNames[destName.toLowerCase()] = true;

            var destF = new File(clipsFolder.fsName + "/" + destName);
            var copied = false;
            try { copied = srcF.copy(destF.fsName); } catch (e) {
                log("copy threw on '" + fItem.name + "': " + e.toString());
            }
            if (!copied || !destF.exists) {
                skipped.push({ name: fItem.name, reason: "copy failed" });
                log("Copy FAILED: " + srcF.fsName + " -> " + destF.fsName);
                continue;
            }

            var sz = 0; try { sz = destF.length; } catch (e) {}
            clips.push({
                relPath:      "clips/" + destName,
                bytes:        sz,
                name:         fItem.name,
                tags:         fTags,
                originalPath: srcF.fsName.replace(/\\/g, "/"),
            });
            log("Clipped: " + fItem.name + " -> clips/" + destName + (fTags.length ? "  tags=" + fTags.join(",") : ""));
        }

        // ---- Procedural extraction (dev23) ----------------------------------
        // For each plan: save-as a mini.aep into a fresh asset dir, scope
        // to the target (reduce to comp, or wrap layer + reduce), save,
        // reopen the source for the next plan. Each iteration produces
        // ONE asset that the orchestrator finalizes via A.createAsset.
        //
        // The lock from dev20 is held across this whole script invocation,
        // so we can serialize internally without worrying about another
        // -r landing on AE.
        var proceduralAssets = [];

        function reopenSource() {
            // Close cleanly without prompts, then reopen the original .aep
            // so the next iteration starts from a fresh project.
            try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (e) {}
            app.open(srcFile);
        }

        function buildProceduralAsset(plan, vaultRoot) {
            var assetId  = generateUUID();
            var assetDir = vaultRoot + "/assets/" + assetId;
            var aeDir    = assetDir + "/ae";
            ensureFolder(aeDir);

            var displayName = (plan.kind === "comp")
                ? plan.compName
                : (plan.layerName + " (template)");
            var aepBasename = sanitizeFilename(plan.kind === "comp" ? plan.compName : plan.layerName) + ".aep";
            var miniAepFs = aeDir + "/" + aepBasename;

            // Save-as the current in-memory project to the mini path.
            // app.project.file becomes the new file; in-memory items
            // remain valid and reachable by the references we still hold.
            log("Saving " + plan.kind + " template '" + displayName + "' -> " + miniAepFs);
            app.project.save(new File(miniAepFs));

            var subjectComp;
            if (plan.kind === "comp") {
                subjectComp = findCompByName(plan.compName);
                if (!subjectComp) throw new Error("Could not relocate comp '" + plan.compName + "' after save-as");
            } else {
                // Layer wrap: synthesize a comp matching the parent's
                // specs, copyToComp the source layer in. The wrapper
                // becomes the reduce target so the resulting mini.aep
                // contains JUST the wrapper + whatever sources/effects
                // the layer transitively needs.
                var parent = findCompByName(plan.parentCompName);
                if (!parent) throw new Error("Could not relocate parent comp '" + plan.parentCompName + "'");
                if (plan.layerIndex < 1 || plan.layerIndex > parent.numLayers) {
                    throw new Error("Layer index " + plan.layerIndex + " out of range in '" + plan.parentCompName + "'");
                }
                var srcLayer = parent.layer(plan.layerIndex);
                var wrapName = plan.layerName + " (template)";
                // Cap wrapper duration so a 10-min comp doesn't write a
                // 10-min wrapper just to vault one solid. Use the layer's
                // own outPoint-inPoint, fall back to the parent comp's
                // duration if the layer is a 0-length null/marker.
                var lDur = 0;
                try { lDur = (srcLayer.outPoint - srcLayer.inPoint) || 0; } catch (e) {}
                var wrapDur = (lDur > 0) ? lDur : parent.duration;
                if (wrapDur <= 0) wrapDur = 5;
                subjectComp = app.project.items.addComp(
                    wrapName,
                    parent.width, parent.height,
                    parent.pixelAspect,
                    wrapDur,
                    parent.frameRate
                );
                srcLayer.copyToComp(subjectComp);
                log("Wrapped layer #" + plan.layerIndex + " '" + plan.layerName + "' into '" + wrapName + "'");
            }

            try { app.project.reduceProject([subjectComp]); }
            catch (e) { log("reduceProject skipped (" + plan.kind + " template): " + e.toString()); }
            app.project.save();   // flush the reduced project to mini.aep

            // Capture comp specs AFTER reduce so callers see what the
            // rendered template will actually be.
            var specAtVault = {
                fps:    subjectComp.frameRate,
                width:  subjectComp.width,
                height: subjectComp.height,
                durationFrames: Math.round(subjectComp.duration * subjectComp.frameRate),
            };

            // dev24 — thumbnail. Render one frame from the middle of the
            // subject comp via CompItem.saveFrameToPng (AE 14.2+). Saves
            // a full-resolution PNG into the asset dir so the vault grid
            // can show a real preview instead of "proxy pending."
            //
            // We pick the midpoint frame because:
            //   * Frame 0 is often a fade-in / empty / pre-key state.
            //   * Endpoint is often a fade-out.
            //   * Midpoint is the "hero frame" for most templates.
            //
            // Wrapped in a try/catch — a render-time error (missing font,
            // expression that throws on first eval, etc.) shouldn't fail
            // the whole template extraction. The asset just lands without
            // a thumb, like file-clips do today.
            // dev34 — harden thumb render. saveFrameToPng on a freshly
            // synthesized layer-wrap comp sometimes fails until the comp
            // has been opened in the viewer. Also try multiple sample
            // times so a wrapper whose midpoint falls outside the
            // wrapped layer's active range still gets a non-empty frame.
            var thumbRel = null;
            try {
                var thumbFs = assetDir + "/thumb.png";
                try { subjectComp.openInViewer(); } catch (eOpen) {}
                var dur = subjectComp.duration > 0 ? subjectComp.duration : 0;
                var samples = [];
                if (dur > 0) {
                    samples.push(dur / 2);
                    samples.push(0);
                    samples.push(Math.max(0, dur - (1 / subjectComp.frameRate)));
                } else {
                    samples.push(0);
                }
                var lastErr = null;
                for (var si = 0; si < samples.length; si++) {
                    try {
                        subjectComp.saveFrameToPng(samples[si], new File(thumbFs));
                        thumbRel = "thumb.png";
                        log("Thumbnail rendered at t=" + samples[si].toFixed(3) + "s -> " + thumbFs);
                        break;
                    } catch (eS) {
                        lastErr = eS;
                    }
                }
                if (!thumbRel && lastErr) {
                    log("Thumbnail render failed (non-fatal): " + lastErr.toString());
                }
            } catch (eThumb) {
                log("Thumbnail render failed (non-fatal): " + eThumb.toString());
            }

            // Hand the asset off to the orchestrator. asset.json gets
            // written Node-side via A.createAsset so schema knowledge
            // stays in one place.
            proceduralAssets.push({
                assetId:    assetId,
                assetDir:   assetDir.replace(/\\/g, "/"),
                aeProject:  "ae/" + aepBasename,
                aeRoot:     "ae/",
                thumbnail:  thumbRel,            // dev24 — null if render failed
                name:       displayName,
                kind:       plan.kind,
                tags:       plan.tags,
                specAtVault: specAtVault,
            });
            log("Built " + plan.kind + " template asset " + assetId.substring(0, 8) + " '" + displayName + "'"
                + (thumbRel ? " (with thumbnail)" : " (no thumbnail)"));

            // Reopen the source for the next plan (or as a no-op final
            // restore so the user doesn't see the last mini.aep loaded
            // when AE comes back to the foreground).
            reopenSource();
        }

        for (var pi = 0; pi < proceduralPlans.length; pi++) {
            var plan = proceduralPlans[pi];
            try {
                buildProceduralAsset(plan, job.vaultRoot);
            } catch (e) {
                log("Procedural plan " + pi + " failed: " + e.toString());
                skipped.push({
                    name: (plan.kind === "comp") ? plan.compName : plan.layerName,
                    reason: "template extract failed: " + e.toString(),
                });
                // Best-effort recover for the next plan: reopen the source
                // so we don't carry mid-state forward.
                try { reopenSource(); } catch (ee) {
                    log("reopenSource after failure threw: " + ee.toString());
                }
            }
        }

        // ---- Failure gate ---------------------------------------------------
        // dev23 — only bail if neither file clips NOR procedural assets
        // got produced. With templates landing here, the previous
        // "no clips" hard error would fire even after a successful comp
        // template extraction.
        if (clips.length === 0 && proceduralAssets.length === 0) {
            var totalFound = examined.foundProjectMarks
                           + examined.foundLayerCommentMarks
                           + examined.foundLayerMarkerMarks;
            var hint;
            if (totalFound === 0) {
                hint = "No CHIRAL:TAG= or CHIRAL:CLIP markers found.\n\n"
                     + "Add a marker to ANY of these places:\n"
                     + "  • Project panel — the \"Comment\" column on a footage item or comp\n"
                     + "  • Timeline panel — the \"Comment\" column on a layer\n"
                     + "  • Layer marker (Shift+8) — set the marker's comment\n\n"
                     + "Format:\n"
                     + "  CHIRAL:TAG=name   (the tag is also the include flag)\n"
                     + "  CHIRAL:CLIP        (include without tagging)\n"
                     + "  Both can be combined: CHIRAL:CLIP; CHIRAL:TAG=name\n\n"
                     + "Files become bare-file clips. Comps and layers (solids,\n"
                     + "text, nulls, shapes) become reusable mini-AEP templates.";
            } else {
                var reasons = [];
                for (var s = 0; s < skipped.length; s++) {
                    reasons.push("  • " + skipped[s].name + " — " + skipped[s].reason);
                }
                hint = "Found " + totalFound + " marker(s), but nothing was vaultable:\n"
                     + reasons.join("\n");
            }
            throw new Error(hint);
        }

        var allTags = [];
        for (var k in markerTags) if (markerTags.hasOwnProperty(k)) allTags.push(k);

        var aeVersion = {
            version:     app.version,
            buildName:   (app.buildName   || null),
            buildNumber: (app.buildNumber || null),
        };

        writeJSON(doneFlag, {
            ok:               true,
            type:             "clip",
            clips:            clips,
            proceduralAssets: proceduralAssets,    // dev23
            skipped:          skipped,
            markerTags:       allTags,
            aeVersion:        aeVersion,
            collectedAt:      new Date().toString(),
        });
        log("==== vault_clip OK (" + clips.length + " file clips, "
            + proceduralAssets.length + " templates, "
            + skipped.length + " skipped) ====");
    } catch (e) {
        log("ERROR: " + e.toString());
        var fallback = Folder.temp.fsName + "/roundtrip_clip_error.json";
        var target = errorFlag || fallback;
        try {
            writeJSON(target, {
                ok:    false,
                error: e.toString(),
                line:  (e.line || null),
                file:  (e.fileName || null),
                at:    new Date().toString(),
            });
        } catch (ee) {
            log("Could not write errorFlag: " + ee.toString());
        }
    }
})();
