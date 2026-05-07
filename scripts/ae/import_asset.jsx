// import_asset.jsx — Drop a vault asset's .aep into the currently-open
// AE project as a folder of comps + footage. (0.5.0-dev19)
//
// Why this exists: clip mode (dev13) covers raw files but assets carry
// a full .aep — comps, animation, fonts, plugin chains. For those the
// natural workflow is "I'm in my working .aep and want to bring this
// reusable framework / lower-third / animation into it."
//
// AE's File > Import > File on a .aep does exactly this: it nests the
// imported project under a top-level FolderItem named after the .aep,
// with all comps and footage hung beneath. We do the same call from
// script: app.project.importFile(new ImportOptions(aepFile)).
//
// Symmetric to import_clips.jsx, but a single .aep instead of N files.
//
// Invocation:
//   pointer file: %TEMP%/roundtrip_current_assetimport.txt
//   AfterFX.exe -r import_asset.jsx
//
// Job JSON keys:
//   aepPath    absolute path to the vault asset's .aep
//   assetName  string — used in the log + status sentinel for context
//   doneFlag   absolute path for success sentinel
//   errorFlag  absolute path for failure sentinel
//
// Done sentinel:
//   { ok:true, folderName, projectFile, at }
//   * folderName  the FolderItem AE created (typically the .aep basename)
//   * projectFile fsName of the open project, or null if untitled

(function () {
    var LOG_PATH     = Folder.temp.fsName + "/roundtrip_ae.log";
    var POINTER_PATH = Folder.temp.fsName + "/roundtrip_current_assetimport.txt";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln(new Date().toString() + "  [import_asset] " + msg);
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
        // dev18 #3 — atomic sentinel write. See vault_collect.jsx.
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

    log("==== import_asset start ====");
    log("AE version: " + app.version);

    var doneFlag = null, errorFlag = null;
    try {
        var jobPath = null;
        try {
            if ($.arguments && $.arguments.length > 0 && String($.arguments[0]).length > 0) {
                jobPath = String($.arguments[0]);
            }
        } catch (e) {}
        if (!jobPath) {
            var pointed = readText(POINTER_PATH);
            if (pointed) jobPath = pointed.replace(/^\s+|\s+$/g, "");
        }
        if (!jobPath) throw new Error("No job path available (pointer: " + POINTER_PATH + ")");

        var job = readJSON(jobPath);
        doneFlag  = job.doneFlag;
        errorFlag = job.errorFlag;
        if (!job.aepPath) throw new Error("aepPath missing from job");

        var aepFile = new File(job.aepPath);
        if (!aepFile.exists) throw new Error("Asset .aep not found on disk: " + job.aepPath);

        // app.project is always present in modern AE; importFile auto-creates
        // an Untitled project if there's no current open one. That's the
        // intended fallback for "user opened AE without a project."
        app.beginUndoGroup("Chiral: import vault asset");
        var folderName = null;
        try {
            var opts = new ImportOptions(aepFile);
            // For .aep files, AE always interprets as PROJECT — there's no
            // other valid mode. We don't set importAs explicitly because
            // the enum value differs across CC versions and the default is
            // correct anyway.
            var imported = app.project.importFile(opts);
            if (imported && imported.name) {
                folderName = imported.name;
                log("Imported as folder: " + folderName);
            } else {
                log("importFile returned null/unnamed — proceeding anyway");
            }
        } finally {
            try { app.endUndoGroup(); } catch (e) {}
        }

        var pf = null;
        try { pf = app.project.file ? app.project.file.fsName : null; } catch (e) {}

        writeJSON(doneFlag, {
            ok:          true,
            folderName:  folderName,
            projectFile: pf,
            assetName:   job.assetName || null,
            at:          new Date().toString(),
        });
        log("==== import_asset OK ====");
    } catch (e) {
        log("ERROR: " + e.toString());
        var fallback = Folder.temp.fsName + "/roundtrip_assetimport_error.json";
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
