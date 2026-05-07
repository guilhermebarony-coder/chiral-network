<sub>🇺🇸 **English** &nbsp;·&nbsp; 🇧🇷 [Português](README.pt-br.md)</sub>

# Chiral Network

> **🚧 Status: 100% vibecoded, currently in Pre-Alpha.** Built end-to-end
> in a long-running pair-programming session with Claude. Things will
> break, change shape, and get rewritten. Tester feedback is the whole
> point of this stage — file issues freely.

> **Professional workflow automation bridge between DaVinci Resolve and
> Adobe After Effects.** Marks → comp → render → relink, end to end, in
> a single keystroke. Stay in your editor — Chiral Network handles the
> bookkeeping.

Chiral Network is a Windows Electron app that sits between Resolve and
After Effects. It watches Resolve for marked timeline ranges, hands the
clip to AE with a comp pre-built, polls for renders, and quietly
relinks the new master back into Resolve at the right frame — color-
coded by quality tier.

---

## Why "Chiral"?

The two halves of the workflow are mirror images of each other — a
Resolve shot in is an AE comp out, an AE render out is a Resolve clip
in. Chiral Network keeps the handedness consistent across the loop:
every Resolve-first shot knows how to find its AE comp, every AE-first
shot knows where to land in the Resolve timeline. The chirality is the
contract.

---

## Elevator pitch

Mark IN/OUT in Resolve, run **Workspace → Scripts → Utility →
export_range**. A new shot folder appears in your projects directory
with a `reference.mp4` from your timeline. Click **Open in After
Effects** in Chiral Network — AE launches with a 1080p comp pre-built,
the reference already imported. Animate. Hit **Render new version**.
AE renders detached; Chiral Network polls for completion and runs the
Resolve relink Python. Your Resolve timeline now plays the AE master
at the exact frame you marked.

Same workflow in reverse: open AE, click **New shot from AE** — the
bridge reads your active comp, builds a Resolve-shaped shot, and the
first render inserts into Resolve at the playhead.

---

## Three pillars

### 🔁 The AE ↔ Resolve Bridge

The core loop. Resolve-side Python (`scripts/resolve/`) talks to the
Studio scripting API. AE-side ExtendScript (`scripts/ae/`) drives After
Effects via `-r` dispatch. The Electron app (`app/`) is the conductor
that owns the on-disk shot model and routes events between the two.

Atomicity is enforced everywhere: `job.json`, `settings.json`,
`renderjob.json`, `.relink.json`, and `.render-progress.json` all use
tmp + fsync + rename. Detached AE renders stream progress through
`.render-progress.json` from inside the JSX, so the status strip shows
live `Rendering vXX · 12s elapsed (AE)` without IPC entanglement.
Stage-dir transactions (`.tmp_<shot>/` + atomic rename) mean a failed
AE handoff leaves nothing half-built in `projects/`.

### 📚 Vault Asset Management

A per-installation reusable asset library — backgrounds, layer
templates, lower-thirds, anything you'd otherwise re-import shot after
shot. Vault items render to thumbnails on ingest, carry searchable
metadata (name, tags, type, size), and one-click import into the
currently-open AE comp via the same ExtendScript channel as the bridge.

The Vault page (sidebar → **Vault**) supports both a card grid and a
dense list view (with `SIZE`, `MODIFIED`, `TYPE` columns), full-text
filter, and a soft-delete trash with 7-day retention. A Vault index
(`vault/.index.json`) is rebuilt opportunistically — re-scans only
when the underlying directory's mtimes have shifted.

### 📦 Version Tracking

Every render is a numbered version (`v01/`, `v02/`, …) inside the
shot. Each carries the master, an optional `.webm` preview, and a
`render.json` with format / scale / origin metadata that drives the
quality tier (Draft / Preview / High / Final) and the timeline color.

The version cards on the shot page surface all of this — pick any
prior version to make active, and Chiral Network re-runs the Resolve
relink to swap the timeline reference. Per-shot **sanity dots**
(red > yellow > green) aggregate from per-version health checks; the
project rail shows the worst dot per project so you can spot trouble
across an entire show at a glance.

---

## Other features worth calling out

- **Project Rail** — IDE-style vertical sidebar (240 px expanded,
  48 px collapsed), Hover-Peek as a floating overlay without
  reflowing the workspace.
- **Project Overview** — click a project name in the rail or
  breadcrumb for a card / list view of every shot, with active-
  version preview, batch select for bulk operations, and SIZE
  totals per shot.
- **Cross-project arrival banner** — when a render finishes for a
  shot in a project you're not currently in, you get a non-disruptive
  banner instead of being teleported there mid-edit.
- **Shot Jump Palette (Ctrl+Space)** — fuzzy-matched shot launcher.
  VS Code-style subsequence matching: `s10hr` matches
  `Shot_010_hero`. Pre-selects the current shot on open.
- **Origin badges** — `RV` (Resolve-first) and `AE` (AE-first) pills
  make the chirality visible in the rail, breadcrumb, and context
  menus.
- **Soft delete** — shot deletes go to a per-project `.trash/`
  with 7-day retention. Project deletes still show the path-aware
  warning dialog.
