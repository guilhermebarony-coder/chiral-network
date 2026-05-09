# -*- coding: utf-8 -*-
# relink_latest_render.py — Chiral Network — AE→Resolve relink bridge.
# After Effects just finished rendering a new version of a shot.
# This script updates the Resolve timeline so it plays the latest render.mov.
#
# Python compatibility: 3.10 .. 3.13. See chiral_version.py for the rationale
# and export_range.py's _check_python_version() for the runtime warning.
# This script doesn't pop dialogs (it runs detached), so the version warning
# only appears in the relink.log; the Electron side reports failures via
# the .relink.json result file regardless of interpreter version.
#
# Invocation (from Electron):
#   py relink_latest_render.py "F:/CLAUDE/roundtrip_root/projects/demo/Shot_013"
#   py relink_latest_render.py "F:/CLAUDE/roundtrip_root/projects/demo/Shot_013" v02
# Optional second arg pins the relink to a specific version (used by the
# "Set Active Version" button). Without it, the newest version wins.
#
# Required env vars (set by Electron before spawn):
#   RESOLVE_SCRIPT_API = C:/ProgramData/Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting
#   RESOLVE_SCRIPT_LIB = C:/Program Files/Blackmagic Design/DaVinci Resolve/fusionscript.dll
#   PYTHONPATH        += %RESOLVE_SCRIPT_API%/Modules
#
# First render for a shot:
#   * imports renders/vNN/<master> into the Media Pool
#     (master is .mov for fast/final or .mp4 for superfast)
#   * inserts on V<resolveTrackIndex> at frame <markIn>
#   * stores the MediaPoolItem unique ID in job.json
#
# Subsequent renders:
#   * finds the MediaPoolItem by its stored unique ID
#   * calls ReplaceClip(newPath); every timeline instance rebinds automatically
#
# Timeline color coding (applied after each relink, keyed by quality tier):
#   Orange = DRAFT   (any format at < 100% scale)
#   Yellow = PREVIEW (MP4 @ 100%)
#   Green  = HIGH    (ProRes 422 LT @ 100%)
#   Lime   = FINAL   (ProRes 4444 @ 100%)

import os
import sys
import json
import time
import traceback

# dev57 — make the script's own directory importable. Under the vendored
# Python embeddable's `_pth` regime, sys.path is FROZEN to what's listed in
# python310._pth (`python310.zip` + `.` = vendor/python/). The script's
# OWN directory (resources/scripts/resolve/) is NOT auto-prepended like a
# normal `python foo.py` invocation would, so `from chiral_version import
# ...` silently fails and the banner reads `vunknown`. Inserting __file__'s
# dir at index 0 fixes both: the version banner now reflects the actual
# build, AND any future sibling helpers we add to scripts/resolve/ become
# importable without touching the embeddable layout.
try:
    _SELF_DIR = os.path.dirname(os.path.abspath(__file__))
    if _SELF_DIR and _SELF_DIR not in sys.path:
        sys.path.insert(0, _SELF_DIR)
except Exception:
    pass

# Optional sibling. See export_range.py for the same try/except pattern —
# Resolve's Utility folder install copies scripts individually and we want
# the relink to keep working even if chiral_version.py wasn't copied along.
try:
    from chiral_version import SCRIPT_VERSION, PY_MIN, PY_MAX
except Exception:
    SCRIPT_VERSION = "unknown"
    PY_MIN = (3, 10)
    PY_MAX = (3, 10)


# Shared with export_range.py — parse "HH:MM:SS:FF" (or drop-frame "HH:MM:SS;FF")
# to an absolute frame count. Returns None on any parse failure so callers can
# fall through to alternate playhead-detection paths without crashing.
def _parse_timecode_to_frame(tc, fps):
    if not tc or not isinstance(tc, str):
        return None
    try:
        parts = tc.replace(";", ":").split(":")
        if len(parts) != 4:
            return None
        h, m, s, f = [int(p) for p in parts]
        fps_int = int(round(float(fps)))
        if fps_int <= 0:
            return None
        return ((h * 3600) + (m * 60) + s) * fps_int + f
    except Exception:
        return None


def _playhead_frame(timeline, fps):
    """Best-effort: return the current playhead as an absolute frame on the
    timeline. Returns None if Resolve refuses to report a timecode."""
    try:
        tc = timeline.GetCurrentTimecode()
    except Exception:
        tc = None
    frame = _parse_timecode_to_frame(tc, fps) if tc else None
    if frame is None:
        return None
    # Resolve timecodes are absolute (they include GetStartFrame offset), so
    # we don't subtract anything — AppendToTimeline also expects an absolute
    # recordFrame. Keep this comment honest if Resolve ever changes behavior.
    return frame

