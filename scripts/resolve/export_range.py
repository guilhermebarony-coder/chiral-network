# -*- coding: utf-8 -*-
# export_range.py — Chiral Network — DaVinci Resolve side of the bridge.
#
# Python compatibility: 3.10 .. 3.13 (tested).
#   * Avoids f-strings entirely — uses %-formatting and str.format() so the
#     script parses identically on every supported interpreter (PEP 701
#     f-string changes in 3.12+ are a non-factor).
#   * No PEP 695 type aliases, no `match` statements, no walrus dependencies,
#     no removed-in-3.12 modules (distutils, etc).
#   * Resolve 20.x's embedded scripting host binds to one Python ABI per
#     build. Some builds prefer 3.10/3.11/3.13 and FAIL to import cleanly
#     on 3.12 because of fusionscript.dll's ABI tag. _check_python_version()
#     below logs a loud warning when the running interpreter is outside the
#     known-good range so testers can correlate failures to that mismatch.
#
# Install:
#   Copy this file to:
#     %APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility/
#   (Utility is the safest folder for Resolve-API scripts; Edit also works.)
#
# Run:
#   Workspace > Scripts > Utility > export_range
#
# Diagnostics:
#   ALL output goes to:
#     F:/CLAUDE/roundtrip_root/scripts/resolve/export_range.log
#   Resolve's Console panel does NOT show stdout for menu-launched scripts —
#   that is why "nothing happens" looks like total silence. This script writes
#   to the log file above and pops a dialog at start/finish for visible proof.
#
# Using line comments instead of a docstring because paths like \Utility break
# non-raw string parsing, and embedding an r-prefix inside a triple-quoted
# docstring accidentally re-closed the docstring in a prior version.

import os
import re
import sys
import time
import json
import traceback

# Optional sibling import. Wrapped in try/except because Resolve's Utility
# folder install copies scripts individually; if the user only copied
# export_range.py and not chiral_version.py, we don't want to crash. The
# fallback values keep the version check harmless in that case.
try:
    from chiral_version import SCRIPT_VERSION, PY_MIN, PY_MAX
except Exception:
    SCRIPT_VERSION = "unknown"
    PY_MIN = (3, 10)
    PY_MAX = (3, 10)

# ---- Config ----------------------------------------------------------------
# ROOT (projects directory) is resolved dynamically from the Electron app's
# config so that this script keeps working when the user changes the
# roundtrip root via the Setup Wizard.
#
# Config location history (read in this order, first hit wins):
#   1. %APPDATA%/Chiral Network/config.json  — current (post-rebrand
#      productName used by Electron's app.getPath('userData'))
#   2. %APPDATA%/Roundtrip/config.json       — legacy (pre-0.4.x builds)
#
# If no config exists, we fall back to a SAFE per-user default
# (%USERPROFILE%/Documents/Chiral Network) rather than a developer-machine
# path. Shipping a hardcoded "F:\..." fallback was poison on every machine
# that wasn't the dev's — testers hit FileNotFoundError on os.makedirs('F:\\')
# when the Electron app and the Python script disagreed on the config dir.
_CONFIG_DIR_CANDIDATES = ("Chiral Network", "Roundtrip")


def _safe_default_root():
    """Last-resort root: <User>/Documents/Chiral Network. Exists on all Win."""
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.join(home, "Documents", "Chiral Network")


def _read_roundtrip_config():
    """Return parsed Electron config, or {} on any failure.

    Tries current ("Chiral Network") then legacy ("Roundtrip") %APPDATA%
    subdirectories. The first one that parses wins — this lets a tester
    upgrade cleanly even if stale legacy files linger.
    """
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return {}
    for sub in _CONFIG_DIR_CANDIDATES:
        cfg_path = os.path.join(appdata, sub, "config.json")
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data:
                    return data
        except Exception:
            continue
    return {}


def _config_path_for_write():
    """Path where pendingShotName etc. get written back.

    Writes to the SAME location the read preferred (current > legacy). If
    no config exists yet, writes to the current location so we don't keep
    the legacy folder alive on fresh installs.
    """
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    for sub in _CONFIG_DIR_CANDIDATES:
        p = os.path.join(appdata, sub, "config.json")
        if os.path.isfile(p):
            return p
    return os.path.join(appdata, _CONFIG_DIR_CANDIDATES[0], "config.json")


def get_roundtrip_root():
    """Resolved roundtrip root: config.roundtripRoot -> safe per-user default."""
    cfg = _read_roundtrip_config()
    r = (cfg.get("roundtripRoot") or "").strip()
    if r and os.path.isdir(r):
        return r
    return _safe_default_root()


def get_projects_dir():
    return os.path.join(get_roundtrip_root(), "projects")


def _resolve_log_path(name):
    """Prefer %APPDATA%/<app>/logs/<name>; fall back to roundtrip root.

    Tries the current app dir first, then the legacy one, then finally a
    scripts/resolve/ dir under the resolved roundtrip root (safe default).
    """
    appdata = os.environ.get("APPDATA")
    if appdata:
        for sub in _CONFIG_DIR_CANDIDATES:
            d = os.path.join(appdata, sub, "logs")
            try:
                os.makedirs(d, exist_ok=True)
                return os.path.join(d, name)
            except Exception:
                continue
    # Last resort — land next to the projects dir rather than a dev path.
    fallback_dir = os.path.join(_safe_default_root(), "logs")
    try:
        os.makedirs(fallback_dir, exist_ok=True)
    except Exception:
        pass
    return os.path.join(fallback_dir, name)


ROOT          = get_projects_dir()
# PROJECT_NAME is derived from the open Resolve project at runtime — see
# sanitize_project_name() and main(). The Resolve project is the source of
# truth for project organization; no hardcoded "demo" fallback.
RENDER_PRESET = "H.264 Master"
POLL_INTERVAL = 1.0
LOG_PATH      = _resolve_log_path("export_range.log")


