# chiral_version.py
# Shared version stamp for the Resolve-side Chiral Network scripts.
#
# Imported by export_range.py and relink_latest_render.py so the Electron
# app can read the installed scripts' version from one canonical place.
# When the Electron app upgrades, a startup check (main.js: checkScriptsVersion)
# compares this constant against the bundled scripts/ copy and nudges the
# user to "Update scripts" via the status strip if they diverge.
#
# Bumping rules:
#   * Bump on ANY change to the protocol between Electron and the Resolve
#     scripts (job.json schema, .relink.json shape, env-var contract).
#   * Bump on ANY behavioral change the user can observe (color tiers,
#     mark validation, dialog wording).
#   * Don't bump for pure-comment / log-string edits.

SCRIPT_VERSION = "0.5.0-dev13"
SCRIPT_NAME    = "Chiral Network — Resolve scripts"

# Supported Python range. dev48: a tester on Resolve 20 hit
# "ImportError: DLL load failed while importing fusionscript" with
# our previously vendored CPython 3.13 — Resolve's fusionscript native
# module is built against the CPython 3.10 ABI on Windows (the only
# Python version Blackmagic officially supports for Resolve scripting),
# so loading it from any other minor version blows up with a misleading
# "module could not be found" message. Vendored interpreter is now
# 3.10.11; this guard rejects anything outside that.
PY_MIN = (3, 10)
PY_MAX = (3, 10)