# Log goes to %APPDATA%/<app>/logs/ when available (so packaged installs
# don't need to write into Program Files). We try the current app name
# ("Chiral Network" — Electron's post-rebrand productName) first, then
# the legacy "Roundtrip" folder, and finally a per-user Documents fallback.
# We deliberately do NOT fall back to a hardcoded "F:\..." dev-machine path,
# which used to break every tester whose machine lacked that drive.
_CONFIG_DIR_CANDIDATES = ("Chiral Network", "Roundtrip")


def _safe_default_log_dir():
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.join(home, "Documents", "Chiral Network", "logs")


def _resolve_log_path(name):
    appdata = os.environ.get("APPDATA")
    if appdata:
        for sub in _CONFIG_DIR_CANDIDATES:
            d = os.path.join(appdata, sub, "logs")
            try:
                os.makedirs(d, exist_ok=True)
                return os.path.join(d, name)
            except Exception:
                continue
    d = _safe_default_log_dir()
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return os.path.join(d, name)


LOG_PATH = _resolve_log_path("relink.log")
FAULTHANDLER_PATH = _resolve_log_path("relink.faulthandler.log")

# dev62 — keepalive list for the System32 CRT WinDLL handles we pre-load
# in get_resolve(). Without a reference here, Python's GC would
# finalize the WinDLL wrapper -> call FreeLibrary -> potentially unmap
# the CRT before fusionscript's late-binding imports resolve. Module-
# global list keeps them alive for the process's lifetime.
_CRT_KEEPALIVE = []


# dev57 — enable faulthandler. After dev55 confirmed `ctypes preload OK`
# and dev56 enabled `import site` in the embeddable's _pth, rafag's log
# STILL stops dead at "About to import DaVinciResolveScript..." with no
# Python traceback. That's not a Python exception (would be caught and
# logged); it's a C-level abort inside fusionscript's PyInit callback,
# triggered by importlib loading the .pyd-equivalent module entry point.
# Python's regular try/except can't see it. faulthandler installs Win32
# / POSIX signal handlers that dump a Python+C traceback to a file just
# before the process dies — exactly the missing diagnostic. The handle
# must stay open for the lifetime of the process; we keep the module-
# global reference alive via _FAULTHANDLER_FH.
_FAULTHANDLER_FH = None
try:
    import faulthandler
    try:
        os.makedirs(os.path.dirname(FAULTHANDLER_PATH), exist_ok=True)
    except Exception:
        pass
    try:
        _FAULTHANDLER_FH = open(FAULTHANDLER_PATH, "w", encoding="utf-8")
        faulthandler.enable(file=_FAULTHANDLER_FH, all_threads=True)
    except Exception:
        # Fall back to stderr — better than nothing if the file open
        # itself fails. Some testers will have stderr captured by
        # Electron and we'll still see the dump there.
        try:
            faulthandler.enable(all_threads=True)
        except Exception:
            pass
except Exception:
    # faulthandler is part of the stdlib in 3.3+, but if for any reason
    # the import fails we don't want to break the entire script — the
    # dev54/55 instrumentation still narrows the failure window.
    pass


def log(msg):
    line = "[{}] {}".format(time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line)
        sys.stdout.flush()
    except Exception:
        pass


def _log_import_diagnostics():
    """Dump the Python environment that's about to attempt `import
    DaVinciResolveScript`. Runs ONLY when we're taking the detached-spawn
    path (no injected `resolve` global) so Resolve-hosted runs stay quiet.
    When the import subsequently fails, the log tells us exactly why —
    which Python, which sys.path, which env vars, whether the .py file
    is reachable from those entries. dev7 — added after a Studio 21 beta
    install surfaced `No module named 'DaVinciResolveScript'` despite the
    wizard reporting the SDK as present."""
    try:
        log("---- Python import diagnostics ----")
        log("sys.executable: " + str(sys.executable))
        log("sys.version:    " + str(sys.version).replace("\n", " "))
        log("sys.platform:   " + str(sys.platform))
        api = os.environ.get("RESOLVE_SCRIPT_API") or "(unset)"
        lib = os.environ.get("RESOLVE_SCRIPT_LIB") or "(unset)"
        pp  = os.environ.get("PYTHONPATH")         or "(unset)"
        log("RESOLVE_SCRIPT_API: " + api)
        log("RESOLVE_SCRIPT_LIB: " + lib)
        log("PYTHONPATH:         " + pp)
        log("sys.path (count={0}):".format(len(sys.path)))
        for i, p in enumerate(sys.path):
            log("  [{0}] {1}".format(i, p))
        # Probe for the actual wrapper .py file on each sys.path entry so we
        # can see if it's reachable or not.
        found = []
        for p in sys.path:
            if not p:
                continue
            cand = os.path.join(p, "DaVinciResolveScript.py")
            if os.path.isfile(cand):
                found.append(cand)
        if found:
            log("DaVinciResolveScript.py found on sys.path:")
            for f in found: log("  -> " + f)
        else:
            log("DaVinciResolveScript.py NOT found on any sys.path entry.")
        # If RESOLVE_SCRIPT_API is set, explicitly check Modules/ under it.
        if api != "(unset)":
            expected = os.path.join(api, "Modules", "DaVinciResolveScript.py")
            log("Expected path: " + expected + " exists=" + str(os.path.isfile(expected)))
        log("-----------------------------------")
    except Exception as _diag_e:
        log("diagnostics failed: " + str(_diag_e))


