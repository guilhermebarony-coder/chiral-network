// render_version.jsx
// Preferred: Electron writes render-job path to %TEMP%\roundtrip_current_renderjob.txt,
// then runs:  AfterFX.exe -r render_version.jsx
//
// renderjob.json keys:
//   compName        e.g. "Shot_012"
//   versionDir      absolute path to renders/vNN  (must exist, forward slashes)
//   masterBasename  (optional) base name for the master without extension
//                   e.g. "lower_third_v02_4444_s50"
//                   Defaults to "render" for backward compatibility.
//   renderFormat    (optional) "mp4" | "prores_422" | "prores_4444"
//                   Controls the codec/container:
//                     mp4         -> H.264 MP4 (.mp4)
//                     prores_422  -> ProRes 422 LT (.mov)
//                     prores_4444 -> ProRes 4444 + alpha (.mov)
//                   Defaults to prores_4444.
//   renderScale     (optional) 0.25 | 0.5 | 0.75 | 1.0
//                   Output resolution as fraction of comp size. Applied via a
//                   temporary wrapper comp (source comp is never modified).
//                   Defaults to 1.0.
//
//   Legacy keys also honoured, in this priority:
//     renderQuality "superfast" -> {mp4, 0.5}
//     renderQuality "fast"      -> {prores_422, 0.5}
//     renderQuality "final"     -> {prores_4444, 1.0}
//     renderMode    "fast"      -> {prores_422, 0.5}
//     renderMode    "final"     -> {prores_4444, 1.0}
//
//   masterExt       (optional) forced file extension, e.g. ".mp4".
//                   If omitted we infer ".mp4" for mp4 and ".mov" otherwise.
//
// Output module templates (primary, preferred — full-resolution, no stretch):
//   "_rt_mp4"     -> H.264 MP4
//   "_rt_422lt"   -> ProRes 422 LT
//   "_rt_4444"    -> ProRes 4444 + alpha
// Legacy fallback templates:
//   mp4        -> "_superfast_mp4" -> AE built-in "H.264 - Match Render Settings - 15 Mbps"
//   prores_422 -> "_fast_422lt" -> "_ProRes422LT"
//   prores_4444-> "_final_4444" -> "_ProRes4444"
// Scaling is done by pre-composing the source comp into a temp wrapper comp
// at (width*scale, height*scale), so the output-module stretch setting is NOT
// required — legacy templates still work correctly.
// The preview output always uses AE's built-in H.264 template.

