// import_clips.jsx — Drop a clip-mode vault asset's files into the
// currently-open AE project. (0.5.0-dev13)
//
// Why this exists: the user's working .aep is already open. They click
// "→ AE" on a clip asset in the vault window. We don't want to spawn a
// new project / new shot — we want the files imported as footage right
// into what they're working on.
//
// Invocation pattern (matches the other AE scripts):
//   pointer file: %TEMP%/roundtrip_current_clipimport.txt
//   AfterFX.exe -r import_clips.jsx
//
// Job JSON keys:
//   assetName  string — used as the Project-panel folder name
//   clips      array of absolute file paths to import
//   doneFlag   absolute path for success sentinel
//   errorFlag  absolute path for failure sentinel
//
// Behavior:
//   * If app.project is null OR has no items, we still proceed — AE
//     auto-creates an Untitled project on importFile, which is fine for
//     a "user opened AE without a project" workflow.
//   * Each file becomes a FootageItem (or a CompItem for layered PSDs
//     imported as Composition — we let AE decide; user gets the standard
//     PSD import dialog if interactive mode is on).
//   * All imports go into a folder named after the asset to keep the
//     Project panel tidy. If a folder with that name already exists, we
//     reuse it.
//
// Done sentinel payload:
//   { ok: true, imported: <int>, projectFile: <string|null> }

(function () {
    var LOG_PATH     = Folder.temp.fsName + "/roundtrip_ae.log";
    var POINTER_PATH = Folder.temp.fsName + "/roundtrip_current_clipimport.txt";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln(new Date().toString() + "  [import_clips] " + msg);
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

    // Find or create a top-level FolderItem with the given name. Keeps the
    // project panel tidy when the user imports the same asset twice.
    function findOrCreateFolder(name) {
        for (var i = 1; i <= app.project.items.length; i++) {
            var it = app.project.items[i];
            if (it instanceof FolderItem && it.parentFolder === app.project.rootFolder && it.name === name) {
                return it;
            }
        }
        return app.project.items.addFolder(name);
    }

    log("==== import_clips start ====");
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
        if (!job.clips || !job.clips.length) throw new Error("clips list empty");

        // app.project is always present in modern AE; importFile creates an
        // Untitled project automatically if there's no current open one.
        var folderName = (job.assetName && String(job.assetName)) || "Vault import";
        // Sanitize folder name — AE accepts most chars but stripping path
        // separators avoids surprises.
        folderName = folderName.replace(/[\\\/]/g, "_");

        app.beginUndoGroup("Chiral: import vault clips");
        var imported = 0;
        var failed   = [];
        try {
            var folder = findOrCreateFolder(folderName);
            for (var i = 0; i < job.clips.length; i++) {
                var fp = String(job.clips[i]);
                var f = new File(fp);
                if (!f.exists) { failed.push({ file: fp, reason: "missing" }); log("Missing: " + fp); continue; }
                try {
                    var opts = new ImportOptions(f);
                    // Layered formats default to footage; we let AE pick the
                    // canForImportAs combination that works. PSD with layers
                    // will auto-import as a single FootageItem (composite).
                    // The user can re-import as Composition manually if they
                    // need layers — we err on the side of "no surprise dialogs".
                    if (opts.canImportAs(ImportAsType.FOOTAGE)) opts.importAs = ImportAsType.FOOTAGE;
                    var item = app.project.importFile(opts);
                    if (item) {
                        try { item.parentFolder = folder; } catch (e) { /* some items refuse, ignore */ }
                        imported++;
                        log("Imported: " + fp);
                    }
                } catch (eImp) {
                    failed.push({ file: fp, reason: eImp.toString() });
                    log("Import failed (" + fp + "): " + eImp.toString());
                }
            }
        } finally {
            try { app.endUndoGroup(); } catch (e) {}
        }

        var pf = null;
        try { pf = app.project.file ? app.project.file.fsName : null; } catch (e) {}

        writeJSON(doneFlag, {
            ok:          true,
            imported:    imported,
            failed:      failed,
            projectFile: pf,
            at:          new Date().toString(),
        });
        log("==== import_clips OK (" + imported + " imported, " + failed.length + " failed) ====");
    } catch (e) {
        log("ERROR: " + e.toString());
        var fallback = Folder.temp.fsName + "/roundtrip_clipimport_error.json";
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