- **Filesystem-driven refresh** — `fs.watch` (debounced) replaces a
  3 s polling tick. Idle CPU footprint is essentially zero; the UI
  pauses watchers when the window is hidden.

---

## Installation prerequisites

| Component                        | Version            | Notes                                    |
|----------------------------------|--------------------|------------------------------------------|
| Windows                          | 10 or 11, 64-bit   | macOS support is on the roadmap.         |
| DaVinci Resolve / Resolve Studio | 18.6+ (20.x best)  | The Studio scripting API is required.    |
| Adobe After Effects              | 2022 or newer      | ExtendScript / `-r` dispatch is used.    |
| Python (vendored)                | **3.10.x**         | See note below.                          |
| ffmpeg                           | any recent build   | Optional — only for `.webm` previews.    |
| Node.js (dev only)               | 18 LTS or newer    | Not needed by end users.                 |

**Python 3.10 is required.** Resolve's `fusionscript.dll` is a CPython
C extension built against a single Python ABI on Windows — currently
3.10. The Chiral Network packaged build vendors CPython 3.10.11
inside `resources/vendor/python/` so you don't have to install
anything yourself. If you're running from source and the relink fails
with `ImportError: DLL load failed while importing fusionscript`, your
interpreter is the wrong minor version — drop a 3.10 embeddable into
`vendor/python/`.

The Setup Wizard handles all of this on first launch:

1. Detects an installed Python and registers it for Resolve scripting.
2. Optionally downloads a vendored Python and ffmpeg into `vendor/` so
   the app is self-contained.
3. Copies the Resolve-side scripts into Resolve's
   `%APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility/`.
4. Creates the projects root and seeds `config.json`.

If anything breaks later, the **Repair installation** button in the
overflow menu re-runs every step and reports per-component status.

---

## Where things live on disk

| Path                                     | What's there                                         |
|------------------------------------------|------------------------------------------------------|
| `%APPDATA%/Roundtrip/`                   | App config, logs, vault index. **Path is preserved from the pre-rename Roundtrip days so existing installs upgrade in place — that's intentional, not a stale reference.** |
| `%APPDATA%/Roundtrip/logs/relink.log`    | Resolve→AE relink Python output. First place to look on any "relink failed" error. |
| `%APPDATA%/Roundtrip/logs/export_range.log` | Resolve script for "send to AE".                  |
| `<projects root>/<project>/<shot>/`      | Per-shot folder: `source/`, `renders/v01..vNN/`, `.trash/` (soft-deleted shots), `job.json`. |
| `<projects root>/<project>/.vault/`      | Per-project asset library + thumbnails.              |
| `resources/vendor/python/`               | Vendored CPython 3.10 (in packaged builds only).     |
| `resources/vendor/ffmpeg/`               | Vendored ffmpeg (in packaged builds only).           |

---

## How to report issues

Chiral Network routes errors through one channel — the persistent
**status strip** along the bottom of the window. When something fails:

1. **Note the strip text** verbatim. Errors come in the form
   `<operation> failed: <reason>`.
2. **Pull the relevant log.** Logs live under `%APPDATA%/Roundtrip/logs/`:
   - `export_range.log` — Resolve script for "send to AE".
   - `relink.log` — AE→Resolve relink (per-render).
3. **Find the shot's `.relink.json`** if the failure was during a
   relink. It carries `{ ok: false, error: "<reason>" }` and is the
   most precise single-line postmortem we have.
4. **Open an issue** with:
   - The status-strip text.
   - The last ~30 lines of the relevant log.
   - The contents of `.relink.json` if applicable.
   - Your Resolve build (`Help → About`), AE version, and
     `python --version` from the vendored interpreter.

The **Repair installation** button (overflow menu, top-right) is the
right first step for anything that smells like an environment issue.

---

## Development

```bash
git clone https://github.com/guilhermebarony-coder/chiral-network.git
cd chiral-network
npm install --prefix app
npm start --prefix app
```

The Electron app lives in `app/`. The Resolve-side Python scripts live
in `scripts/resolve/`. The After Effects ExtendScript JSX files live
in `scripts/ae/`. Architecture notes are inline at the top of every
file — start with `app/main.js` and `app/lib/job.js` for the bridge,
then `scripts/resolve/relink_latest_render.py` for the Resolve half.

Tests are plain `node --test`:

```bash
cd app && npm test
```

`vendor/` (Python interpreter and ffmpeg) is intentionally
**not in the repo** — it's distributed via GitHub Releases as
`vendor.zip`. Drop the contents into `vendor/` after cloning to make
the app self-contained when running from source.

---

## Releases

Tester and production builds are attached as ZIPs / RARs on the
[Releases page](https://github.com/guilhermebarony-coder/chiral-network/releases).
Replace your existing `Chiral-Network-x.y.z-x64/` folder wholesale —
no settings migration is needed; user data lives in
`%APPDATA%/Roundtrip/` and survives between versions.

The current pre-alpha tester build is **0.5.0-dev51**. See
[`CHANGELOG.md`](CHANGELOG.md) for the full version history.

---

License: MIT (see [LICENSE](LICENSE)).
