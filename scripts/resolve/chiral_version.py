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

SCRIPT_VERSION = "0.5.0-dev16"
SCRIPT_NAME    = "Chiral Network — Resolve scripts"

# Supported Python range. dev60 — re-widened from (3,10)..(3,10) to
# (3,10)..(3,13) after confirming that Resolve 21's fusionscript.dll
# is built against the limited / stable ABI for Python 3.11+, while
# pre-Resolve-21 fusionscript directly links `python310.dll`. We now
# ship two embeddables under resources/vendor/python310 and
# resources/vendor/python313; the Electron side reads fusionscript's
# import strings at spawn time and routes the relink to whichever
# vendored interpreter matches. From the script's POV either is fine
# — this guard just warns when something *outside* the shipping pair
# is invoked (e.g. a developer running with system Python 3.14).
#
# History:
#   dev48: tightened to (3,10) after Virak (Resolve <21) hit
#          "ImportError: DLL load failed while importing fusionscript"
#          on the previously vendored 3.13 — fusionscript on his
#          machine wanted the 3.10 ABI specifically.
#   dev60: re-widened. Resolve 21's stable-ABI fusionscript ACCESS-
#          VIOLATES inside PyInit_fusionscript when called from 3.10
#          — opposite failure mode of dev48. Two shipping versions,
#          one heuristic picker.
PY_MIN = (3, 10)
PY_MAX = (3, 13)