def get_resolve():
    injected = globals().get("resolve")
    if injected is not None:
        return injected
    _log_import_diagnostics()
    # Belt-and-braces: even though Electron sets PYTHONPATH before spawning,
    # on some Windows configs the env var gets mangled (detached-spawn stderr
    # redirection, unicode path quirks, conflicting system PYTHONPATH). If
    # RESOLVE_SCRIPT_API is set but the Modules dir isn't on sys.path, add it
    # now so the import below can succeed on the retry. dev7 — added after a
    # Studio 21 beta machine hit "No module named 'DaVinciResolveScript'"
    # despite the SDK existing and the env var being set correctly.
    api = os.environ.get("RESOLVE_SCRIPT_API")
    if api:
        mod_dir = os.path.join(api, "Modules")
        if os.path.isfile(os.path.join(mod_dir, "DaVinciResolveScript.py")) and mod_dir not in sys.path:
            log("Injecting into sys.path: " + mod_dir)
            sys.path.insert(0, mod_dir)
    # dev53 (instrumented in dev54) — register the Resolve install
    # directory with the Windows DLL loader BEFORE importing
    # fusionscript. dev53's fix was structurally right but had silent
    # skip paths (lib unset / dir doesn't exist) that masked configs
    # where RESOLVE_SCRIPT_LIB simply pointed at the wrong location.
    # dev54: log every check unconditionally so the log file always
    # tells us WHY add_dll_directory was or wasn't called, AND fail
    # loudly upfront if the LIB path doesn't actually exist on disk
    # — that's a config bug, not a load-time mystery, and surfacing
    # it now beats letting it become a "module not found" later.
    lib = os.environ.get("RESOLVE_SCRIPT_LIB")
    log("DLL search check: lib={!r} platform={} has_add_dll_dir={}".format(
        lib, sys.platform, hasattr(os, "add_dll_directory")))
    if lib and not os.path.isfile(lib):
        # Hard-fail: every downstream symptom (DLL load failed,
        # cryptic ERROR_MOD_NOT_FOUND, silent process abort) is
        # really just "the .dll isn't where we said it would be".
        # Crashing with a clear error means the Electron side reports
        # a usable message instead of pointing the tester at the same
        # log they're already staring at.
        raise RuntimeError(
            "RESOLVE_SCRIPT_LIB points at a file that does not exist: "
            + lib + ". Resolve may be installed under a different drive "
            "or path. Run the Setup Wizard's Repair installation step, "
            "or set RESOLVE_SCRIPT_LIB manually to the real path of "
            "fusionscript.dll on this machine."
        )
    if lib and sys.platform == "win32" and hasattr(os, "add_dll_directory"):
        resolve_dir = os.path.dirname(lib)
        log("DLL search resolve_dir={!r} isdir={}".format(
            resolve_dir, os.path.isdir(resolve_dir) if resolve_dir else False))
        if resolve_dir and os.path.isdir(resolve_dir):
            try:
                os.add_dll_directory(resolve_dir)
                log("Added DLL search directory: " + resolve_dir)
            except Exception as e:
                log("add_dll_directory failed (non-fatal): " + str(e))
        else:
            log("Skipping add_dll_directory: resolve_dir not a directory.")
    else:
        log("Skipping add_dll_directory: precondition false "
            "(lib set={}, win32={}, has_attr={}).".format(
                bool(lib), sys.platform == "win32",
                hasattr(os, "add_dll_directory")))

    # dev62 — System32 CRT pre-load. dev61's chiral_diag captured rafag's
    # loaded-modules table at crash time and revealed the actual cause:
    # fusionscript's PyInit ended up with TWO copies of vcruntime140_1.dll
    # mapped into the same process — one from System32 (48 KB, full
    # surface) and one from Resolve's install dir (28 KB, stripped).
    # `MSVCP140.dll` showed the same pattern, loaded from Resolve's dir
    # only with no System32 backstop. The dual / wrong-CRT state breaks
    # C++ ABI assumptions in fusionscript's static initializers and
    # PyInit_fusionscript dereferences corrupted CRT globals -> AV.
    #
    # Root mechanism: dev53's add_dll_directory(resolve_dir) plus dev55's
    # LOAD_WITH_ALTERED_SEARCH_PATH bias the loader toward Resolve's dir
    # for fusionscript's own dependencies. Resolve happens to bundle its
    # own copies of the CRT DLLs in its install folder; those got
    # picked up before System32's canonical copies.
    #
    # Fix: explicitly LoadLibrary the System32 CRT DLLs by absolute path
    # FIRST, into the python.exe process. Once they're in, the loader's
    # short-name dedupe means any later LoadLibrary("vcruntime140_1.dll")
    # — including the implicit ones from fusionscript's import table —
    # returns the existing System32-backed handle. Resolve's bundled
    # versions never get loaded.
    #
    # tbbmalloc.dll and lua5.1.dll (Resolve-only deps fusionscript also
    # imports) are unaffected: they're not in System32, so the
    # add_dll_directory(resolve_dir) path still finds them in Resolve's
    # install folder when fusionscript tries to bind them. We're only
    # pre-loading the CRTs, not all of Resolve's deps.
    if sys.platform == "win32":
        try:
            import ctypes as _c
            sys32 = os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"), "System32")
            crt_names = (
                "vcruntime140.dll",
                "vcruntime140_1.dll",
                "msvcp140.dll",
                "msvcp140_1.dll",
                "msvcp140_2.dll",
                "concrt140.dll",
            )
            log("CRT pre-load from " + sys32 + ":")
            for n in crt_names:
                full = os.path.join(sys32, n)
                if not os.path.isfile(full):
                    log("  skip {} (not present in System32)".format(n))
                    continue
                try:
                    h = _c.WinDLL(full)
                    log("  ok   {}".format(n))
                    # Hold a reference on the WinDLL object via a module-
                    # global list so Python doesn't GC it and trigger a
                    # FreeLibrary before fusionscript binds. WinDLL's
                    # FreeLibrary fires on object finalization; keeping
                    # the references alive for the lifetime of the
                    # process is the cheapest way to lock in our pre-load.
                    _CRT_KEEPALIVE.append(h)
                except OSError as e:
                    log("  FAIL {} ({})".format(n, e))
        except Exception as e:
            log("CRT pre-load step crashed (non-fatal): " + str(e))

    # dev55 — ctypes pre-load diagnostic. The dev53/54 path got us as
    # far as "About to import DaVinciResolveScript..." on rafag's
    # machine — and then the log just stopped dead. No traceback, no
    # FATAL line. That's not an ImportError Python could catch; it's
    # the host process being terminated by Windows itself (DllMain
    # returning FALSE, an unresolvable runtime dependency triggering
    # FatalAppExit, AV intervention, or a similar process-level
    # abort).
    #
    # We try to load fusionscript.dll directly via kernel32's
    # LoadLibraryExW BEFORE the importlib path. Two outcomes both
    # buy us information:
    #   * The load FAILS but returns NULL → ctypes.GetLastError() gives
    #     the real Win32 error code (ERROR_MOD_NOT_FOUND=126,
    #     DLL_INIT_FAILED=1114, etc.). We log it and the import below
    #     will fail too with a now-explicable message.
    #   * The load HARD-CRASHES → the log still records "Trying ctypes
    #     preload of: <path>" right before the abort, pinpointing the
    #     load itself rather than Python's import machinery.
    #
    # Note: a successful preload DOESN'T short-circuit the importlib
    # path that follows. Once fusionscript is mapped into the process,
    # importlib will reuse the existing handle on its next attempt.
    if lib and sys.platform == "win32" and os.path.isfile(lib):
        try:
            import ctypes
            from ctypes import wintypes
            log("Trying ctypes preload of: " + lib)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
            kernel32.LoadLibraryExW.restype  = wintypes.HMODULE
            # LOAD_WITH_ALTERED_SEARCH_PATH (0x08) tells the loader to
            # treat the .dll's own directory as the start of the search
            # path for its dependencies — same effective behavior as the
            # add_dll_directory call above, but expressed through the
            # explicit-load API so we get an error code on failure.
            LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008
            handle = kernel32.LoadLibraryExW(lib, None, LOAD_WITH_ALTERED_SEARCH_PATH)
            if not handle:
                err = ctypes.get_last_error()
                try:
                    msg = str(ctypes.WinError(err))
                except Exception:
                    msg = "WinError unavailable"
                log("ctypes preload FAILED: error code {} ({})".format(err, msg))
            else:
                log("ctypes preload OK: handle=0x{:x}".format(handle))
        except Exception as e:
            log("ctypes preload exception (non-fatal): " + str(e))

    # dev61 — pre-import diagnostics. dev57's faulthandler captured the
    # C-frame of the access violation inside fusionscript's PyInit
    # (load_dynamic -> create_module). What we lacked until now was the
    # *environment* the crash is happening in — which DLLs fusionscript
    # actually wants, what's loaded into our python.exe at that instant,
    # whether Resolve is even running, what AV is sitting in the loader
    # path. chiral_diag.run_all() captures all of it before the import,
    # writing to relink.log under the same `log` callable. Wrapped in a
    # try/except so a probe failure can never block the relink.
    try:
        import chiral_diag
        chiral_diag.run_all(lib, log)
    except Exception as _diag_err:
        log("chiral_diag failed: " + str(_diag_err))

    log("About to import DaVinciResolveScript...")
    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except ImportError as e:
        # NOTE: use .format() not %-formatting — the message contains literal
        # %RESOLVE_SCRIPT_API% env-var syntax, and %-formatting chokes on the
        # %R with "unsupported format character 'R' (0x52)" which hides the
        # real error. Regression dev4 hotfix.
        raise RuntimeError(
            "DaVinciResolveScript not importable. Set RESOLVE_SCRIPT_API, "
            "RESOLVE_SCRIPT_LIB and add %RESOLVE_SCRIPT_API%/Modules to "
            "PYTHONPATH before launching. ({0}). "
            "See %APPDATA%/Chiral Network/logs/relink.log for sys.path dump."
            .format(e)
        )
    log("DaVinciResolveScript imported OK")
    log("About to call dvr.scriptapp('Resolve')...")
    r = dvr.scriptapp("Resolve")
    log("scriptapp returned: " + ("None" if r is None else "<Resolve handle>"))
    if r is None:
        raise RuntimeError("scriptapp('Resolve') returned None — Resolve not running?")
    return r


