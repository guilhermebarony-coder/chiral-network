// probe.jsx — Readiness probe for After Effects scripting engine.
// Electron dispatches this via  AfterFX.exe -r probe.jsx  in a loop until the
// sentinel file appears, proving AE's ExtendScript engine is alive and able to
// execute scripts. The sentinel is deleted by the caller after each check.
(function () {
    try {
        var f = new File(Folder.temp.fsName + "/ae_ready_probe.txt");
        f.open("w");
        f.write("ok");
        f.close();
    } catch (e) {}
})();