def _check_python_version():
    """Log the running Python version and warn (don't bail) when outside
    the supported 3.10..3.13 range. Some Resolve builds embed a fusionscript
    binding that links cleanly only against specific minors; a loud log
    line lets a tester correlate import failures to that mismatch instead
    of chasing phantom script bugs."""
    v = sys.version_info
    line = "Python {}.{}.{} ({})".format(v.major, v.minor, v.micro, sys.executable)
    if (v.major, v.minor) < PY_MIN or (v.major, v.minor) > PY_MAX:
        log("WARNING: %s — outside Chiral Network's tested range "
            "%d.%d..%d.%d. Resolve's fusionscript host may refuse to "
            "import on this interpreter."
            % (line, PY_MIN[0], PY_MIN[1], PY_MAX[0], PY_MAX[1]))
    else:
        log(line + " — within supported range.")


def sanitize_project_name(s):
    """Mirrors app/main.js sanitizeName — lowercase, [a-z0-9._-], max 48.
    Falls back to 'untitled' if sanitization yields an empty string."""
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "_", s)
    s = re.sub(r"^_+|_+$", "", s)
    s = s[:48]
    return s or "untitled"


# ---- Technical Spec Lock (v0.4.9) ------------------------------------------
# A project is locked to the timeline spec (fps/resolution/color-science) of
# its FIRST shot export. Subsequent exports with a mismatched spec are refused
# — the script aborts with a dialog, writes a .spec_mismatch.json sidecar in
# the project folder so Electron can surface an "Unlock spec?" modal, and the
# user must explicitly unlock before re-running. This prevents the silent
# drift bug where an artist accidentally switches timeline fps mid-project
# and every subsequent render comes back at the wrong cadence.
#
# "Unlocking" is deliberately an explicit Electron-UI action (not a --force
# flag) so the decision is visible and auditable, not a checkbox someone
# clicks through on autopilot.

def _project_manifest_path(project_dir):
    return os.path.join(project_dir, "project.json")


def _spec_mismatch_path(project_dir):
    return os.path.join(project_dir, ".spec_mismatch.json")


def _read_project_manifest(project_dir):
    """Returns {} on missing or unparseable manifest — callers treat empty as
    'not locked yet'. Never raises."""
    p = _project_manifest_path(project_dir)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _atomic_write_json(path, data):
    """Atomic NTFS-safe write: tmp + fsync + rename. Same pattern Electron
    uses for job.json so the two sides can't half-write each other's state."""
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.flush()
        try:
            os.fsync(f.fileno())
        except Exception:
            pass
    # os.replace is atomic on Windows (unlike os.rename which fails if dest exists).
    os.replace(tmp, path)


def _build_timeline_spec(tl):
    """Snapshot the timeline attributes that matter for pipeline consistency.
    Keep this list MINIMAL — every field here is a lock point that triggers
    a mismatch error when it drifts, so only fields that actually corrupt
    renders when they differ should go in.

    Fields:
      fps           — hard: wrong fps = wrong duration in AE round-trip.
      width/height  — hard: wrong res = wrong comp size.
      colorScience  — soft: recorded but not (yet) enforced across the
                      AE round-trip; AE color management is a rabbit hole
                      best left for a future version. Stored so the UI
                      badge can surface it, and so a future version can
                      start comparing without a schema bump.
    """
    def _getset(key, fallback=None):
        try:
            v = tl.GetSetting(key)
            return v if v not in (None, "") else fallback
        except Exception:
            return fallback
    try:
        fps_val = round(float(_getset("timelineFrameRate", 0)), 3)
    except Exception:
        fps_val = 0.0
    try:
        w_val = int(_getset("timelineResolutionWidth", 0) or 0)
        h_val = int(_getset("timelineResolutionHeight", 0) or 0)
    except Exception:
        w_val, h_val = 0, 0
    return {
        "fps":               fps_val,
        "width":             w_val,
        "height":            h_val,
        "colorScienceMode":  _getset("colorScienceMode"),
    }


def _compare_specs(locked, current):
    """Return list of {field, locked, current} diffs for fields that MUST
    match. colorScienceMode is recorded but not enforced — see
    _build_timeline_spec docblock.

    fps comparison uses a small epsilon because GetSetting rounds 23.976 to
    23.976000000001 on some Resolve builds, and we don't want noise errors."""
    HARD_FIELDS = ("fps", "width", "height")
    diffs = []
    for k in HARD_FIELDS:
        a = locked.get(k)
        b = current.get(k)
        if k == "fps":
            try:
                if abs(float(a) - float(b)) < 0.01:
                    continue
            except Exception:
                pass
        if a != b:
            diffs.append({"field": k, "locked": a, "current": b})
    return diffs


def _read_spec_mismatch(project_dir):
    """Return the existing .spec_mismatch.json dict if present, else None.
    Used to decide whether the user has already acknowledged this particular
    drift — if the sidecar's currentSpec equals what we just detected, we
    skip the confirmation dialog and let the export proceed silently. The
    red badge in the app UI is the persistent reminder."""
    p = _spec_mismatch_path(project_dir)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _specs_equal_for_ack(a, b):
    """Tolerant equality for the short-circuit check. Same rule as
    _compare_specs() — fps within 0.01, exact match on width/height.
    None on either side means 'can't tell', conservatively unequal."""
    if not a or not b:
        return False
    try:
        if abs(float(a.get("fps", 0)) - float(b.get("fps", 0))) >= 0.01:
            return False
    except Exception:
        return False
    return (a.get("width")  == b.get("width")
        and a.get("height") == b.get("height"))


