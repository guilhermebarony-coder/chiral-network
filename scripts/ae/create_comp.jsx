// create_comp.jsx
// Preferred invocation: Electron writes job path to %TEMP%\roundtrip_current_job.txt,
// then runs:  AfterFX.exe -r create_comp.jsx
//
// Also accepts a command-line arg via $.arguments as a fallback (unreliable across AE versions).
//
// Project isolation: each shot has its own .aep file.
//   * If job.aepPath already exists on disk -> app.open() that project.
//   * Otherwise -> app.newProject(), import reference, create comp, save to job.aepPath.
// This guarantees switching shots in the Electron UI always opens the correct
// isolated AE project without mixing assets across shots.
//
// job.json keys:
//   shot            e.g. "Shot_012"
//   width, height   integers
//   fps             number
//   duration        seconds
//   referencePath   absolute path to reference.mp4  (forward slashes)
//   aepPath         absolute path where the .aep will be saved

(function () {
    var LOG_PATH = Folder.temp.fsName + "/roundtrip_ae.log";
    var POINTER_PATH = Folder.temp.fsName + "/roundtrip_current_job.txt";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln(new Date().toString() + "  [create_comp] " + msg);
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

    function resolveJobPath() {
        // 1. Try $.arguments (works on some AE versions with `-r script arg`)
        try {
            if ($.arguments && $.arguments.length > 0) {
                var a = String($.arguments[0]);
                if (a && a.length > 0) {
                    log("Got job path from $.arguments: " + a);
                    return a;
                }
            }
        } catch (e) { log("$.arguments read failed: " + e.toString()); }

        // 2. Fallback: pointer file written by Electron
        log("Falling back to pointer file: " + POINTER_PATH);
        var pointed = readText(POINTER_PATH);
        if (pointed !== null) {
            pointed = pointed.replace(/^\s+|\s+$/g, "");  // trim
            if (pointed.length > 0) {
                log("Got job path from pointer file: " + pointed);
                return pointed;
            }
        }
        return null;
    }

    log("==== script start ====");
    log("AE version: " + app.version);

    try {
        var jobPath = resolveJobPath();
        if (!jobPath) {
            throw new Error("No job path available. Expected $.arguments or " + POINTER_PATH);
        }
        log("Using job path: " + jobPath);

        var job = readJSON(jobPath);
        log("Job loaded. shot=" + job.shot + " " + job.width + "x" + job.height +
            " @ " + job.fps + " fps, dur=" + job.duration + "s");
        log("referencePath=" + job.referencePath);
        log("aepPath=" + job.aepPath);

        var aepFile = new File(job.aepPath);

        // ---- Project isolation ------------------------------------------------
        if (aepFile.exists) {
            // .aep already exists — open it. This is the normal case after the
            // first "Send to AE"; the user's work (layers, effects, expressions)
            // is preserved.
            log("AEP exists — opening: " + aepFile.fsName);

            // Check if this project is already the active one (same file path).
            var alreadyOpen = false;
            try {
                if (app.project && app.project.file) {
                    var currentPath = app.project.file.fsName.toLowerCase()
                        .replace(/\\/g, "/");
                    var targetPath  = aepFile.fsName.toLowerCase()
                        .replace(/\\/g, "/");
                    alreadyOpen = (currentPath === targetPath);
                }
            } catch (e) {}

            if (alreadyOpen) {
                log("Project already open — nothing to do.");
            } else {
                // app.open prompts to save if the current project has unsaved
                // changes. That's the desired UX — user decides.
                app.open(aepFile);
                log("Opened project: " + aepFile.fsName);
            }

            // Find and open the shot comp in a viewer for convenience.
            for (var i = 1; i <= app.project.items.length; i++) {
                var it = app.project.items[i];
                if (it instanceof CompItem && it.name === String(job.shot)) {
                    it.openInViewer();
                    log("Opened comp in viewer: " + it.name);
                    break;
                }
            }

            log("==== script done OK (opened existing) ====");
        } else {
            // .aep does not exist — fresh shot. Create a brand-new project so we
            // don't pollute whatever is currently open in AE.
            log("AEP does not exist — creating new project.");

            // Verify reference
            var refFile = new File(job.referencePath);
            if (!refFile.exists) {
                throw new Error("Reference not found: " + job.referencePath);
            }

            // Save current project if it has unsaved changes (app.newProject()
            // would discard them silently in some AE versions). The prompt gives
            // the user a chance to save their work.
            if (app.project && app.project.file && app.project.dirty) {
                log("Current project has unsaved changes — AE will prompt to save.");
            }

            app.newProject();
            log("New project created.");

            app.beginUndoGroup("Roundtrip: create shot comp");

            // Import reference footage
            var io = new ImportOptions(refFile);
            var footage = app.project.importFile(io);
            log("Imported footage: " + footage.name);

            // Build comp matching the Resolve timeline
            var comp = app.project.items.addComp(
                String(job.shot),
                parseInt(job.width, 10),
                parseInt(job.height, 10),
                1.0,                        // pixel aspect
                parseFloat(job.duration),
                parseFloat(job.fps)
            );
            comp.layers.add(footage);
            comp.openInViewer();
            log("Comp created: " + comp.name);

            // Ensure ae/ folder exists and save
            var parent = aepFile.parent;
            if (!parent.exists) {
                parent.create();
                log("Created folder: " + parent.fsName);
            }
            app.project.save(aepFile);
            log("Project saved: " + aepFile.fsName);

            app.endUndoGroup();
            log("==== script done OK (new project) ====");
        }
    } catch (e) {
        log("ERROR: " + e.toString());
        try { app.endUndoGroup(); } catch (ee) {}
        alert("Roundtrip create_comp error:\n" + e.toString() + "\n\nSee log:\n" + LOG_PATH);
    }
})();