def read_job(shot_dir):
    jp = os.path.join(shot_dir, "source", "job.json")
    with open(jp, "r", encoding="utf-8") as f:
        return jp, json.load(f)


def write_job(job_path, job):
    # Atomic write — matches the Electron side's writeJob(). Without this,
    # a power loss or Resolve crash between open() and close() could leave
    # job.json half-truncated and unreadable on the next launch.
    tmp = job_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(job, f, indent=2)
        try:
            f.flush()
            os.fsync(f.fileno())
        except Exception:
            pass  # best-effort; some FS don't support fsync
    os.replace(tmp, job_path)


def write_relink_result(shot_dir, result):
    """Write .relink.json alongside source/ so the Electron side can read
    the real outcome of this detached spawn. runRelink() in main.js polls
    for this file for ~6s; absence is reported as a timeout.
    Atomic write so Electron never reads a partial file."""
    p = os.path.join(shot_dir, ".relink.json")
    tmp = p + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
            try:
                f.flush()
                os.fsync(f.fileno())
            except Exception:
                pass
        os.replace(tmp, p)
    except Exception as e:
        # Logging only — if we can't write the result file, Electron will
        # report "timeout" which is the honest fallback.
        log("write_relink_result failed: " + str(e))


def latest_render(shot_dir, version_override=None):
    """Return (version_name, abs_path_to_mov).
    If version_override is given (e.g. 'v02'), pin to that version.
    Otherwise pick the newest vNN with a .mov."""
    renders_dir = os.path.join(shot_dir, "renders")
    if not os.path.isdir(renders_dir):
        return None, None
    if version_override:
        v = version_override
        if not os.path.isdir(os.path.join(renders_dir, v)):
            return v, None
    else:
        versions = sorted([n for n in os.listdir(renders_dir)
                           if os.path.isdir(os.path.join(renders_dir, n))
                           and n.startswith("v") and n[1:].isdigit()])
        if not versions:
            return None, None
        v = versions[-1]
    vdir = os.path.join(renders_dir, v)
    # Prefer legacy render.mov; otherwise any master-shaped file:
    #   * .mov = ProRes 422 LT (fast) or 4444 (final)
    #   * .mp4 = H.264 (superfast); preview.mp4 is never a master.
    legacy = os.path.join(vdir, "render.mov")
    if os.path.exists(legacy):
        return v, legacy
    names = os.listdir(vdir)
    movs = [n for n in names if n.lower().endswith(".mov")]
    if movs:
        return v, os.path.join(vdir, movs[0])
    mp4s = [n for n in names
            if n.lower().endswith(".mp4") and n.lower() != "preview.mp4"]
    if mp4s:
        return v, os.path.join(vdir, mp4s[0])
    return v, None