def _handle_spec_lock(project_dir, current_spec, shot_name_hint):
    """Returns True if export should continue, False if user cancelled.

    Three branches:
      1. No lock yet            → stamp lockedSpec, proceed silently.
      2. Locked, specs match    → proceed silently; clear any stale sidecar.
      3. Locked, specs mismatch → soft confirm. If a sidecar already exists
                                  recording THIS exact drift, proceed
                                  silently (user acknowledged previously).
                                  Otherwise pop a Yes/No dialog:
                                    - Proceed → write sidecar, continue.
                                    - Cancel  → clean no-op, abort export.

    v0.4.9-rc5 flipped this from hard-abort to soft-confirm: the tester
    flagged that legitimate workflows (different-fps inserts, reference
    footage at native rate) need to export without fighting the lock. The
    red badge + unlock modal in the app is where spec-drift is resolved
    properly; this dialog is just the point-of-export safety net."""
    manifest = _read_project_manifest(project_dir)
    locked = manifest.get("lockedSpec") or None

    # ---- Branch 1: first export — stamp the lock --------------------------
    if locked is None:
        manifest.setdefault("schemaVersion", 1)
        manifest["lockedSpec"]    = current_spec
        manifest["lockedAt"]      = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        manifest["lockedBy"]      = shot_name_hint
        manifest["chiralVersion"] = SCRIPT_VERSION
        try:
            _atomic_write_json(_project_manifest_path(project_dir), manifest)
            log("Spec lock written: %s" % current_spec)
        except Exception as e:
            # Non-fatal: the export can still proceed; we just won't enforce
            # on the next run. Log loudly so testers notice.
            log("WARNING: failed to write project.json spec lock: %s" % e)
        # Clear any stale mismatch sidecar from a previous failed run.
        try:
            sp = _spec_mismatch_path(project_dir)
            if os.path.exists(sp):
                os.remove(sp)
        except Exception:
            pass
        return True

    # ---- Branch 2: locked, matches ----------------------------------------
    diffs = _compare_specs(locked, current_spec)
    if not diffs:
        try:
            sp = _spec_mismatch_path(project_dir)
            if os.path.exists(sp):
                os.remove(sp)
        except Exception:
            pass
        log("Spec lock OK: %s" % current_spec)
        return True

    # ---- Branch 3: locked, mismatch ---------------------------------------
    # Acknowledgement short-circuit: if the sidecar already records this
    # exact drift, the user said "proceed" on a previous export of the same
    # mismatch. Don't pester them again — just refresh timestamp / attempted
    # shot and continue. The persistent red badge in the app is the reminder.
    existing = _read_spec_mismatch(project_dir)
    already_ack = (existing is not None
                   and existing.get("userAcknowledged") is True
                   and _specs_equal_for_ack(existing.get("currentSpec"), current_spec))

    if already_ack:
        # Refresh the sidecar so detectedAt / attempted shot stay current.
        sidecar = dict(existing)
        sidecar["detectedAt"]    = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        sidecar["attemptedShot"] = shot_name_hint
        sidecar["chiralVersion"] = SCRIPT_VERSION
        try:
            _atomic_write_json(_spec_mismatch_path(project_dir), sidecar)
        except Exception as e:
            log("WARNING: failed to refresh .spec_mismatch.json: %s" % e)
        log("[spec-lock] mismatch previously acknowledged, proceeding: diffs=%s" % diffs)
        return True

    # First time seeing this drift — ask the user.
    lines = ["Timeline spec differs from the project's locked spec.",
             "", "Locked:"]
    for k in ("fps", "width", "height"):
        lines.append("  {}: {}".format(k, locked.get(k)))
    lines.append("")
    lines.append("Current timeline:")
    for k in ("fps", "width", "height"):
        lines.append("  {}: {}".format(k, current_spec.get(k)))
    lines.append("")
    lines.append("Click OK to export anyway (a warning badge will appear in")
    lines.append("Chiral Network so you can accept or reject the new spec later).")
    lines.append("Click Cancel to abort and fix the timeline first.")
    dialog_msg = "\n".join(lines)

    proceed = ask_user_confirm("Chiral Network \u2014 Spec mismatch", dialog_msg)
    log("[spec-lock] MISMATCH diffs=%s userChose=%s"
        % (diffs, "proceed" if proceed else "cancel"))

    if not proceed:
        # Clean abort — no sidecar, nothing for the app to flag. The user
        # chose to back out; the project stays pristine.
        return False

    # User accepted the drift for THIS export. Write the sidecar so the app's
    # red badge appears and the user can resolve the drift properly later.
    sidecar = {
        "detectedAt":      time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lockedSpec":      locked,
        "currentSpec":     current_spec,
        "diffs":           diffs,
        "attemptedShot":   shot_name_hint,
        "userAcknowledged": True,
        "chiralVersion":   SCRIPT_VERSION,
    }
    try:
        _atomic_write_json(_spec_mismatch_path(project_dir), sidecar)
    except Exception as e:
        log("WARNING: failed to write .spec_mismatch.json: %s" % e)
    return True
# ----------------------------------------------------------------------------


def log(msg: str) -> None:
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


def show_dialog(title: str, message: str) -> None:
    """Best-effort popup so the user gets visible feedback. Resolve's embedded
    Fusion provides `fusion`/`fu` globals with AskUser/MessageBox-style helpers."""
    for gname in ("fusion", "fu"):
        g = globals().get(gname)
        if g is None:
            # Try to reach it from Resolve
            try:
                g = resolve.Fusion()   # type: ignore  # noqa: F821
            except Exception:
                g = None
        if g is not None:
            try:
                g.AskUser(title, {1: {1: "Label", "Name": "msg", 2: message}})
                return
            except Exception:
                pass
    # Fallback: write a sentinel file the Electron app could poll.
    try:
        with open(os.path.join(os.path.dirname(LOG_PATH), "last_dialog.txt"), "w") as f:
            f.write(title + "\n" + message + "\n")
    except Exception:
        pass


def ask_user_confirm(title: str, message: str) -> bool:
    """OK/Cancel confirmation dialog. Returns True if user clicked OK (or
    anything non-None, which Fusion's AskUser uses for "accepted"), False
    if the dialog was cancelled or couldn't be shown at all.

    v0.4.9-rc5 — needed by the spec-lock soft-confirm flow. Fusion's
    AskUser() already gives us OK and Cancel buttons by default; a
    None return == user hit Cancel (or closed the dialog), anything
    else == user hit OK. This matches what we want.

    The tkinter fallback is the safety net when Resolve's Fusion UI is
    unavailable (menu-launched scripts should always have it, but be
    defensive). If BOTH fail, we conservatively return False — aborting
    is safer than silently proceeding with a spec drift the user never
    saw a prompt for."""
    for gname in ("fusion", "fu"):
        g = globals().get(gname)
        if g is None:
            try:
                g = resolve.Fusion()   # type: ignore  # noqa: F821
            except Exception:
                g = None
        if g is not None:
            try:
                # AskUser returns None on Cancel, dict-of-inputs on OK.
                # We provide a single Label widget; just care about the
                # OK/Cancel branch, not any input values.
                ret = g.AskUser(title, {1: {1: "Label", "Name": "msg", 2: message}})
                return ret is not None
            except Exception:
                pass
    # Fallback: tkinter. Heavier but gives us a real OS dialog if Fusion
    # isn't reachable (shouldn't happen in a menu-launched script).
    try:
        import tkinter
        from tkinter import messagebox
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            ok = bool(messagebox.askokcancel(title, message, parent=root))
        finally:
            try: root.destroy()
            except Exception: pass
        return ok
    except Exception:
        # No GUI available. Fail closed — don't silently proceed with a
        # spec mismatch the user never saw.
        log("WARNING: ask_user_confirm could not show a dialog; defaulting to Cancel.")
        return False


