// probe_comp.jsx — read the currently-open AE composition and write its
// metadata as JSON to %TEMP%\roundtrip_comp_probe.json. The Electron host
// launches this via `AfterFX.exe -r`, polls the sentinel file, parses it,
// and uses the values to build a job.json that matches the existing
// Resolve-origin schema (width/height/fps/markIn/markOut/aepPath/compName).
//
// Same conventions as probe.jsx: never throws across the AE boundary, always
// writes a result object (success OR failure) so the host poller either
// succeeds or times out cleanly.

(function () {
    var SENT = Folder.temp.fsName + "/roundtrip_comp_probe.json";

    function writeResult(obj) {
        var f = new File(SENT);
        f.encoding = "UTF-8";
        if (f.open("w")) {
            f.write(toJSON(obj));
            f.close();
        }
    }

    // Minimal JSON stringifier — ExtendScript lacks JSON.stringify in older
    // AE builds. Good enough for flat objects with string/number/null values.
    function toJSON(v) {
        if (v === null || v === undefined) return "null";
        if (typeof v === "number") return isFinite(v) ? String(v) : "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "string") {
            return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                         .replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
        }
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
            return "[" + parts.join(",") + "]";
        }
        var kvs = [];
        for (var k in v) if (v.hasOwnProperty(k)) kvs.push(toJSON(k) + ":" + toJSON(v[k]));
        return "{" + kvs.join(",") + "}";
    }

    function findActiveComp() {
        // Prefer the currently-selected/active item when it's a comp.
        if (app.project && app.project.activeItem
            && app.project.activeItem instanceof CompItem) {
            return app.project.activeItem;
        }
        // Fall back to the first comp in the project — lets the user probe
        // even when the comp isn't focused in the Project panel.
        if (app.project) {
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if (it instanceof CompItem) return it;
            }
        }
        return null;
    }

    try {
        if (!app.project) {
            writeResult({ ok: false, error: "No AE project is open." });
            return;
        }
        var comp = findActiveComp();
        if (!comp) {
            writeResult({ ok: false, error: "No composition found in the current project. Open a comp and try again." });
            return;
        }
        // aepPath is null when the project has never been saved — the host
        // surfaces this as a user-friendly "save the AE project first" error.
        var aepPath = null;
        if (app.project.file) aepPath = app.project.file.fsName;

        writeResult({
            ok: true,
            name:             comp.name,
            width:            comp.width,
            height:           comp.height,
            fps:              comp.frameRate,
            duration:         comp.duration,
            workAreaStart:    comp.workAreaStart,
            workAreaDuration: comp.workAreaDuration,
            aepPath:          aepPath
        });
    } catch (e) {
        writeResult({ ok: false, error: "probe_comp.jsx: " + e.toString() });
    }
})();