def ensure_folder_path(media_pool, parts):
    """Ensure nested folder path under Media Pool root; return the final Folder."""
    current = media_pool.GetRootFolder()
    for part in parts:
        if not part:
            continue
        found = None
        subs = current.GetSubFolderList() or []
        for sub in subs:
            try:
                if sub.GetName() == part:
                    found = sub
                    break
            except Exception:
                continue
        if not found:
            log("Creating Media Pool folder: " + "/".join(parts[:parts.index(part)+1]))
            found = media_pool.AddSubFolder(current, part)
        current = found
    return current


def import_into(media_pool, folder, paths):
    """Import paths into a specific Media Pool folder. Restores previous focus."""
    prev = None
    try:
        prev = media_pool.GetCurrentFolder()
    except Exception:
        prev = None
    try:
        if folder is not None:
            media_pool.SetCurrentFolder(folder)
        return media_pool.ImportMedia(paths)
    finally:
        try:
            if prev is not None:
                media_pool.SetCurrentFolder(prev)
        except Exception:
            pass


def walk_media_pool_items(folder):
    """Yield every MediaPoolItem under a MediaPool folder, recursively."""
    try:
        for clip in folder.GetClipList() or []:
            yield clip
    except Exception:
        pass
    try:
        for sub in folder.GetSubFolderList() or []:
            for clip in walk_media_pool_items(sub):
                yield clip
    except Exception:
        pass