def get_resolve_handle():
    """Resolve injects `resolve`, `fusion`, `bmd` as globals into menu scripts.
    Fall back to scriptapp() for external runs."""
    injected = globals().get("resolve")
    if injected is not None:
        log("Using injected 'resolve' global.")
        return injected
    log("No 'resolve' global; falling back to DaVinciResolveScript.scriptapp().")
    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "Cannot import DaVinciResolveScript and 'resolve' global not injected. "
            "If this script is in Fusion/Scripts/Comp/, move it to "
            "Fusion/Scripts/Utility/ and restart Resolve. (%s)" % e
        )
    r = dvr.scriptapp("Resolve")
    if r is None:
        raise RuntimeError("scriptapp('Resolve') returned None — is Resolve running?")
    return r


def _consume_pending_shot_name():
    """v0.4.8 — read and clear the Electron-side pending-shot-name override.

    The Electron UI writes the user-typed NAME into
    %APPDATA%/Roundtrip/config.json's `pendingShotName` field when there's
    no current shot yet (see main.js `shot:setPendingName`). When
    export_range.py runs in Resolve, we read and consume that name here so
    the new shot folder uses it instead of Shot_XXX. Cleared after consume
    so stale names don't leak between runs.

    Returns the sanitized name (matching the Shot_XXX-safe charset) or None.
    """
    cfg = _read_roundtrip_config()
    raw = (cfg.get("pendingShotName") or "").strip()
    if not raw:
        return None
    # Same charset as Shot_XXX (safe on every filesystem; Resolve's Media
    # Pool also tolerates it). Reject empty post-sanitize.
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    safe = re.sub(r"^_+|_+$", "", safe)[:64]
    if not safe:
        return None
    # Clear on consume. Best-effort: if the write fails we still return the
    # name (the shot folder will be created; worst case the next run re-uses
    # the same name and hits the collision branch below in next_shot_name).
    cfg_path = _config_path_for_write()
    if cfg_path:
        try:
            cfg.pop("pendingShotName", None)
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
        except Exception:
            pass
    return safe


def next_shot_name(project_dir):
    """Return a shot folder name that does not yet exist in project_dir.

    Preference order:
      1. Electron UI's `pendingShotName` override (consumed here), with
         numeric suffix collision-disambiguation (foo, foo_2, foo_3...).
      2. Shot_NNN — the classic auto-naming, picking the next integer
         after the highest existing Shot_*.
    """
    os.makedirs(project_dir, exist_ok=True)
    existing = set(os.listdir(project_dir))

    pending = _consume_pending_shot_name()
    if pending:
        if pending not in existing:
            log("Using pendingShotName override: %s" % pending)
            return pending
        # Collision — append _2, _3, ... rather than falling through to
        # Shot_NNN (which would lose the user's intent entirely).
        i = 2
        while "%s_%d" % (pending, i) in existing:
            i += 1
        name = "%s_%d" % (pending, i)
        log("pendingShotName '%s' collided; using '%s'" % (pending, name))
        return name

    nums = []
    for entry in existing:
        full = os.path.join(project_dir, entry)
        if os.path.isdir(full) and entry.startswith("Shot_"):
            try:
                nums.append(int(entry.split("_", 1)[1]))
            except ValueError:
                pass
    n = (max(nums) if nums else 0) + 1
    return "Shot_{:03d}".format(n)


def _parse_timecode_to_frame(tc, fps):
    """Parse HH:MM:SS:FF (or drop-frame HH:MM:SS;FF) into an absolute frame.
    Returns None on any parse failure. Uses the integer frame-rate (round of
    fps) for the seconds-to-frames math — matches how Resolve numbers frames
    even in 23.976/29.97 timelines, where the wall-clock fps is fractional
    but the frame index increments by 1 per displayed frame.

    We deliberately tolerate either ':' or ';' as the final separator: some
    Resolve builds emit the latter for drop-frame timelines and an int(';2')
    cast would otherwise raise ValueError under Python 3.10+ where the
    parser is stricter about leading non-digits."""
    try:
        s_tc = str(tc).strip()
        # Normalise drop-frame separator before splitting so '01:00:00;12'
        # parses identically to '01:00:00:12'.
        s_tc = s_tc.replace(";", ":")
        parts = s_tc.split(":")
        if len(parts) != 4:
            return None
        h, m, s, f = (int(p) for p in parts)
        fps_int = int(round(float(fps)))
        if fps_int <= 0:
            return None
        return ((h * 3600) + (m * 60) + s) * fps_int + f
    except Exception:
        return None


MIN_MARK_SPAN = 2   # frames — anything shorter is almost certainly a mis-read

# CRITICAL — frame-space semantics for Resolve 20.3 / 21:
#
#   * timeline.GetStartFrame() / GetEndFrame()
#         -> ABSOLUTE frames in the project's timecode space. For a timeline
#            that starts at 01:00:00:00 @ 24fps the value is 86400.
#   * timeline.GetMarkInOut()
#         -> TIMELINE-RELATIVE frame indices (0 = the very first frame of
#            the timeline, regardless of the 01:00:00:00 offset). Returns
#            {"video":{"in": 0, "out": 0}} or {"in": 0, "out": 1} as a
#            sentinel when no marks are set — never a real user selection.
#   * timeline.GetInPoint() / GetOutPoint()
#         -> TIMECODE STRINGS in absolute project time ("01:00:11:04" etc.).
#            Parse with _parse_timecode_to_frame, then SUBTRACT GetStartFrame
#            to reach timeline-relative space.
#   * project.SetRenderSettings({"MarkIn": ..., "MarkOut": ...})
#         -> expects ABSOLUTE timeline frames on Resolve 20.2.2.10 and
#            newer. Proof in the wild: payload MarkIn=561 / MarkOut=662
#            on a timeline starting at 86400 was silently clamped to
#            MarkIn=86400 / MarkOut=86400 in the queued job — one frame.
#            (tester log, 2026-04-19 12:26:27, Resolve 20.2.2.10)
#            We therefore always send (timeline_start + relative_frame)
#            here and ALSO call timeline.SetMarkIn / SetMarkOut with the
#            same absolute values so the UI-side range state agrees with
#            the payload.
#
# A previous validator compared GetMarkInOut values against the ABSOLUTE
# bounds and wrongly rejected legitimate user selections, which then fell
# through to a full-timeline render. All validation below stays in
# timeline-relative space; absolute values only touch the GetInPoint path
# and the render-settings payload, both of which explicitly convert.


