# test_resolve_script.py
# Minimal "does Python run at all?" probe for Resolve.
#
# Install:
#   Copy to:
#     %APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility/
#   Restart Resolve, then run:
#     Workspace > Scripts > Utility > test_resolve_script
#
# Expected on success:
#   * A popup appears with "Python script executed"
#   * A file exists at one of:
#       %TEMP%/resolve_python_test.txt
#       F:/CLAUDE/roundtrip_root/scripts/resolve/resolve_python_test.txt
#       %USERPROFILE%/resolve_python_test.txt
#
# Using line comments instead of a docstring because some paths contain
# sequences like \U (as in \Utility) that break non-raw string parsing.

import os
import sys
import time
import traceback

MARKER_MSG = "script executed successfully"


def write_marker():
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    body = (
        "{}\n"
        "timestamp: {}\n"
        "python: {}\n"
        "executable: {}\n"
        "cwd: {}\n"
        "__file__: {}\n"
    ).format(
        MARKER_MSG,
        stamp,
        sys.version.replace("\n", " "),
        sys.executable,
        os.getcwd(),
        globals().get("__file__", "<unknown>"),
    )

    # All paths below are either raw strings or built with os.path.join,
    # so no backslash-escape issues.
    temp_dir = os.environ.get("TEMP") or os.environ.get("TMP") or r"C:\Windows\Temp"
    home_dir = os.path.expanduser("~")

    candidates = [
        os.path.join(temp_dir, "resolve_python_test.txt"),
        r"F:\CLAUDE\roundtrip_root\scripts\resolve\resolve_python_test.txt",
        os.path.join(home_dir, "resolve_python_test.txt"),
    ]
    written = []
    for p in candidates:
        try:
            parent = os.path.dirname(p)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(body)
            written.append(p)
        except Exception as e:
            written.append("FAILED " + p + " : " + str(e))
    return written, body


def popup(title, message):
    """Best-effort popup via Fusion's AskUser. If it fails, silently skip —
    the marker file is the authoritative success signal."""
    targets = []
    for name in ("fusion", "fu"):
        if name in globals() and globals()[name] is not None:
            targets.append(globals()[name])
    try:
        r = globals().get("resolve")
        if r is not None:
            targets.append(r.Fusion())
    except Exception:
        pass
    for t in targets:
        try:
            t.AskUser(title, {1: {1: "Text", "Name": "msg", 2: message,
                                  "ReadOnly": True, "Lines": 6}})
            return True
        except Exception:
            try:
                t.AskUser(title, {1: {1: "Label", "Name": "msg", 2: message}})
                return True
            except Exception:
                continue
    return False


# ---- Run -------------------------------------------------------------------
try:
    paths, body = write_marker()
    popup_msg = "Python script executed\n\nFiles written:\n" + "\n".join(paths)
    popup("Resolve Python Test", popup_msg)
except Exception:
    try:
        temp_dir = os.environ.get("TEMP") or r"C:\Windows\Temp"
        tb_path = os.path.join(temp_dir, "resolve_python_test_TRACEBACK.txt")
        with open(tb_path, "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
    except Exception:
        pass