def find_mpi_by_id(media_pool, target_id):
    if not target_id:
        return None
    root = media_pool.GetRootFolder()
    for clip in walk_media_pool_items(root):
        try:
            if str(clip.GetUniqueId()) == str(target_id):
                return clip
        except Exception:
            continue
    return None


def ensure_timeline(project, timeline_name):
    current = project.GetCurrentTimeline()
    if current is not None and current.GetName() == timeline_name:
        return current
    count = project.GetTimelineCount()
    for i in range(1, count + 1):
        tl = project.GetTimelineByIndex(i)
        if tl is not None and tl.GetName() == timeline_name:
            project.SetCurrentTimeline(tl)
            return tl
    return current   # fallback to whatever is open


def append_to_v2(media_pool, mpi, fps, record_frame, track_index, duration_frames):
    """Insert mpi onto the given track at record_frame for duration_frames.
    Returns a list of TimelineItem handles for the newly-placed clip(s), or []."""
    # Resolve uses mediaType=1 for video, 2 for audio.
    clip_info = {
        "mediaPoolItem": mpi,
        "startFrame":    0,
        "endFrame":      max(0, duration_frames - 1),
        "mediaType":     1,
        "trackIndex":    int(track_index),
        "recordFrame":   int(record_frame),
    }
    result = media_pool.AppendToTimeline([clip_info])
    log("AppendToTimeline result: " + str(result))
    # AppendToTimeline returns list[TimelineItem] on success, False/None on fail.
    if isinstance(result, list):
        return result
    return []


# ---- Format / scale detection from master filename -----------------------
# New convention: ..._<fmt>_s<NN>.<ext>   where fmt is mp4|422|4444
#   and NN is 25|50|75|100.
# Legacy: _superfast -> (mp4, 50), _fast -> (422, 50), no suffix -> (4444, 100).
import re as _re

def spec_from_render(path):
    """Return (format, scale) for a master render file.
    format: 'mp4' | 'prores_422' | 'prores_4444'
    scale:  0.25 .. 1.0"""
    if not path:
        return "prores_4444", 1.0
    base = os.path.splitext(os.path.basename(path))[0].lower()
    # New convention: ..._<fmt>_s<NN>
    m = _re.search(r"_(mp4|422|4444)_s(\d{2,3})$", base)
    if m:
        tok = m.group(1)
        fmt = {"mp4": "mp4", "422": "prores_422", "4444": "prores_4444"}[tok]
        scale = max(0.01, min(1.0, int(m.group(2)) / 100.0))
        return fmt, scale
    # Legacy suffixes
    if base.endswith("_superfast"):
        return "mp4", 0.5
    if base.endswith("_fast"):
        return "prores_422", 0.5
    return "prores_4444", 1.0


def format_from_render(path):
    """Return render format string (back-compat helper)."""
    return spec_from_render(path)[0]


# Semantic quality tier — scale takes priority over codec:
#   scale < 100%            -> 'draft'    (Orange)
#   4444 @ 100%             -> 'final'    (Lime)
#   422 @ 100%              -> 'high'     (Green)
#   mp4 @ 100%              -> 'preview'  (Yellow)
def quality_tier(fmt, scale):
    if scale < 0.999:
        return "draft"
    if fmt == "prores_4444":
        return "final"
    if fmt == "prores_422":
        return "high"
    return "preview"


def is_fast_render(path):
    """Kept for any external caller — True if the render is not final quality."""
    fmt, scale = spec_from_render(path)
    return quality_tier(fmt, scale) != "final"


# Resolve clip colors keyed by tier (spelling must exactly match Resolve UI).
_COLOR_BY_TIER = {
    "draft":   "Orange",
    "preview": "Yellow",
    "high":    "Green",
    "final":   "Lime",
}


def color_for_render(path):
    fmt, scale = spec_from_render(path)
    tier = quality_tier(fmt, scale)
    return _COLOR_BY_TIER.get(tier, "Lime")


def find_timeline_items_for_mpi(timeline, mpi):
    """Walk every video track and yield TimelineItems whose MediaPoolItem
    matches mpi. ReplaceClip rebinds all of them at once, so we need to
    repaint every instance — not just the first."""
    if timeline is None or mpi is None:
        return
    try:
        target_id = str(mpi.GetUniqueId())
    except Exception:
        target_id = None
    try:
        n = int(timeline.GetTrackCount("video") or 0)
    except Exception:
        n = 0
    for ti_index in range(1, n + 1):
        try:
            items = timeline.GetItemListInTrack("video", ti_index) or []
        except Exception:
            items = []
        for ti in items:
            try:
                ti_mpi = ti.GetMediaPoolItem()
                if ti_mpi is None:
                    continue
                if target_id and str(ti_mpi.GetUniqueId()) == target_id:
                    yield ti
                elif target_id is None and ti_mpi == mpi:
                    yield ti
            except Exception:
                continue