def _range_looks_valid(mi_rel, mo_rel_excl, timeline_length):
    """mi_rel / mo_rel_excl are TIMELINE-RELATIVE frame indices
    (0 == timeline head; mo is exclusive). timeline_length = end - start.

    A candidate range is accepted iff:
      * out_excl > in by at least MIN_MARK_SPAN frames — rejects the
        {in:0,out:0} and {in:0,out:1} sentinels Resolve 20.x emits when
        no marks are set;
      * both values lie within [0, timeline_length]."""
    if mi_rel is None or mo_rel_excl is None:
        return False
    if mo_rel_excl - mi_rel < MIN_MARK_SPAN:
        return False
    if mi_rel < 0 or mo_rel_excl > timeline_length:
        return False
    return True


def get_mark_in_out(timeline, fps):
    """Resolve the user-selected render range robustly across Resolve builds.

    Priority:
        1. GetMarkInOut()                 — timeline-relative dict (newest API)
        2. GetInPoint() / GetOutPoint()   — absolute timecode strings (older)

    There is NO automatic full-timeline fallback. If neither API returns a
    valid selection, this function returns (None, None, "no-range") and the
    caller aborts with a user-facing dialog. The alternative — silently
    rendering the whole timeline — has produced wrong output for testers
    who DID set marks that Resolve failed to report.

    All three return values stay in TIMELINE-RELATIVE frame space so the
    caller can hand them straight to SetRenderSettings without further math.

    Returns (in_frame_rel, out_frame_rel_exclusive, source_label)."""
    start  = int(timeline.GetStartFrame())
    end    = int(timeline.GetEndFrame())
    length = end - start
    log("Timeline bounds: start=%d end=%d length=%d (fps=%s)"
        % (start, end, length, fps))

    # --- 1) GetMarkInOut() — timeline-relative dict ------------------------
    marks = None
    try:
        marks = timeline.GetMarkInOut()
    except Exception as e:
        log("GetMarkInOut() unavailable: %s" % e)
    log("GetMarkInOut() raw -> %r" % (marks,))
    if isinstance(marks, dict) and isinstance(marks.get("video"), dict):
        v = marks["video"]
        mi, mo = v.get("in"), v.get("out")
        if mi is not None and mo is not None:
            try:
                mi_i, mo_i = int(mi), int(mo)
                # Resolve's 'out' is INCLUSIVE; downstream math uses
                # exclusive out, so +1.
                mo_excl = mo_i + 1
                if _range_looks_valid(mi_i, mo_excl, length):
                    return mi_i, mo_excl, "GetMarkInOut"
                log("GetMarkInOut rejected: in=%s out=%s (length=%d, span=%d)"
                    % (mi_i, mo_i, length, mo_excl - mi_i))
            except (TypeError, ValueError) as e:
                log("GetMarkInOut values not coercible to int: %s" % e)

    # --- 2) GetInPoint() / GetOutPoint() — absolute timecode --------------
    tc_in = tc_out = None
    try:
        tc_in  = timeline.GetInPoint()
        tc_out = timeline.GetOutPoint()
    except Exception as e:
        log("GetInPoint/GetOutPoint unavailable: %s" % e)
    log("GetInPoint() raw -> %r ; GetOutPoint() raw -> %r" % (tc_in, tc_out))
    if tc_in and tc_out:
        fi_abs = _parse_timecode_to_frame(tc_in, fps)
        fo_abs = _parse_timecode_to_frame(tc_out, fps)
        log("  parsed absolute: in=%s out=%s" % (fi_abs, fo_abs))
        if fi_abs is not None and fo_abs is not None:
            # Convert absolute → timeline-relative by subtracting start.
            fi_rel = fi_abs - start
            fo_rel = fo_abs - start
            fo_excl = fo_rel + 1
            log("  -> relative: in=%d out=%d (exclusive out=%d)"
                % (fi_rel, fo_rel, fo_excl))
            if _range_looks_valid(fi_rel, fo_excl, length):
                return fi_rel, fo_excl, "GetInPoint/GetOutPoint"
            log("GetInPoint/GetOutPoint rejected: in_rel=%d out_rel=%d "
                "(length=%d, span=%d)"
                % (fi_rel, fo_rel, length, fo_excl - fi_rel))

    # Deliberate: no full-timeline fallback. Failing loud here is strictly
    # better than silently rendering 58 s of content the user didn't ask for.
    return None, None, "no-range"


def _playhead_frame(timeline, fps):
    """Best-effort playhead read for log diagnostics. Never raises."""
    try:
        tc = timeline.GetCurrentTimecode()
    except Exception:
        tc = None
    return _parse_timecode_to_frame(tc, fps) if tc else None


def _ensure_edit_page(resolve):
    """Switch to the Edit page so the timeline viewer is active before we
    probe marks. On the Cut, Fusion, Color, Deliver, or Media pages some
    Resolve builds return zero/garbage from GetMarkInOut() — the "Current"
    viewer isn't the timeline at that moment. Logged, never fatal."""
    try:
        page = resolve.GetCurrentPage()
    except Exception as e:
        page = None
        log("GetCurrentPage failed: %s" % e)
    log("Current Resolve page: %s" % page)
    if page == "edit":
        return
    try:
        ok = resolve.OpenPage("edit")
        log("OpenPage('edit') -> %s" % ok)
        # Small settle — Resolve animates the page transition and the
        # timeline viewer bindings lag the visual switch by a tick.
        time.sleep(0.4)
    except Exception as e:
        log("OpenPage('edit') failed: %s" % e)


def _safe_call(fn, *a, **kw):
    """Invoke a Resolve API method, log the outcome, never raise. Used for
    diagnostic probes (version strings, job status) where failure on older
    Resolve builds is expected and must not stop the main flow."""
    try:
        return fn(*a, **kw)
    except Exception as e:
        log("  (API call failed: %s)" % e)
        return None