(function () {
    var LOG_PATH = Folder.temp.fsName + "/roundtrip_ae.log";
    var POINTER_PATH = Folder.temp.fsName + "/roundtrip_current_renderjob.txt";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln(new Date().toString() + "  [render_version] " + msg);
            f.close();
        } catch (e) {}
    }
    function readText(path) {
        var f = new File(path);
        if (!f.exists) { return null; }
        f.open("r"); var s = f.read(); f.close();
        return s;
    }
    function readJSON(path) {
        var s = readText(path);
        if (s === null) { throw new Error("File not found: " + path); }
        return eval("(" + s + ")");
    }
    // Write a `.render-progress.json` sentinel inside the version dir so the
    // Electron side can show a real status instead of "Rendering…" frozen
    // forever. `rq.render()` is blocking in ExtendScript — we can't stream
    // per-frame — so the best we can do is stage-level progress: preparing
    // (comp located, queue built), rendering (about to block in rq.render),
    // complete / error (terminal). The renderer polls this file at ~1s while
    // a render is in flight.
    function writeProgress(versionDir, payload) {
        try {
            var f = new File(versionDir + "/.render-progress.json");
            f.encoding = "UTF-8";
            f.open("w");
            f.write(JSON.stringify(payload));
            f.close();
        } catch (e) {
            // Best-effort only — never fail the render because we couldn't
            // checkpoint our own progress.
            log("writeProgress failed: " + e.toString());
        }
    }
    function resolveJobPath() {
        try {
            if ($.arguments && $.arguments.length > 0) {
                var a = String($.arguments[0]);
                if (a && a.length > 0) return a;
            }
        } catch (e) {}
        var pointed = readText(POINTER_PATH);
        if (pointed !== null) {
            pointed = pointed.replace(/^\s+|\s+$/g, "");
            if (pointed.length > 0) return pointed;
        }
        return null;
    }

    // Format-specific metadata. `tpl` is the preferred template name; `legacy`
    // is an ordered fallback list; `builtin` is a last-resort built-in template
    // (used only for mp4 where AE ships one). `ext` is the default extension.
    // dev58 — primary `tpl:` is now AE's built-in Output Module template.
    // Reason: testers were having to manually create `_rt_mp4` / `_rt_422lt`
    // / `_rt_4444` in After Effects' Output Module preset list before their
    // first render would work. AE templates live in AE's binary prefs file
    // (`Adobe After Effects <ver> Prefs-indep-output.txt`), which is per-
    // version and not shippable from our side. The built-ins below ship
    // with every AE 2022+ install, so promoting them to primary makes the
    // first-run experience zero-setup. The old `_rt_*` names stay in
    // `legacy:` so any tester who already created them keeps working
    // identically — applyTemplate hits the built-in first and the legacy
    // chain only fires if Adobe ever renames a built-in (locale variant,
    // ProRes XQ branding, etc.).
    var FORMAT_INFO = {
        "mp4":         { tpl: "H.264 - Match Render Settings - 15 Mbps",
                         legacy: ["_rt_mp4", "_superfast_mp4"],
                         builtin: "H.264 - Match Render Settings - 15 Mbps",
                         ext: ".mp4" },
        "prores_422":  { tpl: "Apple ProRes 422 LT",
                         legacy: ["_rt_422lt", "_fast_422lt", "_ProRes422LT"],
                         builtin: null, ext: ".mov" },
        "prores_4444": { tpl: "Apple ProRes 4444",
                         legacy: ["_rt_4444", "_final_4444", "_ProRes4444"],
                         builtin: null, ext: ".mov" }
    };

    function resolveFormat(job) {
        if (job.renderFormat) {
            var f = String(job.renderFormat).toLowerCase();
            if (FORMAT_INFO[f]) return f;
        }
        // Legacy renderQuality migration.
        if (job.renderQuality) {
            var q = String(job.renderQuality).toLowerCase();
            if (q === "superfast") return "mp4";
            if (q === "fast")      return "prores_422";
            if (q === "final")     return "prores_4444";
        }
        // Even-older renderMode migration.
        if (job.renderMode) {
            var m = String(job.renderMode).toLowerCase();
            if (m === "fast")  return "prores_422";
            if (m === "final") return "prores_4444";
        }
        return "prores_4444";
    }

    function resolveScale(job) {
        if (typeof job.renderScale === "number" && job.renderScale > 0 && job.renderScale <= 1) {
            // Snap to the supported steps so filename-suffix math stays exact.
            var steps = [0.25, 0.5, 0.75, 1.0];
            var best = 1.0, bestD = 99;
            for (var i = 0; i < steps.length; i++) {
                var d = Math.abs(steps[i] - job.renderScale);
                if (d < bestD) { bestD = d; best = steps[i]; }
            }
            return best;
        }
        // Legacy renderQuality implies scale: superfast/fast=0.5, final=1.0.
        if (job.renderQuality) {
            var q = String(job.renderQuality).toLowerCase();
            if (q === "superfast" || q === "fast") return 0.5;
            if (q === "final") return 1.0;
        }
        if (job.renderMode && String(job.renderMode).toLowerCase() === "fast") return 0.5;
        return 1.0;
    }

    // Apply a template name; returns true on success, logs on failure.
    function tryApply(om, name) {
        try {
            om.applyTemplate(name);
            return true;
        } catch (e) {
            log("applyTemplate('" + name + "') failed: " + e.toString());
            return false;
        }
    }

    function applyFormatTemplate(om, fmt) {
        var fi = FORMAT_INFO[fmt];
        if (tryApply(om, fi.tpl)) { log("Applied template: " + fi.tpl); return; }
        for (var i = 0; i < fi.legacy.length; i++) {
            if (tryApply(om, fi.legacy[i])) {
                log("Applied legacy template: " + fi.legacy[i]);
                return;
            }
        }
        if (fi.builtin && tryApply(om, fi.builtin)) {
            log("Applied built-in template: " + fi.builtin);
            return;
        }
        throw new Error("No usable output module template for format: " + fmt);
    }

    // Build a wrapper comp that renders `srcComp` at (width*scale, height*scale).
    // Source comp is NOT modified. Returns the new CompItem.
    function buildScaledWrapper(srcComp, scale) {
        var newW = Math.max(2, Math.round(srcComp.width  * scale));
        var newH = Math.max(2, Math.round(srcComp.height * scale));
        // Many codecs (H.264, ProRes) require even dimensions.
        if (newW % 2) newW -= 1;
        if (newH % 2) newH -= 1;
        var name = srcComp.name + "_rt_scaled_" + Math.round(scale * 100);
        var wrap = app.project.items.addComp(
            name, newW, newH, srcComp.pixelAspect,
            srcComp.duration, srcComp.frameRate
        );
        var layer = wrap.layers.add(srcComp);
        layer.property("Transform").property("Scale")
            .setValue([scale * 100, scale * 100, 100]);
        // Keep the wrapper's work area matching the source so motion-blur /
        // work-area-based renders behave identically.
        try {
            wrap.workAreaStart    = srcComp.workAreaStart;
            wrap.workAreaDuration = srcComp.workAreaDuration;
        } catch (e) {}
        return wrap;
    }

    log("==== render script start ====");

    var tempWrapperComp = null;   // cleaned up in finally
    try {
        var jobPath = resolveJobPath();
        if (!jobPath) {
            throw new Error("No render-job path available. Expected $.arguments or " + POINTER_PATH);
        }
        log("Using render-job: " + jobPath);

        var job = readJSON(jobPath);
        log("compName=" + job.compName + " versionDir=" + job.versionDir);

        // ---- Ensure the correct AE project is open ----
        if (job.aepPath) {
            var aepFile = new File(job.aepPath);
            if (aepFile.exists) {
                var needOpen = true;
                try {
                    if (app.project && app.project.file) {
                        var cur = app.project.file.fsName.toLowerCase().replace(/\\/g, "/");
                        var tgt = aepFile.fsName.toLowerCase().replace(/\\/g, "/");
                        if (cur === tgt) needOpen = false;
                    }
                } catch (e) {}
                if (needOpen) {
                    log("Opening project: " + aepFile.fsName);
                    app.open(aepFile);
                } else {
                    log("Correct project already open.");
                }
            } else {
                log("WARNING: aepPath does not exist: " + job.aepPath);
            }
        }

        // Locate source comp
        var comp = null;
        for (var i = 1; i <= app.project.items.length; i++) {
            var it = app.project.items[i];
            if (it instanceof CompItem && it.name === job.compName) { comp = it; break; }
        }
        if (!comp) { throw new Error("Comp not found: " + job.compName); }

        var versionDir = new Folder(job.versionDir);
        if (!versionDir.exists) {
            versionDir.create();
            log("Created versionDir: " + versionDir.fsName);
        }
        // Tell the Electron side we're alive and have reached the setup phase.
        // Useful UX: before this, the render pointer flipped and AE spun up —
        // now the user knows AE actually picked up the job.
        writeProgress(job.versionDir, { stage: "preparing", startedAt: Date.now() });

        // ---- Resolve format + scale ----
        var renderFormat = resolveFormat(job);
        var renderScale  = resolveScale(job);
        var fi = FORMAT_INFO[renderFormat];
        var masterExt = fi.ext;
        if (job.masterExt && String(job.masterExt).length > 0) {
            masterExt = String(job.masterExt);
            if (masterExt.charAt(0) !== ".") masterExt = "." + masterExt;
        }
        log("Render format=" + renderFormat
            + " scale=" + renderScale
            + " ext=" + masterExt);

        // ---- Choose render-target comp ----
        var renderComp = comp;
        if (renderScale !== 1.0) {
            tempWrapperComp = buildScaledWrapper(comp, renderScale);
            renderComp = tempWrapperComp;
            log("Scaled wrapper comp: " + tempWrapperComp.name
                + " (" + tempWrapperComp.width + "x" + tempWrapperComp.height + ")");
        } else {
            log("Scale=1.0 — rendering source comp directly");
        }

        // ---- Queue up ----
        var masterBase = (job.masterBasename && String(job.masterBasename).length > 0)
            ? String(job.masterBasename) : "render";
        var rq = app.project.renderQueue;
        var item = rq.items.add(renderComp);

        // Output 1: master
        var om1 = item.outputModule(1);
        applyFormatTemplate(om1, renderFormat);
        om1.file = new File(job.versionDir + "/" + masterBase + masterExt);
        log("Output 1: " + om1.file.fsName);

        // Output 2: preview mp4 (always H.264 built-in; renders at whatever
        // resolution the render-target comp has, which already reflects scale).
        var om2 = item.outputModules.add();
        om2.applyTemplate("H.264 - Match Render Settings - 15 Mbps");
        om2.file = new File(job.versionDir + "/preview.mp4");
        log("Output 2: " + om2.file.fsName);

        // Estimate total frames so the Electron side can compute a rough
        // percentage. Based on work area when present, else full comp.
        var totalFrames = 0;
        try {
            var secs = (renderComp.workAreaDuration > 0)
                ? renderComp.workAreaDuration : renderComp.duration;
            totalFrames = Math.max(1, Math.round(secs * renderComp.frameRate));
        } catch (eTF) { totalFrames = 0; }

        writeProgress(job.versionDir, {
            stage: "rendering",
            totalFrames: totalFrames,
            startedAt: Date.now(),
            version: (function () {
                // Extract vNN from the version dir path for the renderer's
                // status strip ("Rendering v03 · …").
                var m = String(job.versionDir).match(/\/(v\d+)\/?$/);
                return m ? m[1] : null;
            })()
        });

        log("Starting render...");
        rq.render();   // blocking
        log("==== render done OK ====");
        writeProgress(job.versionDir, { stage: "complete", finishedAt: Date.now() });
    } catch (e) {
        log("ERROR: " + e.toString());
        try {
            writeProgress(job.versionDir, { stage: "error", error: e.toString() });
        } catch (_) {}
        alert("Roundtrip render_version error:\n" + e.toString() + "\n\nSee log:\n" + LOG_PATH);
    }

    // Cleanup temporary wrapper comp regardless of render outcome. Leaving it
    // behind would bloat the user's .aep with a new comp every render.
    if (tempWrapperComp) {
        try {
            tempWrapperComp.remove();
            log("Removed temp wrapper comp.");
        } catch (eRem) {
            log("Failed to remove temp wrapper comp: " + eRem.toString());
        }
    }
})();