def apply_color_to_items(items, color):
    """Set SetClipColor on each item. Never raises — failures are logged."""
    count = 0
    for ti in items or []:
        try:
            if ti.SetClipColor(color):
                count += 1
            else:
                log("SetClipColor('%s') returned False on one item" % color)
        except Exception as e:
            log("SetClipColor error: " + str(e))
    log("Colored %d timeline item(s) -> %s" % (count, color))
    return count


def _check_python_version():
    """Mirror of export_range._check_python_version. See chiral_version.py
    for the supported range and the rationale for warning-not-failing."""
    v = sys.version_info
    line = "Python {}.{}.{} ({})".format(v.major, v.minor, v.micro, sys.executable)
    if (v.major, v.minor) < PY_MIN or (v.major, v.minor) > PY_MAX:
        log("WARNING: %s outside Chiral Network's tested Python range "
            "%d.%d..%d.%d." % (line, PY_MIN[0], PY_MIN[1], PY_MAX[0], PY_MAX[1]))
    else:
        log(line + " — within supported range.")


def main(ctx):
    log("==== relink_latest_render START (Chiral Network scripts v%s) ====" % SCRIPT_VERSION)
    _check_python_version()

    # Accept --at-playhead and --force-reconnect anywhere in argv.
    # Positional args: <shot_dir> [versionName].
    # --force-reconnect: overflow-menu "Force relink" path. When the Media Pool
    # item exists but shows "Media Offline" in Resolve (drive-letter changed,
    # project moved, etc.), call ReplaceClip with os.path.abspath(render_path)
    # to force Resolve to re-resolve the file reference against a fresh path.
    raw_args = sys.argv[1:]
    at_playhead = False
    force_reconnect = False
    positional = []
    for a in raw_args:
        if a == "--at-playhead":
            at_playhead = True
        elif a == "--force-reconnect":
            force_reconnect = True
        else:
            positional.append(a)

    if len(positional) < 1:
        raise RuntimeError("Usage: relink_latest_render.py <shot_dir> [versionName] [--at-playhead] [--force-reconnect]")
    shot_dir = positional[0]
    # Stash shot_dir in the shared ctx so the outer exception handler can
    # write .relink.json even when we fail before main() would have done so.
    ctx["shot_dir"] = shot_dir
    version_override = positional[1] if len(positional) >= 2 else None
    log("shot_dir: " + shot_dir
        + (" version=" + version_override if version_override else "")
        + (" at_playhead=1" if at_playhead else "")
        + (" force_reconnect=1" if force_reconnect else ""))

    job_path, job = read_job(shot_dir)
    log("job.json loaded: shot=%s project=%s timeline=%s"
        % (job.get("shot"), job.get("resolveProject"), job.get("resolveTimeline")))

    v, render_path = latest_render(shot_dir, version_override)
    if render_path is None:
        raise RuntimeError("No master render found under renders/ (version=%s)" % v)
    log("Latest version: %s -> %s" % (v, render_path))

    resolve = get_resolve()
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if project is None:
        raise RuntimeError("No project open in Resolve.")

    origin = (job.get("origin") or "resolve").lower()
    # AE-origin shots are created without Resolve context — on first render
    # we adopt whatever project/timeline is currently open instead of warning.
    ae_first_render = (origin == "ae") and not job.get("resolveMediaPoolItemId")

    if job.get("resolveProject") and project.GetName() != job["resolveProject"]:
        log("WARNING: open project '%s' != job project '%s' — continuing with open one."
            % (project.GetName(), job["resolveProject"]))

    tl = ensure_timeline(project, job.get("resolveTimeline"))
    if tl is None:
        # For AE-origin first-render, falling back to the open timeline is fine.
        tl = project.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError("Could not locate a timeline to operate on. "
                           "Open a timeline in Resolve and try again.")
    log("Timeline: " + tl.GetName())

    media_pool = project.GetMediaPool()

    mpi_id = job.get("resolveMediaPoolItemId")
    mpi = find_mpi_by_id(media_pool, mpi_id) if mpi_id else None

    color = color_for_render(render_path)
    log("Render-mode color for '%s' -> %s"
        % (os.path.basename(render_path), color))

    if mpi is not None:
        # --- SUBSEQUENT RENDER: rebind the existing media pool item ----
        # Force-reconnect mode always normalises to an absolute path so
        # Resolve's "Media Offline" state clears when the underlying file is
        # actually reachable but the cached reference went stale.
        rebind_path = os.path.abspath(render_path) if force_reconnect else render_path
        if force_reconnect:
            log("Force-reconnect: calling ReplaceClip with abspath=%s" % rebind_path)
        else:
            log("Found existing MediaPoolItem by id=%s — calling ReplaceClip()" % mpi_id)
        ok = bool(mpi.ReplaceClip(rebind_path))
        if not ok:
            raise RuntimeError("ReplaceClip returned False for %s" % rebind_path)
        log("ReplaceClip OK — timeline instances rebound.")
        # Repaint every timeline instance so the fast/final indicator stays
        # accurate when the same clip is used on multiple tracks/instances.
        apply_color_to_items(
            list(find_timeline_items_for_mpi(tl, mpi)), color)
    else:
        # --- FIRST RENDER: import + place on V<track> at markIn ---------
        anim_name = (job.get("name") or "").strip()
        if anim_name:
            target = ensure_folder_path(media_pool, ["Motion", anim_name])
            log("Importing into Media Pool folder: Motion/%s" % anim_name)
            imported = import_into(media_pool, target, [render_path])
        else:
            log("No animation name set — importing into current Media Pool folder")
            imported = media_pool.ImportMedia([render_path])
        if not imported:
            raise RuntimeError("ImportMedia returned nothing for %s" % render_path)
        new_mpi = imported[0]
        new_id = str(new_mpi.GetUniqueId())
        log("Imported. UniqueId=" + new_id)

        fps          = float(job.get("fps", 24.0))
        mark_in      = int(job.get("markIn", 0))
        mark_out     = int(job.get("markOut", mark_in + 1))
        duration_fr  = max(1, mark_out - mark_in)
        track_index  = int(job.get("resolveTrackIndex", 2))

        # AE-origin shots (and any caller passing --at-playhead) ignore the
        # stored markIn and insert at the current Resolve playhead, so the
        # artist can drop the render wherever they're scrubbed to. We keep
        # the duration computed from markIn/markOut so AE's work-area length
        # still drives the timeline clip length.
        record_frame = mark_in
        if at_playhead or ae_first_render:
            ph = _playhead_frame(tl, fps)
            if ph is None:
                log("WARNING: could not read playhead timecode — falling back to markIn=%d" % mark_in)
            else:
                log("Using playhead as record frame: %d (was markIn=%d)" % (ph, mark_in))
                record_frame = ph
                new_mark_out = ph + duration_fr
                # Persist the adopted range back to job.json so subsequent
                # ReplaceClip flows and UI reads stay consistent.
                job["markIn"]  = ph
                job["markOut"] = new_mark_out
                mark_in  = ph
                mark_out = new_mark_out

        # First render always adopts whatever Resolve project/timeline is open
        # when origin=="ae", so downstream "Set Active Version" calls work.
        if ae_first_render:
            job["resolveProject"]  = project.GetName()
            job["resolveTimeline"] = tl.GetName()
            log("Captured Resolve context: project=%s timeline=%s"
                % (job["resolveProject"], job["resolveTimeline"]))

        # Ensure the target track exists; AddTrack is idempotent-ish.
        try:
            while tl.GetTrackCount("video") < track_index:
                tl.AddTrack("video")
        except Exception as e:
            log("AddTrack skipped: " + str(e))

        appended = append_to_v2(media_pool, new_mpi, fps, record_frame, track_index, duration_fr)

        # Color the just-inserted TimelineItem(s). Falls back to a track scan
        # if AppendToTimeline didn't return handles (older Resolve builds).
        if appended:
            apply_color_to_items(appended, color)
        else:
            apply_color_to_items(
                list(find_timeline_items_for_mpi(tl, new_mpi)), color)

        job["resolveMediaPoolItemId"] = new_id
        write_job(job_path, job)
        log("job.json updated with resolveMediaPoolItemId=" + new_id)

    log("==== relink_latest_render DONE OK ====")
    # Success result — Electron side reads this via waitForRelinkResult and
    # reports "Relinked vXX in Resolve" on the status strip.
    ctx["result"] = {"ok": True, "version": v}


_ctx = {}
try:
    main(_ctx)
except Exception as e:
    log("FATAL: " + str(e))
    log(traceback.format_exc())
    _ctx["result"] = {"ok": False, "error": str(e)}
finally:
    # Always write .relink.json if we know the shot_dir — success OR failure.
    # Absence of this file is interpreted as "timeout" by the Electron side,
    # so writing it is essential even when the relink itself failed.
    sd = _ctx.get("shot_dir")
    res = _ctx.get("result") or {"ok": False, "error": "relink never completed"}
    if sd:
        write_relink_result(sd, res)

if not _ctx.get("result", {}).get("ok"):
    # Non-zero exit so detached-spawn exit codes still reflect failure,
    # though Electron primarily relies on the result file now.
    sys.exit(2)