def load_render_preset(proj, preferred):
    """Load the desired render preset, falling back to compatible alternatives.
    Logs the full preset list once so testers on any Resolve build can see
    what is actually available. Returns the name we loaded, or None."""
    try:
        available = list(proj.GetRenderPresetList() or [])
    except Exception as e:
        available = []
        log("GetRenderPresetList failed: %s" % e)
    log("Available render presets (%d): %s" % (len(available), available))

    candidates = [preferred, "H.264 Master", "H.264", "H.265 Master",
                  "YouTube 1080p", "YouTube - 1080p"]
    seen = set()
    for name in candidates:
        if not name or name in seen:
            continue
        seen.add(name)
        try:
            if proj.LoadRenderPreset(name):
                log("Loaded render preset: %s" % name)
                return name
        except Exception as e:
            log("LoadRenderPreset('%s') raised: %s" % (name, e))
    # Last-ditch: first available H.264-ish preset by substring match.
    for name in available:
        low = name.lower()
        if "h.264" in low or "h264" in low or "mp4" in low:
            try:
                if proj.LoadRenderPreset(name):
                    log("Loaded render preset (fallback by substring): %s" % name)
                    return name
            except Exception:
                pass
    log("ERROR: no H.264-compatible preset could be loaded.")
    return None


def start_rendering_compat(proj, job_id):
    """StartRendering signature varies slightly across Resolve builds.
    Try the documented form, then positional-only, then bare call, until one
    returns a truthy result. Returns the truthy/falsy value from whichever
    variant succeeded (or None if every variant raised)."""
    attempts = [
        ("StartRendering([id], isInteractiveMode=False)",
            lambda: proj.StartRendering([job_id], isInteractiveMode=False)),
        ("StartRendering([id])",
            lambda: proj.StartRendering([job_id])),
        ("StartRendering(id)",
            lambda: proj.StartRendering(job_id)),
    ]
    for label, fn in attempts:
        try:
            rv = fn()
            log("%s -> %s" % (label, rv))
            if rv:
                return rv
        except Exception as e:
            log("%s raised: %s" % (label, e))
    return None


def main():
    log("==== export_range START (Chiral Network scripts v%s) ====" % SCRIPT_VERSION)
    _check_python_version()
    show_dialog("Chiral Network", "Export starting — see log:\n" + LOG_PATH)

    resolve = get_resolve_handle()
    log("resolve handle OK.")
    # Version info helps us correlate failures to specific Resolve builds when
    # testers send logs. GetProductName / GetVersionString are present from
    # Resolve 17+ so they're safe to call on any supported build.
    log("Resolve product: %s" % _safe_call(resolve.GetProductName))
    log("Resolve version: %s" % _safe_call(resolve.GetVersionString))

    pm = resolve.GetProjectManager()
    if pm is None:
        raise RuntimeError("GetProjectManager returned None.")
    log("ProjectManager OK.")

    proj = pm.GetCurrentProject()
    if proj is None:
        raise RuntimeError("No project open in Resolve.")
    resolve_project_name = str(proj.GetName())
    project_folder = sanitize_project_name(resolve_project_name)
    log("Current project: '%s' -> folder '%s'" % (resolve_project_name, project_folder))

    # Force the Edit page first — marks read from Cut / Color / Deliver are
    # unreliable on some builds because the "current viewer" isn't the
    # timeline. This is a safe no-op when already on Edit.
    _ensure_edit_page(resolve)
    try:
        current_page = resolve.GetCurrentPage()
    except Exception:
        current_page = None

    # Re-acquire the timeline AFTER the page switch. On some Resolve 20.x
    # builds the TimelineItem handles go stale across page transitions; a
    # fresh GetCurrentTimeline() is cheap insurance.
    tl = proj.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError("No active timeline. Open a timeline on the Edit page and retry.")
    timeline_name = str(tl.GetName())
    log("Current timeline: " + timeline_name)

    fps    = float(tl.GetSetting("timelineFrameRate"))
    width  = int(tl.GetSetting("timelineResolutionWidth"))
    height = int(tl.GetSetting("timelineResolutionHeight"))
    log("Timeline settings: {}x{} @ {} fps".format(width, height, fps))

    # ---- Spec Lock (v0.4.9) ------------------------------------------------
    # Enforce project-wide timeline consistency BEFORE creating a shot folder
    # or touching the render queue. A mismatch aborts with a dialog and
    # leaves a .spec_mismatch.json sidecar for Electron to surface.
    _spec_project_dir = os.path.join(ROOT, project_folder)
    try:
        os.makedirs(_spec_project_dir, exist_ok=True)
    except Exception:
        pass
    _current_spec = _build_timeline_spec(tl)
    # Shot name is decided later (next_shot_name), but for the lockedBy field
    # on first-export we log a placeholder — the next shot folder that gets
    # created will own the lock audit trail.
    if not _handle_spec_lock(_spec_project_dir, _current_spec, "pending"):
        raise RuntimeError(
            "Timeline spec does not match this project's lock. "
            "See dialog for details; .spec_mismatch.json written to %s"
            % _spec_project_dir
        )

    # Raw probes for the log block — captured BEFORE get_mark_in_out runs so
    # we log the untouched return shapes from Resolve even when validation
    # later rejects them. Each call is wrapped because a subset of 20.x
    # builds expose GetInPoint as None (not a method), which would AttributeError.
    def _probe(fn_name):
        try:
            return getattr(tl, fn_name)()
        except Exception as e:
            return "<exception: %s>" % e

    raw_mark_in_out  = _probe("GetMarkInOut")
    raw_in_point     = _probe("GetInPoint")
    raw_out_point    = _probe("GetOutPoint")
    raw_timecode     = _probe("GetCurrentTimecode")
    timeline_start   = int(tl.GetStartFrame())
    timeline_end     = int(tl.GetEndFrame())
    playhead         = _parse_timecode_to_frame(raw_timecode, fps) if isinstance(raw_timecode, str) else None
    log("Playhead frame: %s (from %r)" % (playhead, raw_timecode))

    m_in, m_out, range_src = get_mark_in_out(tl, fps)

    # Explicit, easy-to-grep range block. Single source of truth for testers
    # who paste the log into a bug report. Stable field names — downstream
    # log scrapers key off these strings.
    resolved_label = ("in_rel=%d out_rel=%d duration=%d" % (m_in, m_out, m_out - m_in)
                      if (m_in is not None and m_out is not None) else "INVALID")
    log("[range]")
    log("  page=%s" % current_page)
    log("  timeline=%s" % timeline_name)
    log("  timeline_start=%d" % timeline_start)
    log("  timeline_end=%d" % timeline_end)
    log("  playhead=%s" % playhead)
    log("  GetMarkInOut raw -> %r" % (raw_mark_in_out,))
    log("  GetInPoint raw -> %r" % (raw_in_point,))
    log("  GetOutPoint raw -> %r" % (raw_out_point,))
    log("  GetCurrentTimecode raw -> %r" % (raw_timecode,))
    log("  source=%s" % range_src)
    log("  resolved range -> %s" % resolved_label)

    # Hard validation — refuse to queue a render when we don't have a
    # confident user selection. This path is NEVER a full-timeline render;
    # it always aborts. Producing wrong output silently (as the previous
    # "fall back to entire timeline" branch did) is worse than a clear
    # error because testers then debug a phantom Resolve bug instead of
    # noticing that marks weren't actually set / readable.
    if m_in is None or m_out is None:
        dialog_msg = (
            "No valid IN/OUT range detected on the timeline.\n\n"
            "Please:\n"
            "  1. go to the Edit page\n"
            "  2. click the timeline ruler\n"
            "  3. press I to mark In\n"
            "  4. move the playhead\n"
            "  5. press O to mark Out\n"
            "  6. run Export Range again\n\n"
            "Log: " + LOG_PATH
        )
        try:
            show_dialog("Chiral Network \u2014 No valid range detected", dialog_msg)
        except Exception as e:
            log("show_dialog failed: %s" % e)
        raise RuntimeError(
            "No valid IN/OUT range detected (source=%s). See log for raw API "
            "return values: %s" % (range_src, LOG_PATH)
        )
    duration_frames = m_out - m_in
    duration_sec = duration_frames / fps

    project_dir = os.path.join(ROOT, project_folder)
    os.makedirs(project_dir, exist_ok=True)
    shot_name   = next_shot_name(project_dir)
    shot_dir    = os.path.join(project_dir, shot_name)
    source_dir  = os.path.join(shot_dir, "source")
    ae_dir      = os.path.join(shot_dir, "ae")
    renders_dir = os.path.join(shot_dir, "renders")
    for d in (source_dir, ae_dir, renders_dir):
        os.makedirs(d, exist_ok=True)
    log("Shot folder ready: " + shot_dir)

    # ---- Configure render ---------------------------------------------------
    loaded_preset = load_render_preset(proj, RENDER_PRESET)
    if not loaded_preset:
        raise RuntimeError(
            "No H.264-compatible render preset is available. "
            "Open Resolve > Deliver and save an 'H.264 Master' preset, then retry."
        )

    # Render settings — the key/value names match Resolve's scripting API.
    #
    # Frame-space: ABSOLUTE timeline frames.
    #
    # v0.4.6 fix (tester log, Resolve 20.2.2.10 — 2026-04-19): passing
    # timeline-relative MarkIn=561 / MarkOut=662 to SetRenderSettings on a
    # timeline whose start frame was 86400 produced a queued job with
    # MarkIn=86400 / MarkOut=86400 — i.e. Resolve interpreted the payload
    # as absolute frames, clamped the sub-86400 values to the timeline
    # start, and rendered a single frame.
    #
    # The portable contract across Resolve 20.2 and 21 is therefore to pass
    # ABSOLUTE frames (start + relative_offset) AND physically mark the
    # timeline via timeline.SetMarkIn / SetMarkOut before AddRenderJob so
    # the UI-side range state matches the payload. SelectAllFrames:False is
    # explicit so the preset's own range behavior doesn't override ours.
    abs_in       = timeline_start + m_in
    abs_out_incl = timeline_start + m_out - 1   # Resolve's MarkOut is INCLUSIVE

    # --- Physical timeline marks (UI-level state). Some builds ignore the
    # render-settings payload unless the timeline itself has matching marks;
    # others honor either path. Setting both is harmless and belt-and-braces.
    try:
        ok_clear_in  = _safe_call(tl.ClearMarkInOut) if hasattr(tl, "ClearMarkInOut") else None
        log("timeline.ClearMarkInOut -> %s" % ok_clear_in)
    except Exception as e:
        log("ClearMarkInOut raised: %s" % e)
    try:
        ok_set_in  = tl.SetMarkIn(abs_in)
        ok_set_out = tl.SetMarkOut(abs_out_incl)
        log("timeline.SetMarkIn(%d) -> %s ; SetMarkOut(%d) -> %s"
            % (abs_in, ok_set_in, abs_out_incl, ok_set_out))
    except Exception as e:
        log("timeline.SetMarkIn/SetMarkOut raised: %s" % e)

    render_settings = {
        "TargetDir":       source_dir,
        "CustomName":      "reference",
        "SelectAllFrames": False,
        "MarkIn":          abs_in,
        "MarkOut":         abs_out_incl,
    }
    log("SetRenderSettings payload (absolute frames): %s" % render_settings)
    log("  (relative: in=%d out=%d; timeline_start=%d)"
        % (m_in, m_out - 1, timeline_start))
    settings_ok = proj.SetRenderSettings(render_settings)
    log("SetRenderSettings returned: " + str(settings_ok))
    if not settings_ok:
        raise RuntimeError("SetRenderSettings failed — check MarkIn/MarkOut fit the timeline.")

    # Some 20.x builds clear the render queue when switching presets; re-adding
    # the job AFTER settings is the robust order.
    job_id = proj.AddRenderJob()
    log("AddRenderJob returned: " + str(job_id))

    # Log the queued job's effective MarkIn/MarkOut/frame-count. This is the
    # ground truth — whatever SetRenderSettings said, this is what Resolve
    # will actually feed the encoder. Invaluable for diagnosing range bugs
    # across builds (Resolve 21 beta silently diverged from the payload we
    # sent).
    try:
        jobs = proj.GetRenderJobList() or []
        for j in jobs:
            if isinstance(j, dict) and j.get("JobId") == job_id:
                # Only log the fields that matter for range diagnostics —
                # the full dict is huge on some builds.
                keys = ("JobId", "MarkIn", "MarkOut", "IsExportVideo",
                       "IsExportAudio", "FrameCount", "OutputFilename",
                       "TargetDir", "RenderMode", "SelectAllFrames")
                filtered = {k: j.get(k) for k in keys if k in j}
                log("Queued render job effective settings: %s" % filtered)

                # v0.4.6 validation — did Resolve actually honor the range we
                # sent? Compare the queued job's MarkIn/MarkOut against the
                # absolute values we requested. A mismatch is the smoking
                # gun for the single-frame render bug; log loudly so it's
                # obvious in tester reports without having to diff payloads.
                got_in  = j.get("MarkIn")
                got_out = j.get("MarkOut")
                if got_in == abs_in and got_out == abs_out_incl:
                    log("[range-check] OK — queued job honors requested "
                        "absolute range (in=%d out=%d, %d frames)."
                        % (abs_in, abs_out_incl, abs_out_incl - abs_in + 1))
                else:
                    log("[range-check] MISMATCH — requested in=%d out=%d "
                        "but queued job has in=%s out=%s. Resolve build may "
                        "interpret MarkIn/MarkOut differently; investigate "
                        "before trusting the render output."
                        % (abs_in, abs_out_incl, got_in, got_out))
                break
        else:
            log("Queued render job not found in GetRenderJobList (n=%d)" % len(jobs))
    except Exception as e:
        log("GetRenderJobList readback failed: %s" % e)
    if not job_id:
        raise RuntimeError(
            "AddRenderJob failed — Resolve did not accept the job. "
            "Open Deliver manually, verify the preset renders your range, and retry."
        )

    # ---- Kick off render ---------------------------------------------------
    start_rv = start_rendering_compat(proj, job_id)
    if not start_rv:
        # Log the full queue state so testers can see what Resolve thinks.
        _safe_call(lambda: log("Render job status: %s" % proj.GetRenderJobStatus(job_id)))
        raise RuntimeError(
            "StartRendering did not return a truthy value — the render queue "
            "rejected the job on this Resolve build. See log for details."
        )

    # Verify the render actually STARTED. On Resolve 20.3 we've seen
    # StartRendering return True while the job immediately transitions to
    # Failed — a 3s sanity window catches that before the long polling loop.
    time.sleep(3.0)
    started = False
    try:
        started = bool(proj.IsRenderingInProgress())
    except Exception as e:
        log("IsRenderingInProgress raised: %s" % e)
    status0 = _safe_call(lambda: proj.GetRenderJobStatus(job_id))
    log("Post-start: IsRenderingInProgress=%s, GetRenderJobStatus=%s"
        % (started, status0))
    if not started:
        # If the job is Complete already (tiny range) that's fine; anything
        # else after only 3s means it failed to kick off.
        job_state = (status0 or {}).get("JobStatus", "") if isinstance(status0, dict) else ""
        if job_state != "Complete":
            raise RuntimeError(
                "Render did not start (status=%s). Try running the render "
                "manually from Deliver to confirm the preset works." % job_state
            )

    log("Rendering started. Polling...")
    t0 = time.time()
    while True:
        try:
            in_progress = bool(proj.IsRenderingInProgress())
        except Exception as e:
            log("IsRenderingInProgress raised mid-poll: %s" % e)
            in_progress = False
        if not in_progress:
            break
        time.sleep(POLL_INTERVAL)
        if (time.time() - t0) % 10 < POLL_INTERVAL:
            log("  ...still rendering ({:.0f}s elapsed)".format(time.time() - t0))

    final_status = _safe_call(lambda: proj.GetRenderJobStatus(job_id))
    log("Render finished. Final status: %s" % final_status)
    if isinstance(final_status, dict):
        js = final_status.get("JobStatus", "")
        if js and js != "Complete":
            raise RuntimeError(
                "Render ended with status=%s. Full status: %s" % (js, final_status)
            )

    # Find produced file
    produced = None
    for name in sorted(os.listdir(source_dir)):
        if name.lower().startswith("reference"):
            produced = os.path.join(source_dir, name)
            break
    if produced is None:
        raise RuntimeError("No reference file produced in " + source_dir)
    log("Produced file: " + produced)

    # Normalize to reference.mp4
    normalized = os.path.join(source_dir, "reference.mp4")
    if produced != normalized:
        try:
            if os.path.exists(normalized):
                os.remove(normalized)
            os.rename(produced, normalized)
            produced = normalized
            log("Normalized filename to reference.mp4")
        except OSError as e:
            log("Rename skipped: " + str(e))

    # Write job.json
    job = {
        "project":         project_folder,   # sanitized folder name on disk
        "shot":            shot_name,
        "name":            "",       # user sets this in the Electron UI before rendering
        "width":           width,
        "height":          height,
        "fps":             fps,
        "duration":        duration_sec,
        "reference":       os.path.basename(produced),
        "referencePath":   produced.replace("\\", "/"),
        "aepPath":         os.path.join(ae_dir, shot_name + ".aep").replace("\\", "/"),

        # --- Resolve context (used by relink_latest_render.py) -------------
        # resolveProject keeps the RAW Resolve project name (case, spaces, etc.)
        # so relink_latest_render.py can verify the open project matches.
        "resolveProject":  resolve_project_name,
        "resolveTimeline": str(tl.GetName()),
        "markIn":          int(m_in),
        "markOut":         int(m_out),         # exclusive
        # MediaPoolItem unique ID of the imported AE render; filled in by
        # relink_latest_render.py on the first render, reused on subsequent ones.
        "resolveMediaPoolItemId": None,
        "resolveTrackIndex": 2,                # V2 by default
    }
    job_path = os.path.join(source_dir, "job.json")
    with open(job_path, "w", encoding="utf-8") as f:
        json.dump(job, f, indent=2)
    log("job.json written: " + job_path)

    log("==== export_range DONE OK ====")
    show_dialog("Chiral Network", "Export finished.\nShot: {}\nFolder: {}".format(shot_name, shot_dir))


# ---- Entrypoint with top-level trap ----------------------------------------
try:
    main()
except Exception as e:
    log("FATAL: " + str(e))
    log(traceback.format_exc())
    try:
        show_dialog("Chiral Network ERROR", str(e) + "\n\nSee log:\n" + LOG_PATH)
    except Exception:
        pass
