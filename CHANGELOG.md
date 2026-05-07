# Changelog

All notable changes to **Chiral Network** are documented here. The project
began life as the *Roundtrip* MVP and was rebranded as Chiral Network at
v0.4.4 once the architecture stabilised. Pre-rename history is included
below for context — the on-disk config keys (`roundtripRoot`,
`%APPDATA%/Roundtrip/`) are intentionally preserved so existing
installations upgrade in place.

The format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [SemVer](https://semver.org/) (loosely; pre-1.0 minor
bumps may break disk format).

---

## [0.5.0-dev50] — 2026-05-07 — **UI overhaul, manual AE selection & bilingual docs**

First public-facing pass after the GitHub push. Three threads:
docs go bilingual + Pre-Alpha-honest, the Setup Wizard gets
rebranded and restyled to match the main app, and the AE detector
stops silently picking the newest install.

### Added — bilingual README

- `README.md` now opens with a language switcher
  (🇺🇸 English · 🇧🇷 Português) and a "100% vibecoded, Pre-Alpha"
  status banner so first-time visitors don't mistake the polish for
  shipping-readiness.
- `README.pt-br.md` — full Brazilian Portuguese translation of the
  English README. All three pillars (AE↔Resolve Bridge, Vault Asset
  Management, Version Tracking), feature list, prerequisites,
  on-disk layout, issue-reporting protocol, and dev quickstart are
  translated end to end. Path names, config keys, and code blocks
  are preserved verbatim.

### Added — manual After Effects version selector

`scripts/ae/`'s ExtendScript dispatch and the AE-side handlers can
only talk to one After Effects instance at a time, but VFX
machines routinely have 2 + AE versions installed (an old "render
farm" 2022 next to a current 2025 for new work). Pre-dev50 we
silently picked the newest year. dev50 surfaces the choice:

- `app/lib/detect.js` — `detectAfterEffects()` now returns
  `{ path, source, versions: [{ path, year, label }] }`. `path` is
  preserved as the newest install (backward compat: every existing
  caller that only reads `.path` keeps working). `versions` is
  newest-first and includes every "Adobe After Effects YYYY"
  install under `C:\Program Files\Adobe`.
- `app/wizard.html` + `app/wizard.js` — Step 1 reveals an
  "After Effects version" dropdown when `versions.length > 1`. The
  dropdown defaults to the newest install (or the user's previously-
  configured choice in edit mode). Single-install machines never
  see the dropdown.
- `wizard.js` updates `state.aePath` on every `change` event and
  re-paints the Step 1 row detail so the user has immediate
  feedback that their pick was registered before they advance.

### Changed — Setup Wizard rebrand + industrial restyle

- All "Roundtrip" UI strings replaced with "Chiral Network" across
  `app/wizard.html`, `app/wizard.js`, and the user-facing dialog
  titles in `app/main.js` (window title, root-picker dialog,
  reset-confirm dialog, error messages).
- Wizard CSS rewritten to match `app/index.html`'s palette:
  oklch gold accent (`--accent: oklch(0.8 0.13 75)`), monochrome
  surfaces, thin borders, no gradients. Inter for UI text,
  JetBrains Mono for paths/values.
- "4 step dots" → an energy-style segmented progress bar (4 thin
  full-width segments + an uppercase label row underneath).
  Active segment glows with a soft accent shadow; done segments
  stay accent-tinted. Reads at peripheral vision.
- A **Brand strip** at the top: `CHIRAL NETWORK` (with the "Chiral"
  half in accent gold) on the left, `Setup · Pre-Alpha` on the
  right — sets context once and disappears into the chrome.

### Changed — dependency block reflects vendored reality

The wizard's checklist no longer treats Python and FFmpeg as
"hopefully you have these installed". Both ship inside the app
under `resources/vendor/`, so the rows now carry a small
`[VENDORED]` pill and helper copy that reflects what's actually
true:

- **Python 3.10** — labeled "Python 3.10" (was "Python (required
  for Resolve scripting)"). The Step 1 row description distinguishes
  between two states: registered with Windows for Resolve discovery
  (✓) vs. only running the bridge internally (⚠). The "Install
  Python" button is renamed "Register for Resolve" — that's
  literally what it does (the embed is already there, the registry
  key is what's missing).
- **FFmpeg** — labeled with the `[VENDORED]` pill. The "warn"
  branch is now reachable only if the vendored copy is missing,
  which would be a packaging bug rather than a tester problem.

### Preserved — on-disk paths & config keys

The internal `roundtripRoot` config key, the `%APPDATA%/Roundtrip/`
runtime path, and the `defaultRoundtripRoot()` function name are
**not** renamed. These are the upgrade-in-place contract for users
on dev1–dev49 builds; renaming them would orphan their existing
config and trash data. Documented in both READMEs.

### Files

- `app/wizard.html` — full rewrite (172 → ~280 lines), industrial
  restyle, AE version dropdown, vendored pills, brand strip.
- `app/wizard.js` — adds `state.aeVersions`,
  `populateAeVersionDropdown()`, `aeDetailLabel()`, energy progress
  helpers; copy updates throughout.
- `app/lib/detect.js` — `detectAfterEffects()` now returns the
  versions array (additive change, no breaks).
- `app/main.js` — five UI string updates (window title, dialog
  titles, error messages). No logic changes.
- `app/package.json` — version dev49 → dev50.
- `README.md` — language switcher + Pre-Alpha banner.
- `README.pt-br.md` — new file.
- `CHANGELOG.md` — this entry.

---

## [0.5.0-dev49] — 2026-05-07 — **Overview ↔ shot navigation: stale-shot blink fix**

Tester report: "whenever I switch between overview/shot, one other
shot page blinks for a second." Reproduced — and it had three
copies of the same root cause across three click handlers.

### Root cause

`refresh()` already owns `#shot-ui` visibility (it's the canonical
toggle: hides on no-project / no-shots / overview-active, shows
otherwise — the line `$('shot-ui').style.display = noShots ? 'none' : ''`
sits adjacent to the title/breadcrumb writes, so the user never
sees stale DOM through it).

But three navigation handlers were *also* setting
`$('shot-ui').style.display = ''` themselves, **before** awaiting
`refresh()`:

  1. Overview list-row click  → selectProject → selectShot → display='' → refresh
  2. Overview grid-card click → selectProject → selectShot → display='' → refresh
  3. Sidebar rail shot click  → selectProject → selectShot → display='' → refresh

The `selectProject + selectShot` IPC pair is async and takes a
real, visible chunk of time. During that window `#shot-ui` was
already revealed but still painted with the **previously-pinned
shot's** DOM (title, breadcrumb, version cards, badges) — that's
the "another shot blinks for a second" the tester saw. Then
`refresh()` finally landed and the DOM snapped to the actually-
selected shot.

### Fix

Removed the explicit `$('shot-ui').style.display = ''` from all
three handlers. `refresh()` is the only place that writes that
property now. The exposure window for stale shot DOM during a
navigation shrinks from
**"selectProject IPC + selectShot IPC + refresh paint time"** to
**"~zero"** (refresh's display-toggle is microtask-adjacent to its
title/breadcrumb/badge writes).

`closeProjectOverview()`'s display='' (in the `keepHidden:false`
branch) is unaffected — that path doesn't change which shot is
pinned, so there's no stale shot to leak.

### Files

- `app/index.html`: 3 handlers cleaned up; comments explain why
  the line is *missing* (so a future reader doesn't add it back).

---

## [0.5.0-dev48] — 2026-05-06 — **Vendored Python downgrade to 3.10 (Resolve fusionscript ABI fix)**

First field-reported regression on the dev47 tester build. Surfaced
on a clean Resolve 20 install — relink crashed with:

```
ImportError: DLL load failed while importing fusionscript:
The specified module could not be found.
```

`%APPDATA%/Chiral Network/logs/relink.log` showed the wrapper module
(`DaVinciResolveScript.py`) being found and sys.path injection
succeeding, but `import fusionscript` failing inside it. That error
is misleading: Windows reports "module could not be found" for any
unresolvable native import, including ABI mismatch on the target
itself.

### Root cause

Resolve's `fusionscript.dll` is a CPython C extension built against
**a single Python ABI** — Blackmagic ships it built for 3.10 only on
Windows (3.6 and 3.10 historically, 3.10 currently). Our vendored
interpreter was 3.13.13, so the binding load failed. The version
guard at the top of the script (PY_MAX = (3,13)) logged
"within supported range" — wishful, not verified — which is why
this slipped past dev-machine testing where Resolve happened to be
absent or stubbed.

### Changed — vendored interpreter

- `vendor/python/`: replaced **CPython 3.13.13** embeddable with
  **CPython 3.10.11** embeddable (official Windows amd64 embed zip).
  Same packaging path (electron-builder `extraResources`), same
  spawn contract from `app/main.js`. Tester does **not** need to
  install Python — interpreter is bundled inside
  `resources/vendor/python/python.exe` as before.

### Changed — version guard

- `scripts/resolve/chiral_version.py`: `PY_MAX` tightened from
  `(3, 13)` to `(3, 10)`. Comment rewritten to record the dev48
  finding so we don't re-widen this on a hunch later.
- Inline fallback constants in `relink_latest_render.py` and
  `export_range.py` updated to match (the fallback is used when
  `chiral_version` itself fails to import — Resolve's "Utility"
  folder install copies scripts individually).
- `chiral_version.SCRIPT_VERSION` bumped 0.5.0-dev7 → 0.5.0-dev8
  so the Electron-side scripts-version check picks up the change.

### Notes for testers

- Replace your `Chiral-Network-0.5.0-dev47-x64` folder wholesale
  with `Chiral-Network-0.5.0-dev48-x64`. No settings migration.
- If relink still fails with the same error, the log will now also
  show the actual interpreter version — please attach
  `%APPDATA%/Chiral Network/logs/relink.log`.

---

## [0.5.0-dev47] — 2026-05-04 — **Soft-shot-delete dialog cleanup — pre-alpha tester build**

Last item from the pre-alpha audit (🔴 #6) and the build that closes
out the entire 🔴 list. This is the first compiled drop intended for
real users (testers).

### Changed — shot delete dialog

dev35 made shot delete a soft 7-day operation, but the confirm
dialog still went through `path:deletePreview` and read like a
warning before destruction (path display, "WARNING: N .aep files",
etc.). For a recoverable op, that's the wrong tone — and one extra
IPC per delete.

```diff
  async function confirmAndDelete(target) {
-     const preview = await window.api.deletePreview(target);     // always
-     // …builds one dialog with branching copy for project vs shot…
+     const isProject = !target.shot;
+     if (isProject) {
+         // Hard delete: path-aware dialog with .aep warning.
+         const preview = await window.api.deletePreview(target);
+         // …project copy unchanged…
+     } else {
+         // Soft delete: skip the preview IPC, simpler dialog.
+         cd = await window.api.confirmDialog({
+             title:   'Move shot to trash',
+             message: 'Move shot "X" from project "Y" to trash?',
+             detail:  'Recoverable for 7 days from the shot trash drawer.',
+             confirmLabel: 'Move to trash',
+         });
+     }
+     // …rest of the flow unchanged…
  }
```

| Path           | IPC calls | Dialog tone |
|----------------|-----------|-------------|
| Shot (soft)    | 1 (confirm only) | "Move to trash" — calm |
| Project (hard) | 2 (preview + confirm) | Path display + .aep warning + "cannot be undone" |

Project deletes keep the full path-aware ceremony — they're still
irreversible. `path:deletePreview` is still wired (for project
deletes) so the IPC handler isn't dead code.

### Audit completion

Status of the pre-alpha audit (dev42's report):

- 🔴 #1 — 3s polling tick → fs.watch + visibility pause **(dev43)**
- 🔴 #2 — Cross-project banner instead of forced jump **(dev44)**
- 🔴 #3 — Render Settings disclosure **(dev45)**
- 🟡 #12 — `Name:` → `Filename tag` rename **(dev45)**
- 🔴 #4 — Vault submenu **(dev46)**
- 🔴 #5 — System menu split **(dev46)**
- 🔴 #6 — Soft-delete dialog cleanup **(dev47)**

All 🔴 items from the audit are now landed. The 🟡 list (sortable
overview headers, vault batch trash, terminology lock, etc.) and
the 🟢 list (CSS hex/oklch unification, lib_pipeline split, etc.)
ride post-alpha based on tester feedback.

### Preserved invariants

- `path:deletePreview` IPC handler is unchanged and still used by
  project delete. No dead handlers.
- `confirmAndDelete` arg shape unchanged — every call site
  (overflow menu, rail context menu, project context menu)
  continues to work without changes.
- 149 / 149 tests passing.

### Tester notes

- This is the first build past dev42's audit. Idle CPU on a
  5-project / 30-shot install is now near-zero (was ~150 syscalls /
  3s pre-dev43).
- Cross-project arrivals show a banner, not a teleport.
- Render Settings starts collapsed by default — open via the `▸`
  caret if you want to change Format / Quality / Track / Filename
  tag.
- Reset, Repair, Setup Wizard moved to the top-right `⚙` icon. The
  shot overflow menu is now 5 items.
- Shot trash + cross-project banner + project overview all reachable
  via the rail.

---

## [0.5.0-dev46] — 2026-05-04 — **Vault submenu + system menu split**

Items #4 and #5 from the pre-alpha audit (🔴). Two changes that
together cut the shot overflow menu from **13 entries** down to
**5**, and move every destructive app-level button (Reset,
Repair, Setup Wizard) into its own popover so they can't be
mis-clicked next to "Force relink" / "Delete shot."

### Changed — overflow menu (shot-scoped only)

```
BEFORE                                  AFTER
─────────────────────────                ────────────────────────
📁 Open shot folder                     📁 Open shot folder
📁 Open project folder                  📁 Open project folder
───                                     ───
🗄 Open Vault…                           🗄 Vault ▸
↑ Vault this shot                              Open Vault…
↑ Vault marked clips/templates…                Vault this shot
✓ Mark for batch vault                         Vault clips/templates from this shot…
⇧ Vault marked shots in project                ───
───                                            ☐/✓ Mark this shot for batch
⚙ Setup Wizard…                                 Run batch on marked shots…
🔧 Repair installation                  ───
↺ Reset setup…              ← danger    ↻ Force relink (reconnect)
───                                     ───
↻ Force relink (reconnect)              Delete shot…             ← danger
───
Delete shot…                ← danger
```

13 entries → **5 visible items + one expand-on-demand submenu**.

### Added — Vault submenu (`<details>` inline expand)

The 5 vault-bound entries now live behind a single `Vault ▸` row.
Clicking the row toggles a nested group via a native `<details>`
element. Why `<details>` over a side-flyout?

- **Keyboard accessible by default** (Enter on `<summary>` toggles).
- **No CSS hover gymnastics** — flyouts that depend on hover are
  brittle on click-driven menus and on touch.
- **Renders inline** so the parent menu doesn't need to know how
  wide its children are.

The summary intercepts its own click (`stopPropagation`) so the
parent overflow menu doesn't close while the user expands the
submenu. Any button INSIDE the submenu still bubbles up — clicking
"Vault this shot" closes the menu and runs its action, exactly
like before.

#### Mark-for-batch indicator

Pre-dev46 the entry showed `✓ Mark for batch vault` regardless of
state. dev46 paints a real toggle indicator via CSS:

```css
#btn-toggle-vault-marked::before                       { content: '☐ '; color: var(--fg-3); }
#btn-toggle-vault-marked[data-marked="true"]::before   { content: '✓ '; color: gold; }
```

`refreshVaultMenuState()` (the existing precondition checker) now
also reads `info.vaultMarked` and stamps the `data-marked`
attribute. The toggle handler keeps the menu OPEN
(`stopPropagation`) so users see the indicator flip without
re-opening — a small touch but it makes the toggle feel alive.

### Added — System menu (top-right cog)

```
┌─ ⚙ ───────────────────────────┐
│ ⚙ Setup Wizard…               │
│ 🔧 Repair installation         │
│ ───                            │
│ ↺ Reset setup…   ← danger      │
└────────────────────────────────┘
```

Anchored top-right at `position:fixed; right:38px;` (just left of
the version label). Same `.overflow-menu` shell as the shot
overflow so the visual style is unified. Three items:

- Setup Wizard
- Repair installation
- ─── separator
- Reset setup (danger-styled)

The popover-discipline rule is "only one menu visible at a time":
opening the system menu closes the shot overflow, and vice versa.
A single `document.click` handler dismisses both.

### Why this matters

Pre-dev46, "Reset setup" sat 4 rows below "Force relink" in a
13-item menu. Mis-clicking by one row triggered a destructive
flow that wipes config + may delete projects depending on user
choices in the Reset dialog. **Different scope** (Reset is
app-level, the rest is shot-level) **and** **different blast
radius** (Reset is irreversible, Force relink is a no-op when
nothing's offline). dev46 separates the two surfaces entirely.

### Preserved invariants

- **Zero IPC change.** Every button keeps its old ID and onclick
  handler. The `setName` / `setRenderFormat` / `setVaultMarked` /
  `app:repair` / `app:reset` / etc. handlers are all reachable
  through their original wiring.
- AE-busy CSS guard (dev20 — greys out `#btn-vault-this-shot`,
  `#btn-vault-clips`, `#btn-vault-project` while a script is
  running) still matches because the IDs are unchanged.
- 149 / 149 tests passing.

### Deferred (audit follow-ups)

- 🔴 #6 — Drop `path:deletePreview` for soft-shot deletes
  (last 🔴 item).

---

## [0.5.0-dev45] — 2026-05-04 — **Render Settings disclosure + Filename tag rename**

Third + twelfth items from the pre-alpha audit (🔴 #3 + 🟡 #12).
The pre-dev45 shot view had ~12 always-visible interactive
elements before the user could *do* anything: a confusing "Name:"
field, a Format dropdown, a 4-step Quality slider, and a Track
dropdown — all permanent. 95% of users set those four controls
once per project and never touch them again.

### Changed — Filename tag (was: `Name:`)

| Field   | Before          | After           |
|---------|-----------------|-----------------|
| Label   | `Name:`         | `Filename tag`  |
| Hint    | `affects future render filenames` | `appended to render filenames` |
| Tooltip | (none)          | `Appended to render filenames so you can tell versions apart on disk. Doesn't rename the shot itself.` |

The IPC handler is still `setName` (no API churn) — only the
visible string changed. The previous label suggested the field
renamed the shot itself; users would type `"shot 1"` and be
surprised when nothing visible changed.

### Added — Render Settings disclosure (`<details>`)

Filename tag, Format, Quality, and Resolve track all moved into
a collapsible `<details>` block titled `▸ Render settings`. The
primary shot view now shows only:

- Breadcrumb / sanity dot / origin badge / spec lock
- Banners (warn / project / arrival)
- Action row (Send / Render / Send to Resolve)
- Status strip
- Versions grid

…in that order. Render Settings sits between the action row and
the breadcrumb (logically: *"this is what controls those
buttons"*), closed by default.

#### Summary line when collapsed

When the disclosure is closed, the summary row reads:

```
▸ RENDER SETTINGS    ProRes 4444 · 100% · V2 · "lower_third"
```

— so users still see what's configured at a glance without
having to expand. Updated in `refresh()` and on every
`onchange` of the inner controls.

#### State persistence

Open/closed state lives at `localStorage['renderSettings.open']`
(`'1'` / `'0'`). Per-window, NOT per-shot — the user's
preference for "I don't want to see render settings" is global,
not local. Persisted across sessions.

```js
const RS_OPEN_KEY = 'renderSettings.open';
$('render-settings').open = localStorage.getItem(RS_OPEN_KEY) === '1';
$('render-settings').addEventListener('toggle', () => {
    localStorage.setItem(RS_OPEN_KEY, $('render-settings').open ? '1' : '0');
});
```

### Visual treatment

Labels inside the disclosure are uppercase 10.5px, color
`#777` — distinctly lighter than the action-row buttons (white
text on coloured backgrounds) so the visual hierarchy reads
*"primary actions vs secondary settings"* without thinking.

The native `<details>` disclosure triangle is suppressed
(`list-style: none` + `::-webkit-details-marker { display: none }`)
in favour of a custom `▸` caret that rotates 90° on open via a
100ms CSS transform. No layout-thrashing animation; the body
just appears.

### Preserved invariants

- All four control IDs (`anim-name`, `format-select`,
  `scale-slider`, `scale-label`, `track-select`) are unchanged.
  `refresh()` and the existing onchange handlers
  (`setName` / `setRenderFormat` / `setRenderScale` / `setTrack`)
  bind to them exactly as before — zero IPC change.
- Disclosure starts CLOSED for new installs (no key set →
  `=== '1'` is false). Existing users get the same closed-by-
  default experience first time they launch the new build.
- 149 / 149 tests still passing.

### Deferred (audit follow-ups)

- 🔴 #4 — Vault submenu (5 vault entries → 1 submenu).
- 🔴 #5 — Move Setup Wizard / Repair / Reset out of the shot overflow menu.
- 🔴 #6 — Drop `path:deletePreview` for soft-shot deletes.

---

## [0.5.0-dev44] — 2026-05-04 — **Cross-project arrival → banner, not teleport**

Second item from the pre-alpha audit (🔴 #2). The pre-dev44 rule was:
*"if a brand-new shot appeared in any project and the user hasn't
explicitly pinned a selection, switch to it."* Trust-breaking on a
multi-project install — a user mid-edit in `proj_a` could find
themselves teleported into `proj_b` because someone's
`export_range.py` ran 12 seconds earlier on a different show.

### Added — `lib/arrival_policy.js`

Pure decision function `classifyArrival({newArrival, currentProject, currentShot})`
returning one of four outcomes:

| `newArrival` | `currentShot` | sameProject? | → outcome |
|--------------|---------------|--------------|-----------|
| null         | *             | *            | `none` |
| {…}          | null          | n/a          | `auto-jump` |
| {…}          | set           | yes          | `intra-project` |
| {…}          | set           | no           | `cross-project-banner` |

The policy is one self-contained file so the rule is a unit-testable
table rather than scattered conditionals.

### Changed — `shot:info` no longer mutates state on cross-project arrivals

```diff
  const newArrival = detectNewShotAcrossProjects();
- if (newArrival && !userSelectedProject && !userSelectedShot) {
-     if (newArrival.project !== currentProject) {
-         currentProject = newArrival.project;
-         writeSettings(...);
-         lastKnownShots = [];
-     }
-     currentShot = newArrival.shot;
- }
+ const decision = ARRIVAL.classifyArrival({ newArrival, currentProject, currentShot });
+ if (decision === 'auto-jump') {
+     // …same as before, but ONLY on true cold start
+ } else if (decision === 'cross-project-banner') {
+     _pendingArrival = { project, shot };
+     if (key !== _broadcastedArrivalKey) {
+         _broadcastedArrivalKey = key;
+         broadcastCrossProjectArrival(_pendingArrival);
+     }
+ }
```

The intra-project arrival rule (lines 360-365 in the new code) is
**unchanged** — `userSelectedShot` still gates the "newest on arrival"
auto-pick within the current project. dev44 only re-routes
cross-project arrivals.

### Added — banner UI

```
┌──────────────────────────────────────────────────────────┐
│ 📥 New shot Shot_005 appeared in proj_b.   [Switch] [Dismiss]│
└──────────────────────────────────────────────────────────┘
```

Indigo (cool) tone so it reads as **informational**, not warning —
existing warn / proj banners are warm/red-tinted, this one needed
to feel passive. Shows up between the breadcrumb and the action
row, so it's right where the user's eyes already are. Hidden by
default; flips to `display:flex` when a payload arrives.

### Lifecycle

| Trigger                                         | Effect on pending arrival |
|-------------------------------------------------|---------------------------|
| `cross-project:arrival` broadcast               | sets `_pendingArrival`, `_broadcastedArrivalKey` |
| `arr-switch` button → selectProject + selectShot | both handlers clear pending |
| `arr-dismiss` button → `crossProject:dismiss` IPC | clears pending; same-shot arrivals don't re-broadcast, but a NEW shot does |
| `project:select` (any path)                     | clears pending |
| `shot:select` (any path)                        | clears pending |

`_broadcastedArrivalKey` is the dedupe — without it every
`shot:info` call (which now fires on every fs.watch push from dev43)
would re-broadcast the SAME arrival 5+ times. The key is
`project + '/' + shot`; cleared on dismiss/switch/select so a NEW
arrival re-broadcasts cleanly.

### Added — boot-race rehydrate

The watcher can fire (and main can broadcast) before the renderer
finishes mounting and registers `onCrossProjectArrival`. New IPC
`crossProject:peek` returns the current `_pendingArrival` (or null);
the renderer calls it once after mount to catch any in-flight
pending. Without this, a banner would silently disappear on cold
boot if the watcher beat the listener.

### Tests

`test/arrival_policy.test.js` — 5 new tests:

- no arrival → `none`
- cold start (no shot pinned) → `auto-jump` regardless of project match
- on a shot, arrival in SAME project → `intra-project`
- on a shot, arrival in DIFFERENT project → `cross-project-banner`
- pure function (same inputs → same output)

Suite: 149 / 149 (was 144 + 5 new).

### Preserved invariants

- dev43 fs.watch + push pipeline is **unchanged**. The new banner
  rides on top — every push runs `shot:info`, `shot:info` runs the
  arrival policy, and the broadcast (or auto-jump) happens once.
- The dev20 800ms AE-scripting cooldown is untouched (this dev
  doesn't go near the spawn lock).
- No mutation of `userSelectedProject` / `userSelectedShot` outside
  the existing IPC handlers — the banner buttons only call public
  IPCs (`project:select`, `shot:select`, `crossProject:dismiss`).
- 149 / 149 tests passing.

### Deferred (audit follow-ups)

- 🔴 #3 — Render Settings disclosure (collapse Format/Scale/Track + `Name:` field).
- 🔴 #4 — Vault submenu (5 vault entries → 1 submenu).
- 🔴 #5 — Move Setup Wizard / Repair / Reset out of the shot overflow menu.
- 🔴 #6 — Drop `path:deletePreview` for soft-shot deletes.

---

## [0.5.0-dev43] — 2026-05-04 — **Drop the 3s polling tick — fs.watch + visibility pause**

First item from the pre-alpha audit (🔴 #1). The 3-second
`setInterval(refresh, 3000)` was the single biggest performance
debt — every tick walked every project's `renders/`, read every
`job.json`, and ran `computeSanity` per shot. A 5-project /
30-shot install was ~150 stat+open syscalls every 3 seconds, on
the main thread, on idle.

### Added — `lib/watch.js#createWatcher`

Tiny wrapper around `fs.watch({ recursive: true })` with three
contract additions:

1. **Debounce.** Windows `fs.watch` fires multiple events per
   logical change (write → rename → truncate). The wrapper
   coalesces all events within a quiet-window into one
   `onChange()` call.
2. **Graceful failure.** Missing dir / unreadable / network
   share that throws → returns a no-op handle so callers don't
   need to null-check. Callers add the dir first; if it later
   exists, applyConfig rebuilds the watcher.
3. **Self-healing.** On a watcher `'error'` event the wrapper
   closes itself and logs. The renderer's 30s safety tick
   catches missed events until the next applyConfig rebuild.

### Added — push-based refresh in main.js

`rebuildWatchers()` installs two debounced watchers in
`applyConfig`:

| Tree                  | Debounce | Channel             |
|-----------------------|----------|---------------------|
| `PROJECTS_DIR`        | 250 ms   | `projects:changed`  |
| `<vaultRoot>/assets/` | 500 ms   | `vault:changed`     |

Both broadcast to every `BrowserWindow`. Renderers listen via
`window.api.onProjectsChanged` / `window.vault.onVaultChanged`
(new preload exports).

The watchers are torn down + rebuilt on every `applyConfig` call
so wizard re-runs that change `roundtripRoot` / `vaultRoot` get
fresh watchers, not zombie ones. `app.on('before-quit')` closes
them too.

### Changed — renderer refresh tick is now a 30s SAFETY net

```diff
- refreshInterval = setInterval(refresh, 3000);
+ const REFRESH_SAFETY_MS = 30000;
+ refreshInterval = setInterval(refresh, REFRESH_SAFETY_MS);
```

Why keep ANY tick? Two reasons:

1. fs.watch on network drives / SMB shares occasionally drops
   events. A backstop catches those.
2. AE-running detection (`info.aeRunning`) isn't tied to
   filesystem changes. It only flips when AE launches / quits.
   30 s currency on the "Open in AE" button label is fine.

The tick is paused while the window is hidden. A minimised app
pays **zero** CPU.

```js
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopRefreshInterval();
    } else {
        refresh();
        startRefreshInterval();
    }
});
```

`refresh()` on visibility-return ensures the UI is never stale
when the user comes back from another window. Same pattern in
`vault.html`.

### Renderer-side coalescing

Each watcher push schedules a refresh through a small in-renderer
debounce (80–100 ms) on top of the main-side debounce. Reason:
even after the main-side coalesce, the renderer might still get
two pushes in rapid succession (e.g. a save followed by a sidecar
write). Double-debouncing is cheap insurance.

### Performance impact (idle, 5-project / 30-shot install)

| State              | Before (3s tick) | After (push + 30s safety) |
|--------------------|------------------|---------------------------|
| Idle / focused     | ~150 syscalls / 3 s | 0 syscalls    |
| Idle / hidden      | ~150 syscalls / 3 s | 0 syscalls    |
| Active rendering   | ~150 syscalls / 3 s + the actual work | ~3-10 syscalls per debounced batch |

The "before" numbers are a stat+open per shot's `job.json` plus a
walk of every `renders/` dir. The "after" numbers represent the
actual `shot:info` cost run only when something changed.

### Tests

`test/watch.test.js` — 7 new tests covering the wrapper contract:

- noop handle for missing / null dir
- single fire after a single write
- coalesces a burst of 5 writes into one fire
- two writes outside the debounce window → two separate fires
- `close()` stops further fires
- `close()` is safe to call multiple times

Suite: 144 / 144 (was 137 + 7 new).

### Preserved invariants

- Every IPC the renderer used to call on the tick still works.
  The tick *cadence* changed; the IPC surface didn't.
- `emitStatus` and `broadcastAEBusy` still reach every window.
- `applyConfig` is still idempotent — calling it N times wires N
  watchers but always closes the previous handle first.
- 144 / 144 tests passing.

### Deferred (audit follow-ups)

- 🔴 #2 — cross-project auto-jump should be a banner, not a
  forced navigation.
- 🔴 #3 — Render Settings disclosure (collapse Format/Scale/Track
  + `Name:` field).
- 🔴 #4 — Vault submenu (5 vault entries → 1 submenu).
- 🔴 #5 — Move Setup Wizard / Repair / Reset out of the shot
  overflow menu.
- 🔴 #6 — Drop `path:deletePreview` for soft-shot deletes.

---

## [0.5.0-dev42] — 2026-05-04 — **Overview: video cache + drop hover translateY**

User report: *"when i go to the list view, then back, the jitery
comes back — all previews get black and when i hover, feels like
every card moves on the hover animation, but a random one."*

The dev41 fix decoupled the overview from the 3s tick, but it
didn't address WHAT happens on the explicit re-renders that DO
fire (view-toggle, filter, post-delete). Each one wiped
`#po-rows` and rebuilt every card from scratch — including new
`<video>` elements. That caused two distinct symptoms:

1. **Black flash on every preview.** New `<video>` elements
   re-fetch the moov atom; the first frame doesn't render until
   that completes (a few hundred ms on Windows). Until then the
   tile shows the bare `#0e0e0e` placeholder. Result: every
   preview "blackens" on every view-toggle.
2. **"A random card moves on hover."** The hover style had
   `transform: translateY(-1px)` with `transition: …, transform
   120ms`. When cards rebuild under an existing cursor, the
   FRESH DOM node has `:hover` applied immediately by the browser
   — and the transition fires mid-render, so the user sees a
   card animating in even though they didn't move the cursor.
   Reads as "random" because which card is under the cursor at
   the moment of rebuild is unpredictable.

### Fixed — `<video>` cache keyed by shot name

`_overviewVideoCache` (a `Map<shotName, {video, src}>`) holds the
elements across re-renders. `getCachedVideo(shotName, src)`
returns the existing one when src matches; otherwise creates a
fresh one and stores it. Reattaching the element to a new parent
preserves `currentTime` + `paused` state — no re-fetch, no flash.

```js
function getCachedVideo(shotName, src) {
    let entry = _overviewVideoCache.get(shotName);
    if (entry && entry.src === src) return entry.video;
    const v = document.createElement('video');
    v.src = src; v.muted = true; v.loop = true;
    v.playsInline = true; v.preload = 'metadata';
    _overviewVideoCache.set(shotName, { video: v, src });
    return v;
}
```

Cleared on `closeProjectOverview` so the next session starts fresh
(project-switch invalidations would have made them stale anyway).
Stays warm across:

- View-toggle (list ↔ grid)
- Filter input
- Single delete (the deleted shot's entry is orphaned but
  harmless; cache evicts on next close)
- Batch delete

### Fixed — drop `transform: translateY(-1px)` from hover

```diff
- transition: background 120ms, border-color 120ms, transform 120ms;
+ transition: background 120ms, border-color 120ms;
  ...
  &:hover {
      background: #232323;
      border-color: #3a3a3a;
-     transform: translateY(-1px);
  }
```

Background + border change is enough motion. The translateY was a
nice-to-have that turned hostile under re-renders — drops it
entirely. No replacement; the hover treatment now feels stable
regardless of when in the render cycle the cursor lands.

### Preserved invariants

- IPC surface unchanged.
- The dev41 "tick stays out of the overview" rule still holds —
  this dev fixes the EXPLICIT re-renders, not the tick.
- Tests stayed at 137 / 137.

---

## [0.5.0-dev41] — 2026-05-04 — **Overview: stop the 3s jitter + rail marker + progressive checkboxes**

User feedback bundle: *"the previews keep refreshing, getting
blackened out and the cards feel jittery — every 3 seconds, do we
still refresh the app every 3 seconds?"* Yes, the 3s tick is still
there and was never removed — the overview was just piggy-backing
on it accidentally. Three changes here, all UX-polish.

### Fixed — overview re-rendering on every refresh tick

The dev38 refresh override called `renderProjectOverview()` inside
the early-return branch, which meant every 3s tick:

1. Re-fetched the overview payload (one IPC roundtrip).
2. Wiped `#po-rows` innerHTML.
3. Rebuilt every card from scratch — including new `<video>`
   elements with the same src URL.

Browsers reset the playhead + redownload the moov atom for every
new `<video>`, so a hovered preview would freeze, flash to black,
and start over. Same reason the cards "felt jittery" — they were
literally being recreated every tick.

```diff
  if (_overviewProject) {
      $('project-overview').style.display = '';
      $('shot-ui').style.display = 'none';
-     renderProjectOverview();
+     // overview owns its own lifecycle; tick stays out
+     refreshRail(null);     // rail still updates so the marker stays current
      return;
  }
```

The overview now repaints only on explicit triggers:

- `openProjectOverview` (initial paint)
- View-toggle click
- Filter input
- After single delete (`po-card-del.onclick`)
- After batch delete (`po-batch-trash.onclick`)
- After right-click → "Move to trash" on a list row
- `Clear` button on the batch bar

`refreshRail(null)` still fires every tick so the new rail marker
(see below) tracks state. `refreshRail` itself diffs via
`railSignature` so an unchanged tick is a no-op.

### Added — rail "viewing-overview" marker

Mirror of how the rail highlights the active shot row, but tied to
a different state (the overview being open, not shot selection):

```
●  dragonfruit_trial            OVERVIEW
   └ gold left border + gold name + gold pill
```

Implementation:

- `_overviewProject` is keyed into `railSignature` (`v: …`) so
  opening / closing the overview triggers a rail repaint.
- `renderRail` adds `.viewing-overview` to the `.rail-proj` element
  whose name matches `_overviewProject`.
- CSS gives that class a gold left border (2px), tinted background
  (#2a2418), gold name color, and an `OVERVIEW` pill via
  `::after { content: 'OVERVIEW'; }`.

The marker disappears the moment the user navigates to a shot
(close clears `_overviewProject` → next `refreshRail` invalidates
its signature).

### Added — progressive checkbox visibility

User suggestion: *"the checkbox should appear only when we hover as
well, then if you select one, appear on the other cards too."*
Solid call — implemented exactly that:

| State                          | Checkbox visibility |
|--------------------------------|---------------------|
| Default (no selection, no hover) | Hidden            |
| Card hover                     | That card's box appears |
| ≥ 1 card selected ("selection mode") | Every card's box visible |
| Card is selected                | Painted gold, always visible |

Driven by:

- Default `.po-card-check { opacity: 0; }`
- `.po-card:hover .po-card-check { opacity: 1; }` (per-card hover reveal)
- `#po-rows[data-selecting="true"] .po-card-check { opacity: 1; }` (selection mode)
- `.po-card[data-selected="true"] .po-card-check { opacity: 1; … gold }` (selected always shows)

`refreshBatchBar()` flips `#po-rows[data-selecting]` whenever the
selection size crosses zero. Single-pick users never see a
checkbox; multi-select users see all of them after the first click.

### Preserved invariants

- IPC surface unchanged.
- `lastRailKey` invalidated on overview open so the marker paints
  immediately (not on the next tick).
- Tests stayed at 137 / 137.

---

## [0.5.0-dev40] — 2026-05-04 — **Overview: previews, batch trash, rail-click fix**

User feedback bundle: *"need a preview for the cards, light hover one
like in the vault — could even be a print so we can easily see what
the shot is about"* + *"when I click on a shot on the sidebar,
should go direct to a shot not just mark it in the overview"* +
*"good 'conversation' with the other pages — send to trash, both
individually and in a batch."*

### Fixed — rail-click while overview is open

When the overview was open and the user clicked a shot in the rail,
`refresh()`'s early-return check on `_overviewProject` ran BEFORE
the new `currentShot` was committed, so the rail click ended up
just re-rendering the overview (with the shot now highlighted but
no actual navigation). Now the rail handler closes the overview
in `keepHidden` mode first:

```js
if (_overviewProject) closeProjectOverview({ keepHidden: true });
// …selectProject + selectShot…
$('shot-ui').style.display = '';
refresh();
```

Same `keepHidden` pattern dev38 introduced for the row click. No
flash of stale UI; the new shot paints exactly once.

### Added — preview tile per card

`project:overview` now surfaces `previewPath` per shot — the active
version's `preview.webm`/`preview.mp4`, or fallback to the newest
version with any preview, or null when nothing renderable exists:

```js
const active = (job && job.activeVersion)
    ? versions.find(v => v.name === job.activeVersion)
    : null;
if (active && active.preview) previewPath = active.preview;
else for (let i = versions.length - 1; i >= 0; i--) {
    if (versions[i].preview) { previewPath = versions[i].preview; break; }
}
```

The card renders a `<video preload="metadata">` so the first frame
shows as a static poster (cheap — Chrome only fetches the moov
atom, not the whole stream). On `mouseenter` the video plays muted
+ loops; `mouseleave` pauses + rewinds. Same hover-play pattern
the vault uses for asset proxies.

Shots with no rendered version yet show a `"no preview"` 16:9
placeholder so the card layout doesn't reflow.

### Added — per-card "Move to trash"

Hover-revealed trash icon in the top-right of each card's preview
tile. Routes through the existing `confirmAndDelete({ project, shot })`
flow — which means the dev35 7-day soft-delete copy and recovery
all carry through unchanged.

For list view, the same action sits behind a right-click context
menu on the row (no checkbox column to keep the grid template stable).

### Added — multi-select + batch "Move to trash"

`_overviewSelection` (a `Set` of shot names, scoped to the open
project) tracks selection. Each grid card has a small checkbox
top-left of its preview tile — fades in on card hover, stays
visible when checked. Click toggles, doesn't navigate
(`stopPropagation`).

When the set is non-empty, a sticky bottom bar appears:

```
●  3 selected                              [Clear]  [🗑 Move to trash]
```

The trash button confirms ONCE for the whole batch, listing up to
12 names in the dialog detail (`… and N more` past that), then
serially fires `deleteShot` per shot. Sequential (not parallel) so
the rail / status / trash count stay coherent. Selection clears
after the batch completes; the overview re-fetches.

### Selection lifecycle

- Selection clears on overview close (scoped to the open project).
- Selection clears on view-mode toggle? **No** — same project,
  same set. Switching grid↔list preserves selection.
- Right-click → "Move to trash" on a list row uses
  `confirmAndDelete` (single-shot path). Doesn't touch the batch
  selection.

### Preserved invariants

- IPC additive: only `previewPath` was added to the overview row
  shape. No schema change anywhere.
- Batch trash uses the existing `shot:delete` IPC (which is now the
  dev35 soft-delete path); nothing new on main.
- `confirmAndDelete` still owns the single-shot copy; batch dialog
  is a separate path with batch-specific copy.
- 137 / 137 tests still passing.

### Deferred

- Drag-to-select rectangle in grid view.
- Shift+click range selection.
- Restore-from-trash directly inside the overview (currently the
  rail's Trash button is the entry point).

---

## [0.5.0-dev39] — 2026-05-04 — **Overview: grid view + close-button polish**

Two follow-ups to dev38: the close button looked anaemic next to the
filter input, and the page itself wanted the same grid/list switch
the vault has.

### Fixed — close button visual treatment

```diff
- width: 26px; height: 26px;
- background: #2a2a2a; color: #aaa;
- border: 1px solid #3a3a3a;
- font-size: 14px;
+ width: 28px; height: 28px;
+ background: #1d1d1d; color: #c0c0c0;
+ border: 1px solid #333;
+ font-size: 16px;
+ font-family: ui-monospace, Consolas, monospace;
+ /* hover flips to a soft red so users grok the destructive intent */
+ :hover { background: #2a2222; color: #f99; border-color: #5a3a3a; }
```

Bigger glyph, monospace font (the `✕` looks heavier in mono), and a
red-tinted hover state so the "I'm leaving this view" intent is
visually confirmed.

### Added — grid / list view toggle

Direct port of the vault's dev34 view-toggle pill. Same SVG icons
(2×2 grid + horizontal lines), same active-state rendering, same
auto-fill `repeat(auto-fill, minmax(220px, 1fr))` grid template.
Persisted to `localStorage['overview.viewMode']` — kept separate
from `vault.viewMode` so users can prefer different defaults on the
two surfaces ("list for shots, grid for assets" is a common pattern).

#### Card layout

Each shot card carries the same data the list row does, just laid
out as a self-contained tile:

```
┌──────────────────────────────────┐
│ ●  Shot_002    [RV]              │  sanity dot · name · origin pill
│ optional label in italic         │
│ ─────────────────────────────────│
│  Active: v03 ★                   │  green = final, gold = fast/preview
│ ─────────────────────────────────│
│  3 versions  ·  255.5 MB         │
│  4d ago                  green   │
└──────────────────────────────────┘
```

Click anywhere on the card to navigate to that shot — same flow as
the list row (close overview keepHidden → selectShot → refresh).

The currently-selected shot's card carries the same blue-border /
tinted-background highlight the list row uses, for symmetry.

### Implementation note

Rather than splitting the renderer into two functions
(`renderListRows` / `renderGridCards`) and duplicating the fetch +
filter pipeline, `renderProjectOverview` flips the container's
className (`'po-grid'` vs `''`) and hides the list column header
when in grid mode. Same dispatch pattern the vault uses internally;
keeps the data flow single-pathed.

### Preserved invariants

- IPC surface unchanged — same `project:overview` payload feeds both
  views.
- Navigation flow per-card identical to per-row (the `keepHidden`
  pattern from dev38 still applies).
- Tests stayed at 137 / 137 (no test surface changed).

---

## [0.5.0-dev38] — 2026-05-03 — **Project overview page**

User request: *"a per-project page on Chiral Network, like when you
click on a folder in the vault, but showing the shots with the active
version and some info, name, number of versions, size — just an
overview of the project."* Plus a follow-up correction: *"this page
should be accessible just by clicking on the project's name from
either of [the rail or the breadcrumb] — we don't need [a toolbar
button]."*

### Added — `project:overview` IPC

```js
ipcMain.handle('project:overview', (_e, projectName) => {
    // ...listShotsIn → for each shot:
    //   readJobMemo (active/final/origin/label)
    //   listVersions  (versionCount, hasAnyMaster)
    //   VAULT.dirSizeBytes(sDir)  ← reused from dev37
    //   computeSanity            ← same dot the rail/header use
    return { ok, project, shotCount, totalBytes, shots, currentShot };
});
```

Reuses `VAULT.dirSizeBytes` from dev37 — same recursive byte-sum
walker that powers the vault SIZE column. No second implementation;
the cross-module dependency stays narrow (one function).

Heavier than `project:shotsSummary` (which reads `job.json` + sanity
only) so it's only called on overview-page open, never on the 3s
refresh tick. For a 30-shot project that's ~30 readdirs + ~30
file-tree walks; comfortably synchronous.

### Added — Project Overview page

Page-replacement view (not a modal). Renderer state
`_overviewProject`; when set, `refresh()` hides `#shot-ui` /
`#empty-state` / `#no-projects-state` and paints `#project-overview`
instead. Closing clears the flag → returns to normal shot view.

#### Columns

| Column   | Source                              | Notes |
|----------|-------------------------------------|-------|
| Shot     | `name`, `label`, `origin`           | Origin pill (AE / RV) inline next to the name; label below in italic |
| Active   | `activeVersion` + `finalVersion`    | Green ★ when active === final; gold otherwise; grey "—" when no renders yet |
| Versions | `versionCount`                      | "3 versions" / "1 version" / "—" |
| Size     | `sizeBytes` (via `dirSizeBytes`)    | B / KB / MB / GB; hover shows exact byte count |
| Updated  | `mtime` (shot dir)                  | Relative ("2h ago", "3d ago") |
| Status   | `sanity.level` + `reasons`          | Same dot the shot header / rail use |

The currently-selected shot row is highlighted with a left blue
border + tinted background so the user always knows where they're
"coming from."

#### Header / filter

Breadcrumb-style header reads `Project / <name> / Overview`. A live
filter input on the right narrows by name + label (renderer-only,
no IPC churn). Stats line shows `N shots · total size`.

### Changed — entry points (per user follow-up)

The dev38-initial draft had a rail-toolbar button. Per the follow-up
clarification, that's removed in favor of clicking the project name
itself. **Three** entry points, none of them a button:

1. **Rail** — clicking `.rail-proj-name` opens the overview. The rest
   of the head row (caret / dot / empty space) still toggles the
   accordion. Hover underline (gold) cues the link affordance.
2. **Breadcrumb** — clicking `#crumb-project` in the shot header
   opens the overview. Replaces the dev0 "jump to project in the
   rail" gesture (which was rarely used and is still reachable by
   scrolling the rail).
3. **Right-click → Project overview…** in the rail's PROJECT_ACTIONS
   context menu, for the keyboard-context-menu users.

Click-handler ordering in the rail-scroll delegator matters: shot row
→ project name → project head. The name check must come before the
head toggle or accordion-toggle wins via bubbling.

### Fixed — `listAllTrash` test, deterministic now

The dev35 / dev36 attempts used a real-time sleep between two
`trashShot` calls to give them distinct mtimes. Windows' FS mtime
resolution can be ~16ms so 10ms / 50ms sleeps were both flaky.
Fixed properly by stamping `fs.utimesSync` explicitly:

```js
fs.utimesSync(tA.trashPath, tenSecAgo, tenSecAgo);
fs.utimesSync(tB.trashPath, now, now);
```

No more clock-granularity dependency. Test runs in ~1ms instead of
50ms+.

### Preserved invariants

- `currentShot` / `currentProject` state in main.js is unchanged.
  The overview is renderer-state-only (`_overviewProject`); main
  doesn't know it exists. Safe rollback path = drop the renderer
  block, IPC stays harmless.
- `dirSizeBytes` is still the only place doing recursive byte
  walks; no duplicate implementation.
- 137 / 137 tests still passing.

### Deferred

- Sortable column headers in the overview (would mirror the dev36
  vault list-view pattern; ~40 lines).
- Bulk actions (multi-select shots → batch vault, batch delete).
- Activity sparkline per shot (last N renders timeline).

---

## [0.5.0-dev37] — 2026-04-30 — **Vault list view — SIZE column**

Last item from the post-dev34 TODO. The dev34 list view deliberately
skipped SIZE because the index projection had no `sizeBytes` field —
this dev does the index-time denormalization that unblocks it.

### Added — `lib/vault.js#dirSizeBytes(dir)`

Recursive byte sum of an asset dir. Walks every file under `dir`
(including `ae/`, `clips/`, `master.*`, etc.) and totals their sizes.
Symlinks are followed via `fs.statSync`; broken / unreadable files
are swallowed. Cost: ~1 readdir + 1 stat per file. For a typical
asset (master + proxy + thumb + ae/ + footage) that's well under 100
syscalls.

```js
function dirSizeBytes(dir) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return 0; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory())   total += dirSizeBytes(p);
        else if (ent.isFile())   { try { total += fs.statSync(p).size; } catch (_) {} }
    }
    return total;
}
```

### Added — `sizeBytes` on the index projection

`projectAsset` now exposes `sizeBytes: null` and `rebuildIndex`
stamps the real value from `dirSizeBytes(assetDir)` after the JSON
projection. Stamped at rebuild time (not in `projectAsset`) so the
projection function stays JSON-only — file I/O stays inside
`rebuildIndex` where the asset dir is already in scope.

```js
const row = projectAsset(a);
row.folderId = folderAssignments[a.assetId] || null;
try { row.sizeBytes = dirSizeBytes(assetDir); } catch (_) { row.sizeBytes = null; }
```

### Added — opportunistic upgrade in `vault:list`

Existing installs cache an older `index.json` that has no
`sizeBytes` key. Rather than force a manual Rebuild click, the
handler samples row 0 — if `'sizeBytes' in idx.assets[0]` is false,
it triggers one auto-rebuild and re-reads. Single lookup, one-time
cost, runs once per upgrading install:

```js
if (idx && Array.isArray(idx.assets) && idx.assets.length
    && !('sizeBytes' in idx.assets[0])) {
    VAULT.rebuildIndex(cfg.vaultRoot);
    idx = VAULT.readIndex(cfg.vaultRoot);
}
```

### Added — SIZE column in the list view

Slotted between Duration and Used. The grid template was retuned
so the row still fits without horizontal scroll on a typical
1280px-wide vault window:

| Col        | Was   | Now   |
|------------|-------|-------|
| Asset      | 240px | 220px |
| Tags       | 180px | 160px |
| Resolution | 110px | 100px |
| Duration   | 90px  | 80px  |
| **Size**   | —     | 85px  |
| Used       | 90px  | 85px  |
| Added      | 110px | 100px |
| gap        | 14px  | 12px  |

#### `fmtBytes` formatter

```js
function fmtBytes(n) {
    if (n == null) return '—';
    const v = Number(n) || 0;
    if (v <= 0) return '—';
    if (v < 1024) return v + ' B';
    const KB = 1024, MB = KB * 1024, GB = MB * 1024;
    if (v < MB) return (v / KB).toFixed(1) + ' KB';
    if (v < GB) return (v / MB).toFixed(1) + ' MB';
    return (v / GB).toFixed(2) + ' GB';
}
```

Cell `title` shows the precise byte count (`a.sizeBytes.toLocaleString() + ' bytes'`)
so power users get exact numbers on hover without polluting the
visual rhythm of the column.

#### Sortable

Added to the dev36 sort allowlist + comparator:

```js
size: (a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0),
```

Default direction follows the dev36 convention (numeric → desc on
first click).

### Tests

3 new tests in `test/vault.test.js`:

- `dirSizeBytes sums every file under a directory tree` — nested
  directory structure with known byte totals (5 + 100 + 2 = 107).
- `dirSizeBytes returns 0 for an empty / missing dir` — graceful
  failure mode.
- `rebuildIndex stamps sizeBytes onto every projected row` — drops
  a 2048-byte stub master into a seeded asset, rebuilds, asserts
  `idx.assets[0].sizeBytes >= 2048`.

Suite: 137 / 137 (was 134 + 3 new).

### Preserved invariants

- Schema version unchanged (still v1). `sizeBytes` is additive on
  the projection; old code reading the index just ignores the new
  field.
- `projectAsset(a)` is still pure (manifest in → row out, no I/O).
- No on-disk format change. The auto-rebuild migration runs once
  per upgrading install and is idempotent.

### Deferred / future work

- Vault-total disk usage badge in the toolbar (sum of sizeBytes
  across `_allAssets`) — natural extension; ~5 lines.
- Per-project trash filter in the dev35 shot-trash drawer.
- Bulk restore in the shot-trash drawer.

This drops the post-dev34 TODO list to zero.

---

## [0.5.0-dev36] — 2026-04-30 — **Vault list view — sortable headers**

Pure renderer feature, ~80 lines. Mid-tier item from the post-dev34
TODO; the SIZE column is the last remaining one.

### Added — clickable column headers

Sortable columns: `Asset`, `Resolution`, `Duration`, `Used`, `Added`.
`Tags` stays a plain label (no defined order). Click toggles asc/desc;
clicking a different column resets to the per-type sensible default
(text → asc, numerics + dates → desc, "newest / biggest first").

```js
const _LIST_SORTERS = {
    name:  (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    res:   (a, b) => (a.specAtVault?.width  || 0) - (b.specAtVault?.width  || 0),
    dur:   (a, b) => (a.specAtVault?.durationFrames || 0) - (b.specAtVault?.durationFrames || 0),
    used:  (a, b) => (a.usageCount || 0) - (b.usageCount || 0),
    added: (a, b) => (Date.parse(a.vaultedAt) || 0) - (Date.parse(b.vaultedAt) || 0),
};
```

Sort runs on a shallow copy (`rows.slice().sort(…)`) so the source
`_allAssets` array stays put — switching back to grid view shows the
original index order.

### Persistence

Active sort lives at `localStorage['vault.listSort']` as
`{ key, dir }`. Validated on read against a key allowlist so a
stale/corrupted entry can't break the renderer:

```js
const VALID_KEYS = { name:1, res:1, dur:1, used:1, added:1 };
if (!o || !VALID_KEYS[o.key]) return { key: 'added', dir: 'desc' };
```

Default first-run state: `{ key: 'added', dir: 'desc' }` — most
useful "newest at the top" landing for a fresh vault user.

### Visual indicator

The active column shows ▲/▼ via `[data-sort-active="true"]` and
`[data-sort-dir]` data attributes; the arrow span is always present
in the DOM (just `opacity: 0` when inactive) so column widths don't
jump as the active sort moves between columns.

### Fixed — flaky `listAllTrash` test (dev35 carryover)

The dev35 `listAllTrash spans projects…` test sleeps 10ms between
two trash operations to give them distinct mtimes, but Windows mtime
resolution can be ~16ms — the test failed intermittently. Bumped to
50ms.

### Preserved invariants

- Sort is purely client-side; no IPC, no index format change.
- Grid view ignores `_listSort` entirely (toggling to grid shows the
  original index order from `vault:list`).
- Tests stayed at 134 / 134.

### Deferred

- SIZE column — last item from the dev34 TODO. Needs index-time
  denormalization (`projectAssetForIndex` reads `asset.json` only;
  we'd add a lazy `du` of the asset dir at rebuild time and stamp
  `sizeBytes` onto the row).
- Per-project trash filter in the dev35 shot-trash drawer.

---

## [0.5.0-dev35] — 2026-04-30 — **Shot trash can — 7-day soft delete**

User pick from the dev34 TODO list: "trash can system for the shots
on Chiral Network, just for security, same system, 7 days protection,
you can get in the trash can and delete everything or individual if
you want." Mirror of the dev32 vault trash, transplanted onto shot
folders.

### Added — `lib/shot_trash.js`

New library, sibling of `lib/vault.js`'s trash functions. Why a
separate file instead of generalising? Two reasons:

1. **The store differs.** Vault has one fixed `vaultRoot/.trash/`
   and asset IDs are UUIDs (`slice(0,36)` parses entries cleanly).
   Shot trash lives **per-project** at `<projectDir>/.trash/` and
   shot names are arbitrary strings, so the entry parser is different.
2. **`restoreShot` has a collision check** the vault path doesn't
   need (vault assets are content-addressed; shot names aren't).

#### Disk layout

```
<projectsDir>/<projectName>/
├── Shot_001/                                          # live
├── Shot_002/
└── .trash/
    ├── 2026-04-30T15-22-33-456Z__Shot_001/
    └── 2026-04-30T18-00-12-009Z__Shot_001/            # second delete after restore
```

Entry name format: `${timestamp}${SEP}${shotName}` with `SEP = '__'`.
Timestamps from `toISOString().replace(/[:.]/g, '-')` never contain
`__`; shot names are allowed to contain single underscores. So
`indexOf('__')` gives the split point unambiguously.

`listShotsIn` already filters by `/^Shot_/` so the `.trash/` directory
inside each project is naturally excluded from rail enumeration.

#### Surface

| Function                          | Purpose |
|-----------------------------------|---------|
| `trashShot(projectDir, shotName)` | Move to `<project>/.trash/<ts>__<shot>/` via `fs.renameSync` (atomic on the same volume — same-volume guarantee that the project tree is one root) |
| `restoreShot(projectDir, entry)`  | Reverse move; refuses if a live shot with the same name exists, returning a user-friendly error |
| `listTrash(projectDir)`           | Per-project listing with parsed shotName + `mtime`-based `trashedAt` |
| `listAllTrash(projectsDir)`       | Cross-project listing tagged with `project` name; sorted newest-first |
| `purgeEntry(projectDir, entry)`   | Permanent delete of a single entry (UI-gated) |
| `purgeOldShotTrash(projectsDir)`  | 7-day auto-purge across every project; called at boot |
| `emptyAllShotTrash(projectsDir)`  | User-explicit "empty trash now" across every project |

### Fixed — `shot:delete` is now a soft delete

```diff
- if (!P.rmDirRetry(target)) return { ok: false, error: '…' };
+ const r = SHOT_TRASH.trashShot(pDir, shotName);
+ if (!r.ok) return { ok: false, error: r.error };
+ return { ok: true, recoverable: true, trashEntry: r.entry };
```

Same arg shape + same return shape so the rail UI gets the safety
upgrade with no renderer churn. `confirmAndDelete` in index.html now
shows `"Recoverable for 7 days from the shot trash."` for shot
deletes and the confirm button reads "Move to trash" instead of
"Delete shot." Project deletes still hard-delete with the original
"This cannot be undone." copy and the `.aep`-count warning line.

### Added — IPC handlers

- `shot:listTrash` — cross-project list with `ageDays` /
  `daysRemaining` computed server-side so the renderer doesn't
  duplicate date math.
- `shot:restoreFromTrash` — `{ project, entry }`; surfaces the
  collision error verbatim to the UI.
- `shot:purgeFromTrash` — single-entry permanent delete.
- `shot:emptyAllTrash` — wipes everything across every project.

All four route paths through `assertInProjects` exactly like the
existing `shot:delete` did, so a malicious project / entry name
can't escape `PROJECTS_DIR`.

### Added — Boot purge

```js
try {
    const removed = SHOT_TRASH.purgeOldShotTrash(PROJECTS_DIR);
    if (removed.length) console.log(`[shot-trash] auto-purged ${removed.length} expired entr…`);
} catch (e) { console.warn('[shot-trash] purge failed:', e.message); }
```

Best-effort — sits next to the existing `VAULT.purgeOldTrash` block
in `applyConfigToRuntime`. A failed entry doesn't abort the rest.

### Added — Trash drawer in `index.html`

New rail-toolbar button (`🗑 Trash`) sits below `New shot from AE`
with a live count badge that updates on open / after every mutation.
Drawer overlay reuses the palette's open/close pattern (same
backdrop, same Esc-to-dismiss, same `.open` class):

```
┌─ Shot trash (3 entries)                  7-day retention ─┐
│ Shot_001    teste_claude    2d ago    5d left    [Restore] [Delete forever]
│ Shot_002    teste_claude    today     7d left    [Restore] [Delete forever]
│ Shot_003    proj_b          6d ago    1d left    [Restore] [Delete forever]
│                                         ↑ gold when ≤ 1d remaining
└─ [Empty trash]                              [Close] ─────┘
```

Restore uses `confirmDialog` (the existing path-aware modal IPC) for
the collision-error case so the messaging stays consistent with the
rest of the rail's flows. `Delete forever` and `Empty trash` both
gate behind separate destructive confirms.

### Tests

`test/shot_trash.test.js` — 17 new tests covering every public
function plus the trickier paths:

- `parseEntry` preserves underscores in shot names
- `trashShot` allows multiple deletes of the same name (timestamp
  disambiguates)
- `restoreShot` refuses to overwrite a live shot with the same name
- `listAllTrash` sorts newest-first and skips dotfile-prefixed dirs
- `purgeOldShotTrash` only purges entries older than the cutoff
  (verified by backdating `mtime` via `fs.utimesSync`)

Suite: 134/134 (was 117 + 17 new).

### Preserved invariants

- `assertInProjects` gating on every IPC entry point.
- `P.rmDirRetry` is still the path for hard project deletes; only
  shot deletes were softened.
- No on-disk format change to projects, shots, or vault. The
  `.trash/` directory is created lazily on first delete; existing
  installs are unaffected until a shot is deleted.

### Deferred

- Per-project trash filter in the drawer (currently global only).
- Bulk restore / multi-select in the drawer.
- SIZE column in the vault list view.
- List-view sort headers.

---

## [0.5.0-dev34] — 2026-04-30 — **Vault list view + ExtendScript trim fix**

Two fixes and one feature, shipped together because the bug landed
mid-list-view work and gating it for a separate dev would have
delayed both.

### Fixed — `scripts/ae/vault_clip.jsx` parseLayerTags regression

The dev31 multi-tag rewrite introduced
`(values[i] || "").trim().toLowerCase()` to normalize each tag value
in the `CHIRAL:TAG=…` capture. ExtendScript is ES3 — there is no
`String.prototype.trim` — so the moment AE hit a layer comment with
a tag run the whole vault aborted with
`ReferenceError: Function values[i]||.trim is undefined`.

Swapped for the ES3-safe equivalent:

```js
var t = String(values[i] || "").replace(/^\s+|\s+$/g, "").toLowerCase();
```

### Hardened — `scripts/ae/vault_clip.jsx` thumbnail render

`saveFrameToPng` on a freshly synthesized layer-wrap comp can fail
silently until the comp has been touched by the viewer, and a
midpoint sample that lands outside the wrapped layer's active range
can produce an empty / failed render. The hardened block:

- Calls `subjectComp.openInViewer()` before the first sample (wrapped
  in try/catch — older AE builds throw on this).
- Tries multiple sample times — midpoint, t=0, last frame — and
  takes the first one that succeeds.
- Falls back gracefully to `thumbnail: null` like before; the asset
  still lands, the card just shows the "no preview" placeholder.

### Added — Grid / List view toggle in the vault toolbar

User's TODO pick. Grid view is unchanged; the new list view projects
the same `_allAssets` rows into a single `grid-template-columns` table.

| Column     | Width        | Source                                  |
|------------|--------------|-----------------------------------------|
| Thumb      | 56 px        | async `mediaPaths.thumbnail`            |
| Asset      | 2fr min240   | `name` + `originProject · originShot`   |
| Tags       | 1.4fr min180 | first 4 chips + `+N` overflow marker    |
| Resolution | 110 px       | `specAtVault.width × height`            |
| Duration   | 90 px        | `specAtVault.durationFrames / fps`      |
| Used       | 90 px        | `usageCount`, gold when > 0             |
| Added      | 110 px       | relative time from `vaultedAt` ISO      |
| Actions    | 170 px       | primary `→ AE` + kebab (Resolve / as shot / Reveal / Delete) |

`SIZE` was on the design reference but is not stored on the index
projection (`vault.js#projectAssetForIndex`) and would have required
a per-asset `fs.statSync` on every render — deferred until we either
denormalize bytes onto the row at index time or add a lazy size IPC.

#### View toggle

Two-button pill in the toolbar (between the search shell and Refresh)
modeled on the design preview — same height as the surrounding `.btn`
elements so the row alignment stays clean. Active state painted via
`[data-active="true"]`; the selected side fills with `--bg-3` and
the icon promotes to `--fg-0`. Inline SVG (Lucide squares + lines),
no icon font.

#### State + persistence

```js
let _viewMode = (function () {
    try { return localStorage.getItem('vault.viewMode') === 'list' ? 'list' : 'grid'; }
    catch (_) { return 'grid'; }
})();
```

`renderGrid()` dispatches: list mode appends `renderList(matches)`,
grid mode keeps the dev26 card grid. The toggle handler flips the
mode, persists, and re-renders without re-fetching the index — pure
DOM re-projection.

#### Drag-and-drop parity

List rows are `draggable=true` with the same `dataTransfer` payloads
the grid card emits (`text/plain` + `application/x-chiral-asset-id`)
so filing onto folder pills / sidebar entries works identically in
either view.

#### Kebab menu

Per-row `⋯` button opens a small absolute-positioned popover with
`Resolve / as shot… / Reveal / Delete`. Single global outside-click
listener closes any open menu — beats wiring per-row focus-out and
matches the dev30 trash drawer's dismissal pattern.

### Preserved invariants

- `vault:list` IPC payload unchanged — list view consumes the same
  `_allAssets` array the grid does.
- All `card-*` CSS rules untouched — list styles live under a
  separate `.list-*` namespace.
- Tests stayed at 117 / 117. List view is renderer-only; no Node
  surface area changed.

### Deferred

- `SIZE` column — needs index-time denormalization.
- List-view sort by column header — `Added` / `Used` / `Resolution`
  headers are obvious triggers; lands alongside the SIZE work.
- Shot trash can in Chiral Network — still on the list.

---

## [0.5.0-dev33] — 2026-04-28 — **Add asset — vault any .aep on disk**

The user's "Add asset" pick. Pre-dev33 the only way an asset could
land in the vault was via a Chiral project shot — `Vault this shot`
or `Vault marked clips` from inside the main app. That left no path
for the common "I downloaded a framework / template / animation, I
want it in my library" case.

### Added — `lib/vault_pipeline.js#vaultExternalAep(ctx, {aepPath, displayName, tags})`
A thin sibling of `vaultShot` that runs the same AE-handoff pipeline
against an .aep with no project / shot context.

- Mints an asset dir under `<vault>/assets/<id>/`.
- Spawns `vault_collect.jsx` with a fabricated job pointer carrying
  the .aep path + the asset's `ae/` target dir.
- Awaits the sentinel under the standard dev20 scripting lock; on
  failure the half-baked dir gets moved to `.trash/`.
- Builds asset.json with `origin.projectName: '(External)'` and
  `origin.shotName: <basename>.aep` so external imports cluster
  visually in the vault grid AND are searchable as a group.
- Skips master copy / proxy / thumbnail (no shot = no master). The
  AE side still records comp settings, fonts, plugins, footage —
  same depth of metadata as a regular vault.

### Added — `vault:addExternalAEP` IPC handler
Two args, both optional:

- `aepPath` — pre-resolved path. If omitted, the handler opens a
  native `dialog.showOpenDialog` filtered to `.aep`. Lets future
  drag-and-drop reuse the same pipeline by passing a path directly.
- `displayName` — overrides the asset name. Defaults to the .aep
  basename minus extension.

Returns `{ ok: true, assetId, asset }` on success, or
`{ ok: false, canceled: true }` when the user backs out of the
picker — distinguishable from a real failure so the UI doesn't
show an error toast for "I changed my mind".

The dialog is anchored to the vault window if open, else the main
window — keeps the modal centered on whichever surface the click
came from.

### Added — `+ Add asset` toolbar button
Pinned right of `Pick folder…`, styled `btn-primary` (gold accent,
inverted) so it reads as the primary "import" affordance — matching
the design's slot. Disables itself + flips text to `…` while the
pick / vault round-trip is in flight, prevents a double-click from
stacking two AE dispatches.

### Preserved
- 117/117 tests, IPC parity holds (`comm -3` between
  `ipcMain.handle()` and `ipcRenderer.invoke()` is empty).
- 800ms scripting-lock cooldown.
- `vault_collect.jsx` is unchanged — it already handled the case
  where `compName` is null (falls back to the longest comp /
  CHIRAL:VAULT marker heuristic).
- All existing vault flows (`createFromShot`, `clipFromShot`,
  `importToAE`, `importToOpenAE`, etc.) untouched.

### Limitations
- No master render → no proxy / thumbnail in the grid for external
  assets (placeholder card). Procedural-template thumbnail rendering
  (`saveFrameToPng`) only fires from `vault_clip.jsx`; the external
  flow uses `vault_collect.jsx` which doesn't have that step. Could
  add later if it matters; for now the asset is fully functional —
  it just shows the placeholder until rendered out via the legacy
  "open as new shot" flow.
- Tags can only be passed by API (`{tags: [...]}` in the args) —
  there's no UI surface yet. Comp markers (`CHIRAL:TAG=…`) inside
  the .aep DO get picked up automatically by `vault_collect.jsx`,
  so a properly-tagged source .aep is searchable on import.

### Notes for testers
1. Click `+ Add asset` (gold, top-right of vault toolbar).
2. Native picker opens, filtered to `.aep`. Pick a project that's
   NOT one of your Chiral shot .aeps — e.g. a downloaded framework.
3. Status bar shows `Vaulting external "<name>" → <id-prefix>…`.
4. After the AE collect finishes, the asset appears in the vault
   grid with a placeholder thumb and origin showing `(External) ·
   <basename>.aep`.
5. Click `→ AE` on it from a working .aep → the asset's comps land
   in your active project. Same import flow as any other asset.

### TODO list — what's still open
- **List view** in vault (~300 lines)
- **Trash can for shots** in Chiral Network — same 7-day system
  as vault trash, applied to the shot folders. Re-uses the
  retention timer, the empty-now action, and the restore flow.

---

## [0.5.0-dev32] — 2026-04-28 — **Trash drawer + RV badge cleanup**

Two from the user's TODO list. Trash was the priority pick — soft-
deleted assets had nowhere to be seen until the 7-day window expired,
which felt like data going into a void.

### Added — `lib/vault.js#emptyAllTrash(vaultRoot)`
Wipes every entry in `<vault>/.trash/` regardless of age. Distinct
from `purgeOldTrash` (which honors the 7-day retention) — this is
the user-initiated "Empty trash now" action. Runs only from the new
drawer's confirm dialog. The boot-time auto-purge of 7-day-old
entries is unchanged.

### Added — IPC handlers (re-expose dev17-stripped surface)
- `vault:listTrash` — returns `{ entries, retentionDays }`. Each
  entry carries `name` (read from the trashed asset.json),
  `assetId`, `trashedAt`, `ageDays`, and `daysRemaining`. The
  `daysRemaining` is what the UI uses to flag rows about to expire.
- `vault:restore` — moves a trash entry back into `assets/` and
  rebuilds the index. Surfaces a status toast.
- `vault:emptyTrash` — wraps `emptyAllTrash`.

Preload exposes them under `window.vault.trash.{list, restore,
empty}` to match the `vault.folders.*` namespace shape.

### Added — Vault sidebar Trash entry + drawer
- New pinned-views row beneath **Unfiled**, with a Lucide-style
  trash icon and a live count of trashed entries. Click opens a
  drawer (not a grid filter — trashed assets aren't browsable as
  cards).
- The drawer shows each entry as a single row:
  `<asset name>            deleted 3d ago · 4d left   [Restore]`
  Rows about to expire (`daysRemaining ≤ 1`) show the meta line
  in `--warn` (yellow).
- Footer holds a destructive `Empty trash now` button that opens
  a separate confirm dialog ("This permanently deletes every
  entry…cannot be undone").

The drawer uses the existing `<dialog>` pattern from folder name /
folder confirm, so styling, focus management, and Esc-to-close all
work without new infra.

### Changed — `s.origin` RV/AE badge dropped from the project rail
The badge was rendering on every shot row in the sidebar list, which
made the rail look noisy on big projects. Per user feedback the badge
is more useful in one contextual place — the shot header, where it
already shows. Pulled it out of the rail render. The badge still
exists at the header level (`#shot-header .origin-badge`) and still
gets populated by `crumb-origin` per shot.

### Preserved
- 117/117 tests, IPC parity holds (`comm -3` between
  `ipcMain.handle()` and `ipcRenderer.invoke()` is empty).
- 800ms scripting-lock cooldown.
- 7-day auto-retention runs at boot. The new "empty now" path is
  strictly additive.
- Restore semantics: a restored asset rebuilds the index and
  reappears in the grid; folder assignment was already cleared on
  initial trash (dev24) so it lands in **Unfiled**.

### Deferred (still on the TODO)
- **"Add asset"** button (.aep file picker → vault entry)
- **List view** in vault (~300 lines of grid-↔-table layout work)

### Notes for testers
1. Delete an asset (Vault card → Delete button). Confirm dialog
   pops; click "Move to Trash". Asset disappears from the grid.
2. Sidebar **Trash** entry shows count `1`. Click it.
3. Drawer opens with one row. Click **Restore** — row vanishes,
   asset returns to the grid.
4. Delete again, click Trash, click **Empty trash now** → confirm
   → asset is permanently gone.
5. Open the main app: shot rows in the rail no longer carry the
   `RV` / `AE` badge; the badge still shows in the shot header
   when a shot is selected.

---

## [0.5.0-dev31] — 2026-04-28 — **Quick wins: multi-tag, label refresh, indigo Vault, real icons**

Four cheap-but-high-pain-relief fixes from the user's TODO list. The
heavier items (trash drawer, list view, "Add asset" .aep picker) are
deferred to a follow-up — they need IPC re-exposure or new pickers.

### Fixed — multi-tag parsing in `vault_clip.jsx`
Pre-dev31 the comment parser split on `[;,\s]+` FIRST and then matched
each chunk against `^CHIRAL:TAG=value$`. So:

- `CHIRAL:TAG=hero CHIRAL:TAG=template` → ✓ both tags
- `CHIRAL:TAG=hero;CHIRAL:TAG=template` → ✓ both tags
- `CHIRAL:TAG=hero,template,background`  → ✗ only `hero` (tester report)

Comma-list is the natural way to type multiple tags ("give me three
labels"), and several testers tried it and got silently truncated.

New strategy: don't split first. Walk the raw string with
`/CHIRAL:TAG=([^\s;]+)/gi`, capture each value run, then split THAT
on commas to extract individual tags. CHIRAL:CLIP is detected
separately with a token-bracketed regex. Both old forms keep working
plus the comma-list works now.

### Fixed — shot label rename → rail update
`commitLabelEdit` wrote the new label via `setLabel`, repainted the
shot header in place, and waited for the next 3 s polling tick to
update the rail entry. dev31 calls `refreshRail()` immediately after
a successful save so the new label appears in the sidebar within the
same animation frame as the input commit. One IPC round-trip
(`project:allSummary`), no full `shot:info` refresh.

### Changed — Vault accent: gold → indigo
Per the user's instinct (and a bit of mine): gold reads as the
"active workbench" temperature in the Command Center — renders, AE
handoffs, primary CTAs. Vault is a library — passive, browse-y. Cool
indigo (`--accent-h: 230`, `oklch(0.72 0.13 230)`) gives it a
distinct voice without breaking the shared neutral grays. dev28
flattened both windows to gold; dev31 gives them back their
hierarchy.

The Command Center stays gold — gold means "do work". Vault is now
indigo — indigo means "browse / pick".

### Changed — sidebar icons: Unicode → inline SVG
The `◇ / ○ / ▤` glyphs from dev24 looked rough at 14×14 (especially
on Windows where the font fallback for those code points isn't
metric-stable). Replaced with inline Lucide-style SVG paths:

- **All Assets** → inbox glyph
- **Unfiled** → single-page document
- **Recently Added** → clock (kept available for the future view)
- **User folders** → closed-folder outline

Inlined directly into the script (no `<img>`, no icon font, no
network fetch). All four use `currentColor` so the existing
`.sb-icon` hover/active color rules just work — they recolor
on hover and on active selection automatically.

### TODO list — what's deferred
- **Trash drawer** ("View deleted, Empty trash") — needs the dev17-
  stripped `vault:listTrash / restore / purgeTrash` IPC handlers
  re-exposed plus a small UI.
- **List view in Vault** — second print's tabular density. ~300 line
  lift with row/column reflow logic.
- **Add asset** button — `.aep` file picker that creates a new
  asset entry. Doable but real-data-shape-dependent.

All preserved: 117/117 tests, IPC parity, the 800ms scripting-lock
cooldown, every `data-act` event delegation path.

### Notes for testers
1. In AE, set a footage Comment column to
   `CHIRAL:TAG=hero,background,template` — vault should now produce
   one clip with all three tags.
2. Double-click a shot's label, type a new name, hit Enter. The
   sidebar entry updates immediately (no 3 s lag).
3. Open the Vault — accent should now be cool indigo. Buttons,
   active sidebar item stripe, drag-over highlights, all indigo
   now. Command Center stays gold.
4. Sidebar icons are crisp SVGs — they recolor on hover and stay
   sharp at any zoom level.

---

## [0.5.0-dev30] — 2026-04-28 — **Color parity: index.html → oklch tokens (matches Vault)**

dev28 ported the Command Center palette to index.html as hex
approximations of the Vault's oklch tokens. Close, but not identical
— sRGB hex doesn't perfectly reproduce a Display-P3-aware oklch on
modern monitors, so the two windows had a faint tonal mismatch
side-by-side. dev30 swaps in the actual oklch tokens. Chromium 126
(Electron 31) renders them natively; the two windows are now
pixel-identical in palette.

### Changed — surface tokens
```
--bg-0 .. --bg-4 → oklch(L 0.005-0.008 250)
--line-1, --line-2 → oklch(0.27/0.32 250)
--fg-0 .. --fg-3 → oklch(0.96/0.78/0.6/0.46 250)
```

### Changed — accent + semantics
- Gold accent variants (`--accent`, `--accent-strong`,
  `--accent-soft`, `--accent-line`, `--accent-darker`,
  `--accent-on`) all derive from `oklch(L 0.13/0.14 75)` — same as
  Vault.
- `--ok / --warn / --err` swapped to oklch greens/golds/reds with
  consistent chroma so they share visual weight.
- The dev28 `rgba(211, 88, 107, 0.14/0.4)` literal danger backgrounds
  in the version-card delete-button rules → `oklch(0.65 0.18 25 / 0.14)`
  for token-driven danger across the file.

### Changed — legacy form controls + buttons
The bright green `button { background: #2d7 }` default (a pre-dev28
holdover) was clashing with the gold/slate scheme. Updated:

- `button` default: ghost-neutral (transparent on `--bg-2` with
  `--line-1` border), hover lifts to `--bg-3` / `--line-2`.
- `button.gold` and `button.btn-open`: solid gold fill with
  `var(--accent-on)` text, gold-strong on hover.
- `button.danger`: transparent with red-tinted border, fills to a
  red-soft background on hover.
- `button.btn-render-busy`: gold-strong (matches the existing
  busy-state semantics).
- `select` / `input`: `--bg-2` background, `--line-1` border,
  `--accent-line` on focus.

### Changed — overflow kebab + dropdown
The `⋯` overflow menu pre-dev30 used `#333` / `#555` / `#2a2a2a`
hardcoded values that read as a different temperature than the rest
of the chrome. Now uses `--bg-2` / `--line-1/2` / `--bg-3` and
matches the dev29 version-card kebab menu's visual language exactly.

### NOT changed
- Vault.html — already used oklch in dev26+.
- Sanity dots, origin badges, banners, status strip — those have
  semantic colors that map naturally and weren't tonally off.
- Tier badges (`tier-draft / preview / high / final / active`) on
  version cards — the dev28 hex values (`#b97a30`, `#6dc296`,
  `#6db7d4`) read fine on the new surfaces; not worth churning.

### Performance
oklch costs nothing at render time on Chromium ≥ 111 — it's
resolved during cascading the same way hex is. No hot-path impact.

### Tests — unchanged at 117/117
Pure CSS token swap. No DOM changes, no JS changes, no IPC.

### Notes for testers
- Open the main app and the Vault side-by-side — backgrounds, card
  surfaces, borders, and gold accent should now match exactly.
- The `Set Active` button on version cards looks the same gold as
  the Vault's `→ AE` primary buttons.
- Default secondary buttons (rail toolbar, overflow menu) sit on
  the same dark surface as the rest of the chrome instead of
  popping bright.

---

## [0.5.0-dev29] — 2026-04-28 — **Version cards: declutter — primary CTA + kebab menu**

Per the Command Center print mockup. The dev28 card had four action
buttons in a row (`Mark Final` / `Set Active` / `Reveal folder` /
`Delete`) which felt cluttered, and the meta line above them was
verbose with redundant labels (`master: Shot_002_v03.mov ✓ ·
preview: webm`). dev29 cuts both down to the essentials.

### Changed — action row: 1 primary + 1 kebab
The four buttons collapse to **one primary CTA + one "⋯" kebab**.
The primary is state-dependent so the most-likely next action is
always one click away:

- **Active card** → `★ Mark Final` (gold solid). If already final,
  reads `★ Final` with a transparent gold-bordered look — same
  button, idempotent click flips it back.
- **Other cards** → `Set Active` (gold solid). The natural promotion
  path for a WIP version.

The kebab opens a small floating menu (200ms transition, solid
alpha fill, no blur) anchored to the card's bottom-right corner.
Items:

- `★ Mark / Unmark Final` — only when not already covered by the
  primary (i.e. on non-active cards).
- `📁 Reveal folder`
- `Delete version` (visually flagged as destructive, red on hover).

Outside-click + Esc both dismiss the menu. Picking any item closes
it automatically. `aria-expanded` flips on the kebab so screen
readers see the state.

The `data-act` attribute names didn't change (`final` / `active` /
`reveal` / `delete`), so the existing `#versions` click delegation
routes both surfaces unchanged. No IPC churn, no backend touch.

### Changed — meta line: tighter, prefix-free
Was: `master: Shot_002_v03.mov ✓ · preview: webm`
Now: `Shot_002_v03.mov                                webm`

- Master filename takes the left, monospace, ellipsizes if it
  overflows.
- Preview kind sits as a small uppercase mono chip on the right,
  styled like the dev26 Vault tag chips.
- Master MISSING shows ⚠ in the danger color where the filename
  used to be — way harder to miss than the old `missing` text.
- Dropped the `master:` and `preview:` labels — the typography
  already says what each cell is.

I considered carrying frames/MB/author per the design's mockup
but those fields aren't currently in the IPC payload from
`shot:info`, and the design's "120f · 14 MB · sandra · 2h ago"
line is partly fluff for our single-user workflow. Decluttering
won out — we can revisit if/when the data is cheap to gather.

### Added — slight card hover lift
The card already had a `border-color` transition on hover. dev29
adds a subtle background shift (`var(--bg-2)` → `var(--bg-3)`)
on the same hover state. Cheap (no transform, no shadow blur),
matches the dev26 Vault card hover, and gives the user a tactile
"this row is interactive" cue.

### Performance discipline (per spec)
- `position: absolute` for the kebab menu — composite-only, no
  reflow.
- Solid alpha fills throughout (no `backdrop-filter`).
- 80–120ms transitions on `background` / `color` / `border-color`
  only — never on `filter` / `transform` / `box-shadow` (those
  cost paint or composite-layer churn).
- Outside-click listener attaches once at document level (not
  per-card), so the cost stays O(1) regardless of how many
  versions render.
- No extra IPC. The kebab is pure DOM toggling.

### Preserved
- Every IPC handler / preload wrapper unchanged.
- The 800ms scripting-lock cooldown in `spawn.js` untouched.
- `rebuildVersions` keyed reconciliation still preserves the
  `<video>` element between refreshes (the new markup is just
  different innerHTML inside the same card div).

### Tests — unchanged at 117/117
Pure markup + CSS + DOM-level JS change. No new logic, no schema
churn.

### Notes for testers
1. Each version card now shows ONE primary button (gold) and one
   `⋯` button, not four buttons.
2. Click the kebab — small menu fades in. Click outside or hit
   Esc to dismiss.
3. The active version's card shows `Mark Final` as primary — fast
   path for the typical "active → final" promotion.
4. If a master file is missing on disk, the meta line shows
   `⚠ master missing` in red where the filename used to be.

---

## [0.5.0-dev28] — 2026-04-28 — **Command Center facelift + bundled Inter / JetBrains Mono**

The main app window now wears the same DNA as the dev26 Vault: cool
neutral grays, gold accent for primary actions, flat solid fills (no
blur), and Inter / JetBrains Mono shipping locally instead of as a
Google Fonts fetch. The two windows feel like one OS-level tool now.

### Added — bundled fonts
`app/assets/fonts/`:
- `Inter-Regular.woff2` / `Medium` / `SemiBold` / `Bold`
- `JetBrainsMono-Regular.woff2` / `Medium` / `SemiBold`

Both `index.html` and `vault.html` declare them via `@font-face` with
`font-display: swap` so the system fallback shows briefly while the
woff2 decodes — no FOIT, no remote round-trip. The package.json
`"files": ["**/*"]` rule already pulls them into the asar at build
time; no changes needed there.

System fallbacks remain in the stack (`'Inter', "Segoe UI Variable",
"Segoe UI", system-ui, …`) so a user with the woff2 missing still
gets a sensible UI.

### Changed — Vault accent: indigo → gold
dev26 shipped with cool indigo (`--accent-h: 250`) per the original
Claude Design handoff. Per the dev28 spec — both windows must feel
like one OS — Vault now uses the same gold accent as Command Center
(`--accent-h: 75`). The dark grays were already shared; the accent
swap closes the loop. Visually: vault buttons that were indigo are
now gold; tag chip hue derivation still works (each tag still gets
its own stable hash-derived hue, independent of the accent).

### Changed — `index.html` design tokens
Replaced the `:root` block:

| Pre-dev28        | dev28                    |
|------------------|--------------------------|
| `--accent: #6aa3ff` (Chiral blue) | `--accent: #d4b85c` (gold ≈ oklch 0.80 0.13 75) |
| `#141414` / `#181818` / `#1c1c1c` etc. | unified `--bg-0` … `--bg-4` ladder matching Vault |
| `"Segoe UI Variable"` UI / `"JetBrains Mono"` mono | local `Inter` / `JetBrains Mono` ahead of system fallbacks |

Legacy aliases (`--bg-sunken`, `--fg`, `--border-soft`, …) are kept
as `var(--bg-1)` etc. mappings so the rest of the 3000-line stylesheet
keeps working unchanged. Surface aesthetics shift; component logic
stays.

### Changed — version cards
Restyled to match the design's hierarchy:

- 16:9 player area via `aspect-ratio: 16 / 9` — instant on resize.
- Solid bottom border between header / video / meta / actions
  (replaces the old single-card padding).
- Flat solid badges (`tier-draft / preview / high / final / active`)
  with mono font, uppercase, 9.5px tracking. No gradient, no glow.
- Active or final cards use a single 1px gold border instead of the
  old 2px outline + inset shadow.
- Action buttons get the gold-on-gold primary treatment for the
  "Set Active" path; secondaries are transparent with hover lift.
- Auto-fill grid (`minmax(320px, 1fr)`) — instant reflow on window
  resize.

DOM markup is **unchanged** — `renderCardShell` still emits the same
`.version > .badges + h3 + video + .meta + .actions` structure. Pure
CSS port; no JS changes.

### Added — "Open Vault" rail bridge button
A permanent, prominent bridge to the Vault window now lives at the
bottom of the project rail:

```
┌─────────────────────┐
│ 🗄  Open Vault      │
│    14 assets        │
│                  ›  │
└─────────────────────┘
```

- Solid alpha fills only — no blur, no gradient.
- Gold border tint on hover; the chevron nudges 2px right (one
  transition, 100ms).
- Subtitle reads `<N> asset(s)` — pulled from `vault:list` on
  startup; falls back to `asset library` if the call fails.
- Collapsed-rail mode: text + chevron hide, icon centers — same
  pattern as the dev27 vault badge collapse.
- The overflow-menu "Open Vault…" entry stays as a fallback (no
  point removing a working surface).

Per the dev28 nomenclature spec, the button label is **"Open Vault"**,
NOT the "Memory Bank" the design used.

### Preserved
- Every IPC handler / preload wrapper — `comm -3` still produces
  zero diff between `ipcMain.handle()` channels and
  `ipcRenderer.invoke()` channels.
- The dev26 800ms scripting-lock cooldown in `spawn.js` —
  untouched.
- All version card behaviors: keyed reconciliation (preserves
  `<video>` between refreshes), truncation with always-visible
  final/active, Ctrl+R Render, the entire context menu.

### Performance-first cuts (per spec)
- No `backdrop-filter: blur(…)` anywhere in either window.
- Solid alpha fills (`rgba()` / `oklch()` with explicit alpha) only.
- Window resize uses CSS Grid auto-fill — zero JS layout work.
- Fonts load locally, no Google Fonts CDN round-trip on cold start.

### Tests — unchanged at 117/117
Pure styling and an HTML insert (the rail-bridge button) — no
new logic, no new IPC.

### Notes for testers
1. Open the main app — palette should feel identical to the Vault
   (same dark grays, same gold accent).
2. Bottom of the project rail: a permanent **🗄 Open Vault** button
   showing the live asset count. Clicking it opens the Vault window
   (same as the overflow menu entry).
3. Render version cards have a flat, breathing layout with the
   16:9 video flush against the meta line. Final / Active state
   shows a 1px gold border, not the old 2px outline.
4. Resize the window — version grid reflows instantly (auto-fill
   minmax(320px, 1fr)). No jank.
5. If the woff2 fonts are missing for any reason, the UI still
   renders fine on Segoe UI / system fallbacks — there's no
   blank-text gap.

---

## [0.5.0-dev27] — 2026-04-28 — **Sidebar collapse: badge IS the trigger**

User report on dev26: the floating `«` / `»` chevron button in the
sidebar header right gutter looked disconnected — the only thing
left in that region once the meta block collapsed away. It read as
broken UI rather than an affordance.

### Changed — vault badge is now the collapse/expand trigger
The `🗄 Vault` badge in the sidebar header is now a `<button>` that
toggles `body[data-sb-collapsed]`. The dedicated chevron button is
gone.

- Badge is the only clickable element in the header — no more two
  competing affordances.
- Hover state: subtle background lift + accent border, signals
  "you can click this" without adding a chevron.
- Focus-visible ring for keyboard users (1px accent outline).
- Title attribute swaps between `Collapse sidebar` and
  `Expand sidebar` so the affordance is discoverable on hover.
- The badge glyph itself doesn't change between states — width is
  the honest signal of collapsed vs expanded.

### Changed — collapsed mode centers icons properly
Pre-dev27 the collapsed sidebar's items were drifting because the
header still had `padding: 10px 6px` while the items used
`justify-content: center; padding: 0`, creating a visual mismatch
between the badge column and the nav-item column.

New collapsed rules:

```css
body[data-sb-collapsed="1"] .sb-header {
    padding: 10px 0;
    justify-content: center;
}
body[data-sb-collapsed="1"] .sb-item {
    justify-content: center;
    padding: 0;
    gap: 0;             /* prevents the hidden name/count from leaving phantom space */
}
body[data-sb-collapsed="1"] .sb-item[data-active="true"]::before { display: none; }
```

The active-item left-edge stripe is suppressed in collapsed mode —
without the label next to it, it reads as visual noise rather than
selection feedback. Active state is conveyed by the item's
`background: var(--bg-3)` highlight, which DOES survive.

### Removed
- `<button class="sb-collapse">` element — gone.
- `.sb-collapse` CSS rule — replaced by interactive states on
  `.sb-vault-badge`.
- The dev26 `«` / `»` text-swap on the trigger (the badge stays
  🗄 in both states).

### Tests — unchanged at 117/117
Pure CSS / DOM change, no logic to test at the lib level.

---

## [0.5.0-dev26] — 2026-04-28 — **Vault redesign — Hybrid Sidebar/Top Bar (performance-first)**

Implementation of the Claude Design handoff (`Vault Redesign.html`)
adapted for an Electron renderer that has to stay snappy while AE
is rendering in the background. The structural hierarchy from the
mock landed; the heavy aesthetic cost did not.

### App shell

```
+--------------------------------------------------------+
|  ▣ Vault › All  …            [search]  [⟳]  [Rebuild]  |  ← top bar
|  TAGS  · #hero #lower-third #framework …                |  ← tag bar
+----------------+---------------------------------------+
| 🗄 Vault       | grid of cards                         |
| filter…        |                                       |
|                |                                       |
| VIEWS          |                                       |  ← sidebar
|  ◇ All         |                                       |
|  ○ Unfiled     |                                       |
| FOLDERS  +     |                                       |
|  ▤ Hero        |                                       |
|  ▤ Lower 3rds  |                                       |
|----------------|                                       |
| Assets    24   |                                       |
| Folders    3   |                                       |
+----------------+---------------------------------------+
| ● Vault ready · 24 assets                              |  ← status bar
+--------------------------------------------------------+
```

CSS Grid for the shell (`auto 1fr auto / auto 1fr`) — instant on
window resize, no JS layout work.

### Ported from the design

- Cool-neutral dark palette (oklch tokens — Chromium 126 handles
  these natively, no perf concern). Single indigo accent.
- Sidebar with Pinned Views (All / Unfiled), Folders section, sidebar
  filter input, vault badge header, footer stat row (asset / folder
  counts).
- Top action bar: breadcrumb (`Vault › <view>`) + asset count + search
  + refresh + rebuild + pick-folder.
- Tag chip strip: only shows tags present in the current
  (folder + search) view, with per-tag counts and a stable
  hue-per-tag color (`hueForTag(tag) → 0–359 deg` via string hash).
- Card visual hierarchy: thumbnail (16:9 aspect-ratio CSS) with
  `Comp · Template` / `Layer · Template` / `Clip` / `Asset` badges
  plus a resolution badge (`1080p`); folder badge in opposite corner;
  title; project · shot meta line; technical line (resolution · fps ·
  files · used Nx — zero usage flagged amber).
- Drag-and-drop: every valid drop target gets a dashed armed outline
  the moment a card is picked up (`[data-drag-target]`); the hovered
  one gets a solid accent ring + soft fill (`[data-drag-over]`).

### Performance-first cuts

| Skipped | Why |
|---|---|
| `backdrop-filter: blur(…)` (3 sites in the source) | High Chromium paint cost — replaced with solid alpha fills |
| Linear gradients on chrome | Solid colors paint cheaper |
| Google Fonts (Inter / JetBrains Mono fetch) | System stack only — feels native, no remote round-trip |
| Custom `.drag-ghost` element | Browser's native drag image is free |
| List view (~200 lines) | Grid covers the immediate need |
| Density picker | Fixed at "cozy" (260px min) |
| Custom window-chrome row | Electron has a native frame |
| Toast component | Status bar already serves the same purpose |
| Tweaks panel | Out of scope for the vault feature |

### Sidebar

- Width 240px (collapsed: 52px). Collapse toggle in the header (`«` /
  `»`); CSS `body[data-sb-collapsed="1"]` hides labels and the filter
  input via simple selectors — no JS layout.
- Sidebar filter input — substring filter narrows the visible folder
  list. Resets `_sbFilter` state on input.
- "+ New folder" affordance lives in the FOLDERS section header (×
  next to the label) instead of as a pill — discoverable, doesn't
  get in the way.
- Right-click any folder for the rename / delete context menu (kept
  from dev25; the floating `<div>` menu stayed).

### Tag bar

- Real-time chip strip below the action bar.
- Chips are scoped to the current view: changing folder or typing in
  search rebuilds the chip list with new counts. Cheap — pure
  in-memory map walk.
- Click a chip to filter the grid by that tag; click again (or the
  red **Clear filter** chip) to drop the tag filter.
- A tag's color is deterministic — `hueForTag(t)` hashes the string
  to a 0-359 degree, fed into oklch via the `--tag-hue` CSS var.

### Drag-and-drop

Same HTML5 surface as dev25, repainted for the new look:

- Cards: `draggable="true"`, `dragstart` puts assetId on
  `dataTransfer` (both `text/plain` and the namespaced
  `application/x-chiral-asset-id`). All sidebar drop targets get
  `data-drag-target="true"` armed at the same instant so the user can
  see where they can land.
- Sidebar items: `dragover` (with preventDefault) sets
  `data-drag-over="true"` for the solid-ring active state. `drop` calls
  the dev24 `vault:folders:assign` IPC.
- The `+ New folder` action and the `All` view aren't drop targets —
  no useful semantics. The "Unfiled" view IS — drop on it to clear an
  asset's folder assignment.

### dev20 lock — 800ms cooldown after release  *(critical)*

Even with dev20's serialization, AE occasionally still raised the
"second script while another is running" warning when consecutive
JSX dispatches landed within ~200-300ms of each other. The lock was
correctly released, but AE's host hadn't fully unwound the previous
script's UI state.

`spawn.js` adds a mandatory cooldown:

```js
const AE_LOCK_COOLDOWN_MS = 800;
let _aeCooldownUntil = 0;

function _innerReleaseAELock() {
    /* … reset state … */
    _aeCooldownUntil = Date.now() + AE_LOCK_COOLDOWN_MS;
    /* wake next waiter */
}

async function acquireAELock(label) {
    if (_aeBusy) await new Promise(r => _aeQueue.push(r));
    // dev26 — honor cooldown (whether woken from queue or walking in fresh)
    const now = Date.now();
    if (_aeCooldownUntil > now) {
        await new Promise(r => setTimeout(r, _aeCooldownUntil - now));
    }
    _aeBusy = true;
    /* … */
}
```

Stored as an absolute timestamp (not a running setTimeout) so a queued
waiter can compute the remainder exactly when its turn comes.

### Tests — 116 → 117 (net +1)
New `acquireAELock: enforces the dev26 800ms post-release cooldown` —
times the gap between a release and the next acquire, asserts ≥600ms
(safety margin for slow CI clocks targeting 800ms).

Suite duration jumped from ~0.5s to ~10.7s — back-to-back acquires
in earlier lock tests now sleep 800ms between each. Acceptable given
the production-correctness win; can add a test-mode cooldown override
later if it becomes friction.

### IPC parity holds
`comm -3` between `ipcMain.handle()` and `ipcRenderer.invoke()` still
produces zero diff. No new channels in dev26 — the vault.html rewrite
consumes the existing surface.

### Notes for testers
1. **Resize the window** while the vault is open. Should be instant —
   no jank, no relayout flash. Sidebar stays a fixed 240px; grid
   reflows to fill the rest.
2. **Drag a card** — the sidebar's pinned views and every folder
   should immediately show a dashed outline. Hover over one — it
   gets a solid accent ring. Drop — asset moves, status confirms.
3. **Click a tag chip** — grid filters to assets carrying that tag,
   chip goes solid-fill, a "Clear filter" chip appears at the front.
4. **Collapse the sidebar** with the `«` button — width drops to
   52px, only icons remain. The "+ New folder" affordance is in
   the section header, not a pill, so it stays reachable in the
   collapsed state too (just unlabelled).
5. **AE serial dispatch:** kick off a vault, then immediately try a
   second one. Queued; second runs after the first's sentinel +
   800ms cooldown. The "second script" warning should not appear
   even on consecutive vaults.

---

## [0.5.0-dev25] — 2026-04-25 — **Folder UI fixes + drag-and-drop**

dev24 shipped the folders backend cleanly, but the UI had two
breakages that made the whole feature unusable:

### Fixed — empty gold pill (the "+ New folder" was invisible)
Both the **All** pill and the **+ New folder** pill were created
with `id === null`. With the default filter (`_currentFolderId === null`),
the active-class condition matched BOTH, applying the gold
`background:var(--accent)`. Combined with `.pill.add { color:var(--accent); }`,
the result was gold text on a gold background — invisible.

Replaced the `null` sentinel with a string taxonomy so each pill
kind is uniquely identifiable:

```js
'all'     // no folder filter
'unfiled' // assets with no folder assignment
<fldId>   // a specific folder
'add'     // the "+ New folder" affordance (action, not a filter)
```

The active class is now applied only to filter pills and never to
the add pill.

### Fixed — "+ New folder" did nothing
dev24 used `window.prompt('New folder name:')` — **Electron disables
`window.prompt`** in renderer windows. It returns `undefined`
synchronously, the next `if (!name) return` exits silently, and
nothing happens. Same issue for the rename/delete flow on
right-click.

Replaced both with proper `<dialog>` elements:

- **`#folder-name-dialog`** — text input, used for both `Create`
  and `Rename` (mode flag in `_folderNameCtx`). Inline error text
  for "name cannot be empty" / "folder name already exists" without
  a second alert. Enter submits; Esc cancels.
- **`#folder-confirm-dialog`** — explicit destructive confirm for
  folder deletion. Previously the deletion path ran through a
  `confirm()` call, which is also unreliable under Electron.

Right-click on a folder pill now opens a tiny floating context menu
(absolute-positioned `<div>`, not a real menu component) with
**Rename…** and **Delete…** items that route into the new dialogs.
Clicks outside the menu close it.

### Added — drag-and-drop asset → folder
Replaces dev24's per-card 📁 button (and its move dialog), which
the user reported as "unintuitive."

- **Cards** — `draggable="true"`. `dragstart` writes the assetId to
  `dataTransfer` (both `text/plain` for browser convention and
  `application/x-chiral-asset-id` for namespace clarity), adds a
  `.dragging` class for visual feedback, and stamps
  `body[data-dragging="1"]` so the rest of the grid dims.
- **Pills** — `dragover` (with `preventDefault` to allow drop) /
  `dragleave` / `drop`. Drop reads the assetId, calls
  `window.vault.folders.assign()`, refreshes. The `+ New folder`
  pill and the `All` pill don't accept drops (the Add pill has no
  target semantics; All-as-drop would just duplicate Unfiled).
- **`.drop-hover` state** — gold outline + warm-tinted background
  while a card is being dragged over a valid pill. CSS-only.

Standard HTML5 DnD throughout — no library, no synthetic event
plumbing.

### Removed — per-card 📁 button + the dev24 move-dialog
DnD covers the same use case more directly. Keeping the redundant
button would split affordances ("how do I move an asset, the icon
or the drag?") with no benefit. The button's CSS hooks were dropped
too. The move-dialog's HTML was replaced with the new
folder-name/confirm dialogs.

### Other fixes
- **Toolbar visible on empty vault.** Pre-dev25 we hid the toolbar
  until at least one asset existed, so users couldn't pre-create
  folders. Now the toolbar shows whenever a vault root is configured.
- **Empty-folder hint updated:** "drag a card onto this pill to move
  it here" instead of the obsolete "click 📁 on any card to move
  it here."
- **`_currentFolderId` initial value** changed from `null` to
  `'all'` to match the new taxonomy.

### Tests — unchanged at 116/116
The dev24 vault_folders.js tests cover the storage layer (which
this dev didn't touch). The UI changes are pure DOM glue — visual
regressions are easier to catch by inspection than by harness.

### Notes for testers
1. Click `+ New folder` — dialog should pop, type a name, press
   Enter or click Create.
2. Drag any card onto a pill — pill should highlight gold while
   hovering, status bar should report `Moved to <folder>` after
   release.
3. Right-click a folder pill — small menu with Rename / Delete.
   Both route through dialogs (no native prompts).
4. With no assets in the vault, the `+ New folder` pill should
   STILL be visible and clickable (it wasn't pre-dev25 — toolbar
   was hidden until first asset).

---

## [0.5.0-dev24] — 2026-04-25 — **Vault polish: thumbnails for templates, folders, search**

Three coordinated UX improvements asked-for in one cycle. None of
them required schema migration; all of them are additive.

### 1. Visual previews for procedural templates

`vault_clip.jsx` now renders a still thumbnail per procedural asset
right after the reduce/save step:

```js
subjectComp.saveFrameToPng(subjectComp.duration / 2, new File(thumbPath));
```

- AE 14.2+'s `CompItem.saveFrameToPng` — full-resolution PNG, no
  render-queue plumbing needed.
- Frame picked at the midpoint of the comp's duration. Frame 0 is
  too often a fade-in or pre-key state for a useful preview;
  midpoint is the "hero frame" most templates show off.
- Wrapped in try/catch — a render error (missing font, expression
  that throws on first eval) doesn't fail the extraction. The asset
  just lands without a thumbnail.
- `proceduralAssets[].thumbnail` carries the relative path to the
  orchestrator, which stamps `asset.files.thumbnail` via
  `A.writeAsset`. The vault grid's existing `<img>` path renders it
  immediately — no UI changes needed.

Also: badges on procedural cards split into `COMP TEMPLATE` /
`LAYER TEMPLATE` (was the generic `ASSET`) so users can tell at a
glance which extraction path produced each tile.

### 2. Virtual folders

New module `lib/vault_folders.js` — folders are metadata only,
NEVER move bytes on disk. Asset dirs stay UUID-flat under
`<vault>/assets/`.

Storage: `<vault>/folders.json`
```json
{
  "schemaVersion": 1,
  "folders": [{ "id": "fld_abcd1234", "name": "Lower thirds", "createdAt": "..." }],
  "assignments": { "<assetId>": "<folderId>" }
}
```

Single folder per asset is the dev24 simplification — multi-folder
or tag-style organization can layer on later by changing the value
shape; nothing in the asset side knows.

`rebuildIndex` reads `folders.json` once and stamps `folderId` on
every projection row, so cards know their folder without an extra
IPC call.

**IPC surface:**
- `vault:folders:create  ({name})    → {ok, id}`
- `vault:folders:rename  ({id,name})`
- `vault:folders:delete  ({id})`     — orphans assignments back to "Unfiled"
- `vault:folders:assign  ({assetId, folderId|null})`

`vault:list` now returns `folders[]` inline alongside `assets[]`
(one round-trip for the whole vault state). `vault:delete` clears
the folder assignment on its way to trash so a future restore
lands the asset in Unfiled rather than a dangling reference.

**UI:**
- New toolbar between header and grid: search input on the left,
  folder pills on the right. Sticky-attached so filters stay
  visible while scrolling.
- Folder pills: `[All]`, `[Unfiled]`, one per folder, then
  `[+ New folder]`. Clicking a pill filters; right-clicking a real
  folder pill prompts for rename / delete (native `prompt`/`confirm`
  — sufficient for the MVP, no need for a context-menu component).
- Per-card 📁 button next to Reveal opens a small radio-list dialog
  to assign the asset to a folder (or "(Unfiled)").
- `body[data-folder-filtered="1"]` hides the per-card folder badge
  when redundant (already viewing that folder).

### 3. Search & filter

Real-time substring filter on **name** OR any **tag**, both
case-insensitive. Combines AND with the folder filter:

```js
function renderGrid() {
  const matches = _allAssets.filter(a => {
      // folder filter ...
      // search filter (name OR tags) ...
  });
  // ...
}
```

Filtering is pure client work over a cached `_allAssets` array — no
IPC on every keystroke. Status bar shows `N / total assets` while a
filter is active so users see how much they've narrowed.

Empty-state messages are filter-aware: "No assets match 'foo'" /
"This folder is empty. Click 📁 on any card to move it here." /
"No unfiled assets — everything is in a folder."

### Tests — 101 → 116 (net +15)
New `test/vault_folders.test.js`:
- `newFolderId` / `isValidFolderId` regex
- `readFolders` defaults on missing/corrupt file
- `createFolder` happy path + empty-name + duplicate-name + length cap
- `renameFolder` round-trip + collision detection + bad-id error
- `deleteFolder` clears affected assignments
- `assignAsset` assign / reassign / unfile + bad-folder error
- `removeAssignment` idempotency

UI side (toolbar, dialogs, filtering) isn't unit-tested — it's
straightforward DOM glue and visual regressions are easier to catch
by inspection than by harnessing a renderer.

### IPC parity holds
`comm -3` between `ipcMain.handle()` channels and
`ipcRenderer.invoke()` channels still produces zero diff post-add.

### Notes for testers
1. Vault a procedural template (mark a comp or solid layer with
   `CHIRAL:TAG=hero`, then `↑ Vault marked clips / templates…`).
   The new card should show a real thumbnail immediately rather
   than the placeholder.
2. In the vault window, click `+ New folder`, name it "Lower
   thirds". Click 📁 on a card → pick "Lower thirds" → Move.
3. Click the "Lower thirds" pill — only assets in that folder show.
4. Click "All", type into the search box. Cards filter live.
5. Right-click the "Lower thirds" pill — type a new name to rename,
   leave blank to delete (assets fall back to Unfiled).

---

## [0.5.0-dev23] — 2026-04-25 — **Procedural templates — vault comps, solids, text, nulls**

User pushback on dev22's "comps can't be clipped" gate, citing
**Template Holders** (pre-animated text comps, solids with mask +
effect stacks) as legitimate vault targets. They are. Clip mode now
covers three asset shapes:

| Marked | Produces |
|---|---|
| Footage with a real file | bare-file clip (existing dev13) |
| **CompItem** | mini-AEP scoped to that comp + dependencies |
| **Solid / Text / Null / Shape / Adjustment layer** | mini-AEP with the layer copied into a synth wrapper comp matching the parent |

Each procedural mark = one independent asset (separate UUID, separate
asset.json, separate `<vault>/assets/<id>/ae/<name>.aep`). File clips
still bundle into ONE shared asset since they're conceptually a list
of files, not standalone reusables.

### `vault_clip.jsx` — extraction loop

New helpers:

- `generateUUID()` — RFC-4122 v4 layout via `Math.random` (matches
  the regex in `lib/asset.js`'s validator).
- `sanitizeFilename()` — strips filesystem-hostile chars from
  comp/layer names so they're safe `.aep` basenames.
- `findCompByName()` — re-locates a CompItem after `app.open()`
  reload between iterations.

New plan-driven extraction loop after the file-clip pass:

1. `app.project.save(<vault>/assets/<id>/ae/<name>.aep)` — Save As
   to the freshly minted procedural-asset dir. The in-memory project
   is now bound to mini.aep; original `srcFile` on disk is untouched.
2. **Comp plans:** `app.project.reduceProject([targetComp])` to keep
   only the marked comp + its transitive footage / nested comps.
3. **Layer plans:** `app.project.items.addComp(...)` synthesizes a
   wrapper comp matching the parent's `width / height / pixelAspect /
   frameRate` (and the layer's own `outPoint - inPoint` for
   duration). `srcLayer.copyToComp(wrapper)` carries effects, masks,
   keyframes, and parent-child structure across. Then reduce to the
   wrapper.
4. `app.project.save()` to flush the reduced mini.aep.
5. Reopen `srcFile` for the next plan via
   `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES) + app.open(srcFile)`
   so each iteration starts from a clean source.

dev20's AE scripting lock holds across the whole `vault_clip.jsx`
invocation, so the multiple internal `save / reduceProject / open`
operations serialize naturally — no risk of another `-r` landing on
AE mid-extraction.

### `clipShot()` — finalize procedural assets Node-side

- Job payload now includes `vaultRoot` so the JSX can mint asset
  dirs on the fly (file clips still go into the pre-minted
  `targetDir`).
- Done sentinel grew a `proceduralAssets[]` field. Each entry is
  `{assetId, assetDir, aeProject, aeRoot, name, kind: "comp"|"layer",
  tags, specAtVault}`.
- For each procedural asset: validate `assetId`, confirm
  `<assetDir>/<aeProject>` exists on disk, build the manifest with
  `A.createAsset({type:'asset'})` (same shape as the legacy
  full-shot vault — so `import_asset.jsx` import-into-open-AE flow
  from dev19 works on these unchanged), stamp `files.aeProject /
  aeRoot`, write via `A.writeAsset`.
- `dependencies.footage` carries a single
  `{templateKind: "comp"|"layer"}` marker so a future "filter to
  comp templates" UI can split them out.
- If clipList is empty AND only procedural assets came back, the
  pre-minted file-clip `assetDir` (which is now empty) gets torn
  down with `fs.rmSync(recursive)` so the vault doesn't accumulate
  ghost dirs.

Return shape extended:
```js
{
  ok: true,
  assetId,                // file-clip asset OR first template
  assetDir,               // null if no file clips
  clipCount,
  templateCount,          // dev23 — number of procedural assets
  templateAssetIds,       // dev23 — their UUIDs
}
```

### Updated user-visible text

- **Overflow menu button** renamed from `↑ Vault marked clips…` to
  `↑ Vault marked clips / templates…`. Tooltip extended to mention
  that comps and layers become mini-AEP templates.
- **Status toast** after a clip-vault run now says
  `"Vaulted 2 clips + 1 template from Shot_002."` rather than the
  old clip-only count.
- **Vault window empty state** lists all three production paths
  (footage → clip, comp → mini-AEP, layer → wrapped mini-AEP) so
  users see the rules before they hit the failure dialog.
- **`vault_clip.jsx` failure dialog** updated to mention that comps
  and layers are now valid targets.

### Why `type:"asset"` (not a new type) for templates
Procedural templates ARE full asset.aep bundles, just scoped to one
element. The dev19 import-into-open-AE flow (`importAssetToOpenAE`
→ `import_asset.jsx`) already does the right thing for `.aep`
imports — `app.project.importFile()` on a mini-AEP nests the
template's comp(s) into the user's working project. Adding a new
`type:"template"` would have required forking that flow without
changing behavior. Templates appear in the vault grid as regular
asset cards (with their own thumbnails — coming once we render
template previews; currently they show "proxy pending").

### Tests — unchanged at 101/101
The new logic is in the AE host (no Node test reach) plus a
sentinel-shape extension that's purely additive on the Node side.
`A.createAsset` and `A.writeAsset` are exercised by existing
asset.js tests; the new procedural-asset finalization path goes
through the same code.

### Notes for testers
1. Open a shot with a comp containing a Solid/Text/Null layer.
2. Mark the **comp** itself (Project panel Comment) with
   `CHIRAL:TAG=hero_comp`. Save the .aep.
3. Mark a **solid layer** in the timeline (Comment column or
   Shift+8 marker) with `CHIRAL:TAG=hero_solid`. Save.
4. Main app → overflow menu →
   **↑ Vault marked clips / templates…**
5. Vault window should now show TWO new asset cards (one per
   marker), each tagged appropriately. Click `→ AE` on either —
   the comp (or wrapped layer) imports as a top-level FolderItem
   in your active AE project.
6. The original .aep is untouched throughout — verify in AE that
   your source project hasn't changed.

---

## [0.5.0-dev22] — 2026-04-25 — **Clip mode: scan all 3 marker surfaces + better discoverability**

User report on dev21: marking `CHIRAL:TAG=foo` was still not producing
clip vault entries. Investigation showed two gaps in the scan:

- **Layer markers (Shift+8) weren't read at all.** dev14 added the
  Timeline `Comment` column pass but missed the per-layer marker
  property. A user reasonably treats them as the same kind of
  metadata — both are layer-attached free-text fields — and gets
  surprised when one works and the other doesn't.
- **The failure-mode UI didn't list every supported surface,** so
  even when the user *was* in the right ballpark, they couldn't tell
  which placement to try.

### Changed — `vault_clip.jsx` now scans all three surfaces
Pass 1 (Project panel) is unchanged: `Item.comment` on every item
in the project. CompItems hit a clearer skip message ("comps can't
be clipped — mark the underlying footage item or its layer instead")
since users were trying to mark whole comps and getting silence.

Pass 2 (Timeline) now scans **two** sources per layer, not one:

- `layer.comment` (Timeline `Comment` column)  ← already in dev14
- `layer.property("Marker").keyValue(N).comment` for every Shift+8
  layer marker  ← **new in dev22**

New helper `getLayerMarkerComments(layer)` reads the layer's marker
property the same way `vault_collect.jsx` reads comp markers
(1-indexed `numKeys`, defensive try/catch on each `keyValue` call).

New helper `parseClipCommentSet(comments)` folds multiple comment
strings into a single `{isClip, tags[]}` so a layer marked via BOTH
its comment field AND a Shift+8 marker doesn't produce two clip
entries — tags merge instead.

Telemetry on the done sentinel now tracks all three sources
separately:
```
foundProjectMarks       — Project-panel Comment column hits
foundLayerCommentMarks  — Timeline Comment column hits
foundLayerMarkerMarks   — Shift+8 layer marker hits
```
Useful when debugging a future "I marked it and nothing happened"
report — we can see which surface(s) the user hit and which they
missed.

### Changed — failure messages enumerate all 3 surfaces
Pre-dev22 "no markers found" said:
> No CHIRAL:CLIP markers found. Add one to either:
>   • a footage item's Comment column in the Project panel, or
>   • a layer's Comment column in the timeline.

dev22 expands to:
```
No CHIRAL:TAG= or CHIRAL:CLIP markers found.

Add a marker to ANY of these places:
  • Project panel — the "Comment" column on a footage item
  • Timeline panel — the "Comment" column on a layer
  • Layer marker (Shift+8) — set the marker's comment

Format:
  CHIRAL:TAG=name   (the tag is also the include flag)
  CHIRAL:CLIP        (include without tagging)
  Both can be combined: CHIRAL:CLIP; CHIRAL:TAG=name
```

The "found markers but nothing got vaulted" branch (markers on
solids/comps/empty layers) keeps its surface-by-surface skip list
plus the "mark the layer that USES the footage" tip.

### Added — visual guide in the empty-vault state
The vault window's empty-state pane was just "Vault this shot from
the overflow menu." dev22 expands it to explain BOTH paths and the
marker convention with the three placement bullets, so users see
the rules before they need them. Small but hopefully eliminates the
"I marked something, where is it?" loop.

Tooltip on `↑ Vault marked clips…` overflow button extended to
mention all three surfaces in one line.

### Tests — unchanged at 101/101
Same reason as dev21 — JSX changes aren't reachable from the Node
test harness. Verified by inspection against the AE Scripting Guide:
`layer.property("Marker")` is the documented path for Shift+8
markers (same shape as `comp.markerProperty`), confirmed in AE
14.0+ docs.

### Notes for testers
Three placements to try, all should work:
1. **Project panel:** select a footage item, find the "Comment"
   column (toggle column visibility from the panel header gear icon
   if hidden), type `CHIRAL:TAG=foo`.
2. **Timeline:** in any open comp, find the "Comment" column on a
   layer (toggle via right-click on column headers if hidden), type
   `CHIRAL:TAG=foo`.
3. **Layer marker:** select a layer, press Shift+8 to drop a marker
   at the playhead, double-click the marker, type `CHIRAL:TAG=foo`
   in the comment field.

Then `↑ Vault marked clips…` from the main app's overflow menu.
The vault window should show a new clip card tagged `foo`. If it
doesn't, the error dialog now lists every surface checked so you
can see where your marker landed (or didn't).

---

## [0.5.0-dev21] — 2026-04-25 — **Hover-play stability + tagging-implies-clipping**

Two user-reported issues from the dev20 round of testing.

### Fixed — vault hover-play preview was glitching to black
**Symptom:** the proxy video on a vault card would play briefly,
turn black, freeze, then sometimes recover unprompted as the user
hovered around the grid.

**Root cause:** the hover handler was tearing down + recreating the
`<video>` element on every mouseenter / mouseleave:

```js
thumb.addEventListener('mouseenter', () => {
    thumb.innerHTML = '';                    // ← nukes prior <video>
    const v = document.createElement('video');
    v.src = '...'; v.autoplay = true; ...   // ← spins up new decoder
    thumb.appendChild(v);
});
```

Rapid hover thrashed Chromium's media decoder: a new instance per
cycle, old ones still GC-pending, frame buffers colliding. Eventually
the decoder pool would recover and the video would play again — hence
the "randomly comes back" symptom.

**Fix:** standard cached-video pattern. The `<video>` is lazy-created
on the first mouseenter, then **kept in the DOM** for the card's
lifetime. Subsequent hovers `play()` / `pause()` and toggle
`hidden` — no more decoder churn. `preload="metadata"` so off-screen
cards don't pre-buffer the whole proxy. CSS layers the `<img>`
underneath the `<video>` so the still shows through whenever the
video is hidden.

Bonus: `play()`'s rejection (when the browser aborts due to a
mouseleave mid-load) is now silently swallowed — pre-dev21 it would
log uncaught-rejection noise to the dev console.

### Changed — `CHIRAL:TAG=` on item/layer comments now implies inclusion
**User feedback:** `CHIRAL:TAG=texto` on a layer didn't trigger an
individual clip vault — silently did nothing — and the user
(reasonably) expected it to.

Pre-dev21 vocabulary:
| Marker          | Effect                                       |
|-----------------|----------------------------------------------|
| `CHIRAL:CLIP`   | include in clip vault                        |
| `CHIRAL:TAG=x`  | attach tag `x` (only if also CHIRAL:CLIP'd)  |

Confusing — tagging without inclusion was a no-op trap. The user's
instinct ("I labelled this layer, of course I want to vault it") is
the better default.

dev21 vocabulary on item/layer comments:
| Marker                       | Effect                              |
|------------------------------|-------------------------------------|
| `CHIRAL:CLIP`                | include (no tag) — rare             |
| `CHIRAL:TAG=x`               | include + tag `x` (the common case) |
| `CHIRAL:CLIP; CHIRAL:TAG=x`  | equivalent to just `CHIRAL:TAG=x`   |

Comp-ruler markers (timeline-level `CHIRAL:TAG=`) keep their existing
behavior — they tag the whole asset in vault_collect.jsx, not in
clip mode. Different surface, different intent.

Implementation is one line in `vault_clip.jsx#parseClipComment`:
`if (out.tags.length > 0) out.isClip = true;`. The two-pass scan
(Project panel + every comp's layers, dev14) needed no other change.

Tooltip on the **"↑ Vault marked clips…"** overflow button updated to
mention the `CHIRAL:TAG=` form alongside `CHIRAL:CLIP`.

### Strategic note — keeping both Asset and Clip modes
Surveyed the design choice prompted by the user ("does individual
asset vaulting still pull its weight?"):

- **Asset mode** carries the full .aep + footage. Right tool for
  animations, lower thirds, framework comps — anything where the
  graph IS the artifact. Replacing it would make every reuse drag
  the entire .aep around.
- **Clip mode** carries just files. Right tool for textures, refs,
  PSDs the user wants to drop into other projects without inheriting
  unrelated comp wiring.

The complaint wasn't that Clip mode is wrong — it's that the marker
to opt in was undiscoverable. dev21 fixes the discoverability without
amputating either mode. Future refinement (not in dev21): a vault
window UI for editing tags post-vault, since right now tags are
write-once at vault time.

### Tests — unchanged at 101/101
The hover-play fix is renderer-side (no Node test reach). The
tagging-implies-clipping change is a single condition inside a JSX
function — would need an ExtendScript host to exercise, same as the
rest of `vault_clip.jsx`.

### Notes for testers
1. **Hover-play:** mouse over a card slowly, then quickly. The video
   should play, pause cleanly on leave, and resume on re-hover —
   no black frames, no decoder thrash even when grid-scanning fast.
2. **Tagging:** in AE's Project panel or timeline, set a footage
   item's Comment column to `CHIRAL:TAG=texto` (or any name). Click
   **↑ Vault marked clips…** in the main app's overflow. That single
   item should appear as a clip card in the vault, tagged "texto."
   The `CHIRAL:CLIP` form still works for "include without label."

---

## [0.5.0-dev20] — 2026-04-25 — **AE scripting lock — no more "second script" warning**

User report: triggering vault imports back-to-back (or double-clicking
`→ AE` on a card) raised AE's
*"Attempt was made to run a second script while another script was
already running. Second script was not run."* dialog. ExtendScript is
single-threaded; firing a second `-r` while the first JSX is mid-run
makes AE silently drop the second.

Pre-dev20 we relied on user pacing — fine when there was one AE flow
per click. Once vault grew clip / asset / asset-into-open-project
paths, two near-simultaneous clicks were enough to trip it.

### Added — global AE scripting lock (`lib/spawn.js`)
Three new exports:

```js
acquireAELock(label) → Promise<release>
aeBusyState()       → { busy, label, queueDepth, heldForMs }
setAEBusyEmit(fn)   → void  // hook for renderer broadcast
```

`acquireAELock` returns a release function. Subsequent acquirers wait
in a FIFO queue. Hold the lock across `spawnAE + pollForSentinel` and
no two AE scripts can ever overlap.

**Safety net (point #3 from the user spec):** if a caller forgets to
release, a 20-min timer auto-releases with a `console.warn`. The lock
can never leak forever — worst case is a delayed unblock, never a
permanently-busy app.

`release()` is idempotent so try/finally chains can re-call without
flipping state or waking phantom waiters.

### Wrapped — every vault flow that dispatches AE
- `vaultShot`              — label `vault:collect:<id8>`
- `clipShot`               — label `vault:clip:<id8>`
- `importClipToAE` intoOpen — label `vault:importClipToAE:<id8>`
- `importAssetToOpenAE`    — label `vault:importAssetToOpenAE:<id8>`

Each wraps `await spawnAE + await pollForSentinel` in try/finally. Out
of scope for dev20: `shot:sendToAE` and `shot:renderBack` (they're
slower-paced single-button paths and don't trigger the warning in
normal use; can be wrapped in a follow-up).

### Added — renderer broadcast + UI grey-out
`main.js` calls `SP.setAEBusyEmit(broadcastAEBusy)` at boot.
`broadcastAEBusy` pushes `{busy, label, queueDepth}` to every
`BrowserWindow` over a new `ae:busy` event.

**preload.js** exposes `onAEBusy(cb)` on both `window.api` and
`window.vault` namespaces.

**vault.html** subscribes and toggles `body[data-ae-busy="1"]`.
CSS keyed off that attribute disables every `→ AE`, `→ Resolve`, and
`as shot…` button on every card while busy:

```css
body[data-ae-busy="1"] .card .actions button[data-act="toAE"],
body[data-ae-busy="1"] .card .actions button[data-act="toAEAsShot"],
body[data-ae-busy="1"] .card .actions button[data-act="toResolve"] {
    opacity: 0.45;
    pointer-events: none;
    cursor: not-allowed;
}
```

`pointer-events:none` is the actual click guard — opacity is just
feedback. Status bar mirrors the lock label so the user sees what
the system is waiting on.

**index.html** does the same for the overflow menu's
`Vault this shot`, `Vault marked clips…`, and
`Vault marked shots in project` entries.

### Tests — 96 → 101 (net +5)
New `test/spawn_lock.test.js`:
- Sequential acquires don't overlap (lock works at all).
- FIFO order under contention with three waiters.
- `release()` is idempotent (double-call doesn't break next acquire).
- `aeBusyState()` reports correct `queueDepth` while contended.
- `setAEBusyEmit` fires on every acquire and release.

Auto-release safety net not unit-tested (20-min timer; verified by
inspection).

### Notes for testers
1. Click `→ AE` on a vault card — buttons across the whole grid
   should fade and stop responding while AE works.
2. Try clicking `→ AE` again on a different card before the first
   completes — the click should do nothing, no warning dialog from
   AE.
3. If you queue work fast enough, the second click DOES register
   once the first completes (FIFO queue). Status bar will show the
   active label.

---

## [0.5.0-dev19] — 2026-04-25 — **Asset → AE: drop into the open project**

Symmetric counterpart to dev13's clip → AE flow. Pre-dev19, clicking
`→ AE` on an asset card always opened the import dialog and created a
new shot folder under a chosen project — fine for "I want a fresh
working copy of this asset," wrong for the much more common "I'm in
my working comp and want to drop this lower-third in."

Now: default click is **into the open AE project**. New-shot remains
one click away.

### Added — `scripts/ae/import_asset.jsx`
New AE-side script. Calls
`app.project.importFile(new ImportOptions(<asset>.aep))` in the
running AE — the same operation as `File > Import > File` on a .aep.
The asset's full project (comps + footage refs + fonts + plugin
chains) lands under a top-level FolderItem named after the .aep
basename. Footage paths inside the imported comps resolve against
the vault's asset dir, so things render rather than showing
"Missing footage" placeholders.

If no project is open, AE auto-creates an Untitled one (same
fallback as `import_clips.jsx`). The user keeps working.

### Added — `vault_pipeline.js` `importAssetToOpenAE(ctx, {assetId})`
Mirrors the clip-mode `importClipToAE` intoOpen branch:
- Asset-read + plugin-check pre-flight (same logic as
  `importAssetToAE` so missing third-party effects surface a
  confirm dialog before AE even launches).
- Spawns `import_asset.jsx`, polls sentinel.
- Appends to `asset.usage[]` with `toProject: '(open AE project)'`
  and the open project's file path as `toShot`.
- Returns `{ ok, mode: 'into-open', folderName }`.

`importAssetToAE` (legacy "as new shot") is unchanged — both branches
share the asset-read + plugin pre-flight to avoid drift.

### Added — `vault:importAssetToOpenAE` IPC + preload wrapper
Status toast on success: `"Imported asset into open AE project as
<folderName>"`. AE foregrounds itself when it imports, so no
`shell.openPath` reveal needed (unlike the new-shot path's #4 fix).

### Changed — vault.html: asset cards default `→ AE` to open-project
`renderCard()` for asset-type cards now emits two buttons:

```
[→ AE]  [as shot…]
```

- **`→ AE`** (primary): drop into open AE via the new
  `sendAssetToOpenAE()` helper.
- **`as shot…`** (secondary, small, asset-only): the existing
  project-picker dialog → `importAssetToAE` flow.

Clip cards keep their single-button layout — no analogous "as shot"
mode worth exposing for raw files.

### IPC parity stays clean
`comm -3` between `ipcMain.handle()` channels and
`ipcRenderer.invoke()` channels still produces zero diff.

### Tests — unchanged at 96/96
Like the clip-import path, this is an AE-side feature whose pre-AE
branches (no asset, no .aep, plugin confirm) reuse code paths that
are already covered by the existing asset-read tests. No new shape
to assert at the Node level.

### Notes for testers
1. Vault a shot you've already vaulted before so there's at least
   one asset in the vault.
2. Open your working .aep in AE.
3. Open the vault window, click `→ AE` on the asset card.
4. The asset's comps should appear in the AE Project panel under a
   folder named after the asset's .aep, with all footage refs
   resolving (no red "Missing footage" tags).
5. The legacy "into a new shot folder under a project" flow is now
   the small `as shot…` button next to `→ AE`.

---

## [0.5.0-dev18] — 2026-04-25 — **Audit cleanup: atomic sentinels + single job.json parse (#3 + #7)**

Two more from the dev15 audit punch list — both invisible until they
bite, but easy fixes.

### Fixed — atomic sentinel writes (#3)
The Node-side `pollForSentinel` polls every 500ms with
`fs.existsSync(doneFlag)` then immediately `JSON.parse`s the contents.
The .jsx writers were doing:

```js
f.open("w"); f.write(jsonStringify(obj)); f.close();
```

Which opens a window — small but real on Windows where buffer flushes
can lag the file-create — where Node sees the file but reads partial
or zero bytes. Result: `JSON.parse` throws `"malformed done flag"`,
which `pollForSentinel` reports as a fatal error.

Fixed in `vault_collect.jsx`, `vault_clip.jsx`, `import_clips.jsx`:
the new `writeJSON` writes to `<flag>.tmp`, then `tmp.rename(f.name)`
to the real path. **Renames within a folder are atomic on NTFS and
POSIX**, so the poller either sees no flag or the complete flag —
never a partial one. Belt-and-braces: we `f.remove()` any stale
target first since ExtendScript's `File.rename` won't overwrite on
Windows.

`create_comp.jsx` and `render_version.jsx` use the same write
pattern but their consumers don't poll-and-parse the same way; left
unchanged for this pass.

### Fixed — single job.json parse per vault op (#7)
`canVaultShot` parses `source/job.json` to validate preconditions.
`vaultShot` and `clipShot` then parse it AGAIN to read `aepPath`,
`fps`, etc. for the asset manifest. Two stat+open+parse calls per
vault op for one file.

`canVaultShot` now returns `{ ok, finalVersion?, masterPath?,
hasMaster, job }` — the parsed object goes along for the ride.
`vaultShot` and `clipShot` consume `pre.job` instead of re-reading.

Microscopic perf win on its own (cheap on local SSD), but the
benefit is structural: a single source of truth for what the job
JSON looked like at precondition time, no risk of the file changing
between checks.

### IPC parity stays clean
`comm -3` between IPC handlers and preload wrappers still produces
zero diff post-strip (dev17 invariant holds).

### Tests — unchanged at 96/96
`canVaultShot`'s tests don't reference `pre.job` so they keep
passing. The atomic-sentinel change is in the AE host (no Node
reach) — the existing `pollForSentinel` tests cover the
malformed-flag detection branch we still want to keep around for
the pre-dev18 .jsx files in the wild.

### Audit punch list, current
- ✅ #1 collision suffix (dev15)
- ✅ #2 skip-and-warn imports (dev16)
- ✅ #3 atomic sentinels (dev18)
- ✅ #4 cross-project visibility (dev15)
- ✅ #5 TEMP cleanup (dev16)
- ✅ #6 timeout bump (dev16)
- ✅ #7 single job parse (dev18)
- ✅ #8 dead render-mode IPC (dev17)
- ✅ #9 dead vault IPC surface (dev17)
- ⚠️ #10–14 cosmetic / low-risk (deferred)
- ⚠️ #15–17 test gaps (deferred)

---

## [0.5.0-dev17] — 2026-04-25 — **Audit cleanup: strip dead IPC surface (#8 + #9)**

Following the dev15 audit. No behavior change for users — this is
internal hygiene that removes future maintenance traps (every dead
IPC handler is something a future contributor has to read, fact-check
against the renderer, and decide whether to keep).

### Removed — never-called IPC handlers + preload wrappers

**Audit #8 — render-mode/quality dropdown that was never built:**
- `shot:setRenderMode` (handler + `setRenderMode` preload wrapper)
- `shot:setRenderQuality` (handler + `setRenderQuality` preload wrapper)

These wrote `job.renderMode` / `job.renderQuality` for a UI dropdown
that doesn't exist. job.json schema is permissive — pre-existing
shot files keep working untouched, we just don't accept new mutations
from a renderer that wouldn't know what to do with them.

**Audit #9 — vault surface area that no UI consumes:**
- `vault:getRoot` — same info is already in `vault:list`'s payload.
- `vault:read` — was for an asset detail drawer that didn't ship.
- `vault:listTrash` / `vault:restore` / `vault:purgeTrash` — trash UI
  scoped out of the MVP. **Trash retention is unchanged** —
  `VAULT.purgeOldTrash()` still runs on every app boot in
  `applyConfig()`. Users who delete an asset still get the 7-day
  recoverable window; we just don't expose the recovery UI yet.
- `vault:verifyPortability` — debug helper without a UI button.

All the underlying functions in `lib/vault.js` and `lib/asset.js`
remain — only the IPC wrappers were stripped. Re-exposing any of
these is a one-block paste from git history when the corresponding
UI ships.

### IPC parity verified
`comm -3` between `ipcMain.handle()` channels and
`ipcRenderer.invoke()` channels now produces zero diff — every
handler has a wrapper, every wrapper has a handler. Useful invariant
to keep, since a mismatch in either direction means dead code or a
runtime failure waiting to happen.

### Net change
- main.js: −82 lines
- preload.js: −7 wrappers (kept inline comments noting the strip
  with reattachment instructions for future-self)

### Tests — unchanged at 96/96
The stripped surface had no test coverage (which is part of why it
was easy to confirm dead). Tests of the underlying `VAULT.*` and
`A.readAsset` functions cover the same code paths.

---

## [0.5.0-dev16] — 2026-04-25 — **Vault: skip-and-warn imports, TEMP cleanup, longer timeout**

Three audit-list cleanups (#2, #5, #6 from the dev15 punch list).
None user-visible until something goes wrong, but each one removes a
sharp edge.

### Fixed — `importClipToAE` no longer fails the whole import on one missing file (#2)
Pre-dev16, `importClipToAE` did:

```js
for (const ap of clipAbs) {
    if (!fs.existsSync(ap)) return { ok: false, error: 'Clip file missing on disk' };
}
```

One missing clip file (drive issue, partial trash restore, manual
cleanup gone wrong) aborted everything. The AE script on the other
side already tolerates per-file failures, so the all-or-nothing gate
on the Node side was the weak link.

New `_partitionExistingClips(clipAbs)` helper splits the list into
`{present, missing}`. Behavior:

- All present → unchanged.
- Some missing, some present → import the present ones, surface
  `missing[]` (basenames) in the result, status toast says
  `"N clip file(s) missing — importing the rest"`.
- All missing → still error (the asset is genuinely damaged).

Both branches (`intoOpen` and the new-shot fallback) use the
filtered list, so no broken paths reach AE.

### Fixed — TEMP-dir job files are cleaned up after AE finishes (#5)
`vaultjob_<id>.json`, `clipjob_<id>.json`, `clipimport_<id>.json`
used to accumulate forever in `%TEMP%/` — every vault op left a few
KB behind. New `_quietUnlink(p)` is called once we know AE is done
with the file (a sentinel arrived). On AE-dispatch errors we still
clean up. **Timeout case keeps the file** — that's the one place
where the temp blob is useful for debugging a missing AE response.

### Fixed — `importClipToAE` timeout bumped 5 → 15 min (#6)
Cold AE boots from clean caches comfortably exceed 5 min on slower
boxes. Importing was the only path using a non-default timeout;
unifying with `pollForSentinel`'s default removes a class of false
"timeout" failures.

### Added — `pollForSentinel` returns `timedOut: true` on timeout
The temp-cleanup paths needed to distinguish "AE wrote an error
sentinel" (we can clean up) from "AE never came back" (keep the
temp file for forensics). Pre-dev16 we'd have to string-match the
error message, which is brittle. Now there's an explicit flag.
Error text simplified from
`"timeout waiting for AE vault_collect sentinel"` (stale name —
also fired from clip paths) to `"timeout waiting for AE sentinel"`.

### Tests — 92 → 96 (net +4)
- `_partitionExistingClips`: all present / mixed / all missing.
- `pollForSentinel`: error sentinel does NOT set `timedOut`.
- Existing timeout test extended to assert `timedOut === true`.

---

## [0.5.0-dev15] — 2026-04-25 — **Vault import: collision-safe + visible**

Two related fixes from the audit punch list (#1 + #4 in the dev14
post-mortem). Together they address the symptom "I clicked → AE on a
different project and nothing happened" — which was actually two bugs
stacked:

- The import succeeded, but to a folder the user wasn't looking at.
- And on a re-attempt, `copyDir(force:true)` silently clobbered the
  prior import without telling anyone.

### Fixed — **Auto-suffix on shot-name collision** (#1)
New helper `_availableShotName(targetProjectDir, baseName)` in
`vault_pipeline.js` probes for an existing folder/file at the
candidate name and walks `_2`, `_3`, … until something free is
found (capped at 999 to bound the worst case).

Wired into all three import paths:
- `importAssetToResolve`
- `importAssetToAE`
- `importClipToAE` (new-shot fallback branch)

The result object now carries `renamed: boolean` so the caller can
surface "auto-suffixed — name was taken" in the toast.

### Fixed — **Cross-project imports are now visible** (#4)
Status toasts can be missed when:
- The vault window is showing a different status bar than the main UI.
- The user is in project A and the import lands in project B.

Main.js IPC handlers now `shell.openPath(r.shotDir)` after a
successful import, popping Explorer on the new shot folder. The user
gets an unambiguous "something happened" signal regardless of which
window they were looking at. The `into-open` clip path doesn't need
this — AE auto-foregrounds when it imports.

Status text was also expanded to include the target project name
(`Imported to AE: dragonfruit_trial/Shot_002_from_other_proj`) so
even if Explorer is dismissed quickly, the toast carries the
location.

### Tests — 88 → 92 (net +4)
Four new `_availableShotName` tests:
- Returns base name on empty target.
- Suffixes `_2` on direct collision.
- Walks `_2..N` until free.
- Treats files as collisions too (not just directories).

The full IPC-handler shell-open path isn't easily testable in Node
without a real Electron `shell`, but the helper that decides the
shot name is — which is the bug-prone part.

### Notes for testers
If you re-vault and re-import the same asset, you'll now see folders
like `Shot_002_from_X`, `Shot_002_from_X_2`, etc. instead of the
second one silently overwriting the first. If you're watching for
the new shot to appear in the main UI's project list, **switch the
project dropdown** to the target — the auto-Explorer popup is
window-agnostic but the main UI only shows one project at a time.

---

## [0.5.0-dev14] — 2026-04-25 — **Clip mode: also accept layer-level markers**

User report on dev13 first run: marker placed in the **timeline's layer
Comment column** (the obvious place — it's right there next to the
layer you want to vault) wasn't picked up. dev13's scan only looked at
FootageItem comments in the **Project panel**. Two valid places, my
script knew about one.

### Changed — `vault_clip.jsx` walks layers too
Two-pass scan, dedup'd by FootageItem id:

1. **Project panel pass** (existing) — every `FootageItem` in
   `app.project.items` whose `comment` parses as `CHIRAL:CLIP`.
2. **Timeline pass** (new) — every layer in every `CompItem` whose
   `layer.comment` parses as `CHIRAL:CLIP`. Resolves `layer.source`
   to the underlying FootageItem.

Tags from both passes merge onto the same clip — marking a footage
item in the Project panel AND a layer that uses it doesn't produce a
duplicate.

### Better failure messages
Pre-dev14 the error was a one-liner: "Add CHIRAL:CLIP to a footage
item's Comment column to mark it." Now we distinguish two cases:

- **Zero markers found** — old wording, expanded to mention both
  Project-panel and timeline placement.
- **Markers found but every one points to a Solid / precomp / placeholder**
  — list each skipped name and reason, and suggest "mark the layer
  pointing to the source image/video, not a Solid or precomp." This
  is the case the user hit (the marked layer was a Solid named
  "background" — no file to copy).

### Skip-reason surface
`SolidSource` / `PlaceholderSource` / `CompItem` (precomp layers) are
now individually reported via `skipped[]` rather than silently dropped,
so the done-sentinel telemetry is more useful for future debugging.

### Tests
No Node-level test change — all the new behavior is inside the
ExtendScript host, which our test harness can't reach. The dev13
asset-schema tests continue to cover the manifest contract end of
the contract.

---

## [0.5.0-dev13] — 2026-04-24 — **Vault: Clip mode + import-into-open AE**

The Vault now has two modes side by side:

| Mode    | Captures                | Use for                              |
|---------|-------------------------|--------------------------------------|
| Asset   | full .aep + footage     | animations, lower thirds, frameworks |
| Clip    | tagged files only       | textures, PSDs, ref images, plates   |

Pre-dev13 there was only Asset mode, and "everything I vault drags an
.aep with it" was the right complaint — clip-mode was the original
plan and just hadn't shipped.

### Marker convention (Clip mode)

In AE's Project panel, set a footage item's **Comment** column to:

- `CHIRAL:CLIP` — include this file in the clip vault
- `CHIRAL:TAG=hero` — tag the asset with "hero"
- `CHIRAL:CLIP; CHIRAL:TAG=hero` — both, in one comment

Comments are tolerant of `;`, `,` and whitespace separators, and the
parse is case-insensitive. Tag values are dedup'd, lowercased, and
capped at 40 chars.

### New / changed pieces

**Schema (`lib/asset.js`)**
- New `type: "asset" | "clip"` field. Pre-dev13 manifests with no
  `type` are read as `"asset"` — purely additive, no migration.
- New `files.clips: string[] | null` — relative paths to copied clips.
  Validator walks each entry the same way it walks scalar `files.*`
  fields (must be relative, no `..`).

**Pipeline (`lib/vault_pipeline.js`)**
- New `clipShot(ctx, …)` — mints an asset dir, dispatches
  `vault_clip.jsx`, writes a clip-typed manifest. No master copy,
  no proxy/thumbnail jobs (clips don't render).
- New `importClipToAE(ctx, …)` — two paths:
  - `intoOpen: true` (default from the vault window) → spawns
    `import_clips.jsx`, which calls `app.project.importFile()` for
    each clip into the running AE project's "Vault import" folder.
  - `intoOpen: false` → falls back to copying clips into a new
    `<project>/<shot>/clips/` directory.

**AE-side scripts**
- `scripts/ae/vault_clip.jsx` — walks `app.project.items`, includes
  any FootageItem whose `comment` parses as `CHIRAL:CLIP`. Same
  filename-dedup logic as `vault_collect.jsx`. Throws clearly if
  zero items match (the Electron side surfaces it as a friendly
  "Cannot vault clips: …" dialog).
- `scripts/ae/import_clips.jsx` — drops a clip pack into the open
  project, organized into a Project-panel folder named after the
  asset. Idempotent — re-running with the same name reuses the
  folder instead of creating duplicates.

**IPC (`main.js`)**
- `vault:clipFromShot`  — kicks off `clipShot`.
- `vault:importClipToAE` — kicks off `importClipToAE`.

**Renderer**
- `index.html`: new overflow menu entry **"↑ Vault marked clips…"**
  next to the existing "Vault this shot" — same precondition gating.
- `vault.html`:
  - Cards now carry a `CLIP`/`ASSET` badge in the corner.
  - Clip cards show a 📎 glyph instead of a video thumbnail (clips
    have no master), and `"3 files · used 0×"` instead of the
    width × height × fps line.
  - `→ Resolve` is hidden on clip cards (they're file primitives,
    not timelines).
  - `→ AE` on a clip routes through the new `sendClipToAE()` flow,
    which prefers `intoOpen: true` — drops directly into whatever
    project AE has open.

**Vault index projection (`lib/vault.js`)**
- Adds `type` and `clipCount` to each row so the grid can switch
  layout without reading the full manifest.

### Tests — 82 → 88
Five new asset.js tests covering the type discriminator and clip
files validation (`createAsset` defaults, accepts/coerces type,
validator accepts clip arrays, rejects absolute paths inside, rejects
non-array shapes). The AE/JSX side isn't reachable from Node, so
those scripts are tested by inspection + manual run.

### Not in dev13 (pending list intact)
- `→ AE` for **asset-mode** still creates a new shot — open-AE import
  for full assets needs a different script (the .aep needs to be
  imported as project, not as footage). Tracked.
- Cross-project import bug for asset-mode still in the backlog.

---

## [0.5.0-dev12] — 2026-04-24 — **Vault: PSD/AI layer fix take 2 — skip repoint**

User re-tested dev11 and the PSD still came back flat. Confirmed that
**both** `item.replace()` and `mainSource.file =` drop the per-layer
binding for layered containers — AE re-interprets the file as flat
footage regardless of which API we use. There's no public ExtendScript
path that preserves the binding across a file-path change; it's an
AE scripting limitation, not a usage mistake.

### Changed — layered containers are copied but not repointed
For `.psd / .psb / .ai / .eps` imported as Composition, the manual
collector now:

1. Still copies the file into `<targetDir>/(Footage)/` so the vault
   is self-contained (no dangling reference to the user's working
   disk).
2. **Does NOT** try to update the FootageItem's file reference — the
   vault .aep keeps the original absolute path.

Consequences:

- **Same machine (the only case that matters right now):** original
  path resolves, PSD renders correctly in the vault copy.
- **Moved to a different machine:** AE reports "footage missing" for
  layered files; user right-clicks → Replace Footage → picks the
  `(Footage)/` copy. Relinking through AE's UI **does** preserve
  layer binding (unlike the scripting path), so this is a one-click
  recovery, not a corruption.

The `collected[]` entries for layered containers carry
`repointed: false, reason: "layered container — path preserved"` so
the Electron side can surface this in a future "vault self-check"
view.

### Why this is the right trade-off
- Corruption on the primary local-testing path is unacceptable.
- The cross-machine relink is a manual step we document, not a data
  loss.
- Clip mode (coming in dev13) gives users a clean alternative for
  sharing PSDs without the .aep entanglement at all.

---

## [0.5.0-dev11] — 2026-04-24 — **Vault: PSD/AI layer binding survives the collect step**

User report after dev10: vaulting a shot that contained a layered PSD
(imported as Composition) corrupted the PSD — layers that had been
shaped by the document structure came back as a flat square after the
vault, as if every layer was now the full composite.

### Root cause
`vault_collect.jsx`'s manual collector (dev9) called `item.replace(newFile)`
to repoint each FootageItem at its `(Footage)/` copy. For plain movies
this is fine. For layered containers (PSD, PSB, AI, EPS) imported as
"Composition", AE creates one `FootageItem` per layer — all pointing
at the same .psd, with the layer binding stored in project-level
metadata **outside the FileSource**. `item.replace()` discards that
binding: AE re-imports the file as flat footage and every "layer"
resolves to the whole document.

### Fix — use `mainSource.file =` instead of `item.replace()`
The FileSource has a settable `file` property that rewrites only the
path. It leaves alpha mode, pulldown, loop count, and the layered-
import layer binding untouched, which is exactly what a collect-files
operation wants — we're moving the same bits, not swapping the asset.
`item.replace()` is kept as a fallback if the assignment throws on
an older AE version.

Change is narrow (~15 lines inside `collectFootageManually`) and
doesn't affect movie/flat-image paths.

### Not tested here
AE scripting isn't reachable from our Node test harness. Verified by
inspection of Adobe's FileSource docs and the layered-PSD symptom
match. Please re-test on the backup project and confirm the PSD
layers come back intact.

---

## [0.5.0-dev10] — 2026-04-24 — **Vault window: `→ AE` / `→ Resolve` buttons were dead**

User report after dev9 vaulted cleanly: clicking **→ AE** on an asset
card did nothing at all — no dialog, no error, no status.

### Fixed — **Import dialog never opened (iterating the wrong shape)**
`vault.html → openImportDialog()` called `window.api.listProjects()`
and iterated the result as an array:

```js
const list = await window.api.listProjects();
for (const p of (list || [])) { ... }   // list is {ok, projects, current}
```

But `ipcMain.handle('project:list', ...)` returns `{ok, projects,
current}`, not a bare array. `for..of` on a plain object throws
`TypeError: list is not iterable`, which rejected the async click
handler's promise — silently, because nothing awaits the onclick.
Net effect: `showModal()` never ran. Same bug for **→ Resolve**; the
user only noticed on → AE.

Fix: read `list.projects`, pre-select `list.current`, and surface an
explicit "(no projects — create one in the main window first)" option
if the list is empty (previously the dialog would open with a blank
`<select>` and the Import button would no-op).

Also guard `#import-go` click when the target `<select>` has no value
so we can't dispatch an import against an empty project name.

### No test change
This is a renderer-side shape mismatch; our tests run in Node and
don't spin up the vault window. Fix verified by inspection of the
`project:list` return shape (`main.js:409`) against the iterator site.

---

## [0.5.0-dev9] — 2026-04-24 — **Vault: manual footage collector (AE has no `collectFiles` API)**

Tester/self report: attempting to vault a shot with dev8 blew up with
`Vault failed: ReferenceError: Function app.project.collectFiles is
undefined`. Root cause is embarrassingly mine: I wrote
`scripts/ae/vault_collect.jsx` calling `app.project.collectFiles(...)`
as if it were an ExtendScript API. It isn't. **Collect Files is a
menu-only command in After Effects** (File > Dependencies > Collect
Files); Adobe has never exposed it to scripting. Every shot would have
hit this — not a tagging or precondition issue.

### Fixed — **Replaced nonexistent API with a manual collector**
New helper `collectFootageManually(targetFolder)` in `vault_collect.jsx`:

1. After `reduceProject([primary])`, `app.project.save(<targetDir>/<name>.aep)`
   to perform a Save As — from that point on `app.project` refers to
   the copy, leaving the user's original .aep untouched.
2. Snapshot `app.project.items`, then for each `FootageItem`:
   - Skip `SolidSource` / `PlaceholderSource` (no real file).
   - Skip if `item.file` is missing on disk (logged as `missing`).
   - Skip image sequences for MVP (detected by
     `!mainSource.isStill && !<movie-ext>`) — `replaceWithSequence`
     across AE versions is a separate yak.
   - Copy the file into `<targetDir>/(Footage)/`, de-duping on
     filename collision (`plate.mov` → `plate_1.mov`).
   - `item.replace(newFile)` to repoint the footage item at the copy.
3. `app.project.save()` again so the repointed paths persist.

The done-sentinel now carries `collectSkipped: [{name, reason}, ...]`
so Electron can surface anything we couldn't bring along (missing
source, sequences) without failing the vault.

### Why we don't ship the menu command
Triggering the "Collect Files" menu item from ExtendScript
(`app.executeCommand(2791)`) pops a modal folder picker — it's
interactive, not automatable. The manual walk is the only path that
works in `-r` batch mode.

### Tests
No test change. The existing 82 tests stay green because the AE-side
collector is not (and can't be) exercised in Node — it's the contract
with AE scripting, not with our own lib/ modules.

---

## [0.5.0-dev8] — 2026-04-24 — **Vault: relaxed preconditions + folder-name fix**

Two related fixes for the Vault MVP, both tester-reported:

### Fixed — **`canVaultShot` looked in the wrong folder**
Pre-dev8 the check opened `<shotDir>/versions/<vNN>/` but the real app
layout is `<shotDir>/renders/<vNN>/`. Every vault attempt on a shot
with a finalVersion set was greyed out because the version folder
"didn't exist" — even when v01, v02, v03 renders were sitting there
with masters. Fixed to use `renders/` everywhere (`canVaultShot`,
`vaultShot`, and the test stage helper).

### Changed — **Master render is now optional** (per user design feedback)
The Vault's primary value is the AE project + collected footage, not
the master render. A shot is legitimately vaultable at any life stage:
work-in-progress, cross-project footage transfer, reference, etc. The
new rule set:

**Hard blocks (vault refused):**
- `source/job.json` missing
- `job.aepPath` missing or unreachable

**Soft — used when present, skipped when not:**
- `finalVersion` marked (if unset, we auto-pick the newest `vNN` that
  has a master; if no renders exist at all, we vault without one)
- Master render in the version folder (if none, `asset.files.master`
  is `null`; proxy + thumbnail jobs are skipped; status reads
  `"Vaulted <name> (no master render — AE + footage only)."`)

`canVaultShot` now returns `{ok, finalVersion?, masterPath?, hasMaster}`
instead of the refusal-heavy earlier shape. The UI grey-out logic in
`index.html` keeps working because it still checks `ok`.

### Tests — **81 → 82 (net +1)**
Replaced the three old "refuses when …" tests for the now-allowed
cases with "ALLOWS when …" versions, and added `canVaultShot: auto-picks
newest rendered version when finalVersion not set` to lock the new
WIP-shot behavior.

### Notes for testers
If you had a shot where "Vault this shot" was greyed out before dev8,
it should light up now. If the shot has no master render yet, the
vault will still run — you'll just get an AE-only asset (no hover-play
in the vault window until you vault a later version that has one).

---

## [0.5.0-dev7] — 2026-04-24 — **Resolve SDK runtime fallback + diagnostics**

Follow-up to dev6. A Studio 21 beta install surfaced the
`No module named 'DaVinciResolveScript'` error even though the SDK
file is physically present and the wizard reports it as detected.
This build adds runtime telemetry and a defensive fallback so we can
(a) diagnose the root cause from the log and (b) keep the import
working in the meantime.

### Added — **Python-side import diagnostics**
`relink_latest_render.py` `get_resolve()` now logs before the SDK
import attempt:
- `sys.executable` (which Python `py` picked)
- `sys.version` + `sys.platform`
- `RESOLVE_SCRIPT_API`, `RESOLVE_SCRIPT_LIB`, `PYTHONPATH` env values
- full `sys.path` dump
- explicit `os.path.isfile` check for `DaVinciResolveScript.py` on each
  `sys.path` entry, plus the expected `RESOLVE_SCRIPT_API/Modules/` path.

Output lands in `%APPDATA%/Chiral Network/logs/relink.log`. The error
message now tells users to look there for the dump.

### Added — **sys.path runtime injection fallback**
If `RESOLVE_SCRIPT_API` is set and `<API>/Modules/DaVinciResolveScript.py`
exists on disk, `get_resolve()` now inserts that folder into `sys.path`
before the import attempt — belt-and-braces for the case where
Electron's `env` dict gets mangled between `spawn()` and the child
Python process (detached-spawn stderr redirection, unicode path
quirks, conflicting system PYTHONPATH). Should make the import
succeed on machines where the earlier PYTHONPATH-based approach
silently failed.

### Notes for testers
If you still hit the import error after dev7:
1. Grab `%APPDATA%/Chiral Network/logs/relink.log`.
2. Find the most recent `---- Python import diagnostics ----` block.
3. Share it — the `sys.path` + `RESOLVE_SCRIPT_API` values tell us
   exactly why the import is failing (wrong Python version, missing
   path entry, unicode mangling, etc.).

---

## [0.5.0-dev6] — 2026-04-24 — **Resolve SDK detection + pre-flight**

Follow-up to dev5. dev5 unmasked the real error
(`No module named 'DaVinciResolveScript'`); dev6 detects the condition
up front and guides the user toward the fix.

### Changed — **`detect.detectResolveScripting()` is now authoritative**
Old behavior: checked only whether the Scripting _folder_ existed. New
behavior: walks a candidate list and picks the first root whose
`Modules/DaVinciResolveScript.py` is _actually readable_:
1. `RESOLVE_SCRIPT_API` env override
2. `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting`
3. `C:\Program Files\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting`
4. `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting`

Returns new fields: `moduleExists`, `modulePath`, `candidatesTried`.
`main.js` now resolves `RESOLVE_SCRIPT_API` through this detector at
startup instead of hardcoding the ProgramData default.

### Added — **Pre-flight check on relink dispatch**
`_assertResolveScriptingUsable()` gates both `runRelinkAndAwait()` and
`runForceRelinkAndAwait()`. When the SDK module isn't present, the
dispatch is refused with a clear status message
(`"Relink blocked — DaVinciResolveScript.py not found. Resolve's
Scripting SDK isn't installed at the expected location. Open Setup
Wizard for details."`) instead of spawning Python just to watch it
throw `ModuleNotFoundError` into `.relink.json`.

### Added — **New Setup Wizard row: "DaVinci Resolve Scripting SDK"**
Separate from the existing "DaVinci Resolve scripts folder" row (which
checks where _our_ Python files go). This row is green when
`Modules/DaVinciResolveScript.py` is readable, yellow with remediation
text otherwise. Users no longer have to discover the problem by
running a relink and parsing a cryptic error.

### Notes for testers
If the new "DaVinci Resolve Scripting SDK" row is yellow:
- Check if `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules\DaVinciResolveScript.py` exists. If yes, Resolve 20.x changed the install path on your machine — set the `RESOLVE_SCRIPT_API` env var to point at whichever folder contains `Modules\DaVinciResolveScript.py`.
- If the file doesn't exist anywhere, the Scripting SDK wasn't installed. Reinstall Resolve (Studio has the SDK bundled; Free has shipped both with and without it across versions).
- As a workaround: find `DaVinciResolveScript.py` on another machine (or the Resolve installer media), drop it into a folder of your choice, and set `RESOLVE_SCRIPT_API` to that folder's parent (so the resolved path is `<RESOLVE_SCRIPT_API>\Modules\DaVinciResolveScript.py`).

---

## [0.5.0-dev5] — 2026-04-24 — **Hotfix: relink error-message format bug**

Tester-reported: "Set active version" surfaced a cryptic
`Relink failed: unsupported format character 'R' (0x52) at index 89`
instead of the actual relink error. Root cause: `relink_latest_render.py`'s
`get_resolve()` fallback message contained the literal string
`%RESOLVE_SCRIPT_API%/Modules` (Windows env-var syntax) and was being
fed through Python %-formatting with a trailing `% e` — so the `%R`
was interpreted as a format specifier and raised a `ValueError` that
replaced the real `ImportError` from `import DaVinciResolveScript`.

### Fixed
- `relink_latest_render.py` `get_resolve()` now uses `.format()` instead
  of `%`-formatting when building the "DaVinciResolveScript not
  importable" RuntimeError. The tester will now see the actual
  ImportError text (typically something like
  `No module named 'DaVinciResolveScript'`) which points at the real
  remediation: Resolve's Developer/Scripting SDK isn't on the Python
  path.

### Notes for testers
If after installing this build you see a relink failure that reads
something like `DaVinciResolveScript not importable. Set
RESOLVE_SCRIPT_API, RESOLVE_SCRIPT_LIB and add %RESOLVE_SCRIPT_API%/Modules
to PYTHONPATH before launching. (No module named 'DaVinciResolveScript')`,
the fix is one of:
1. Install Resolve's Studio Developer kit (comes with paid Studio); or
2. Point `RESOLVE_SCRIPT_API` / `RESOLVE_SCRIPT_LIB` at a working
   install via environment variables before launching the app; or
3. Confirm `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules\DaVinciResolveScript.py`
   exists — if not, Resolve's scripting SDK wasn't installed at the
   default location.

---

## [0.5.0-dev4] — 2026-04-24 — **Vault UX: precondition guard + AE-marker tags**

Follow-up to dev2/dev3. Two user-visible fixes:

### Added — **Vault precondition check (`canVaultShot`)**
New authoritative "can this shot be vaulted right now?" check in
`lib/vault_pipeline.js`, exposed via `vault:canVaultShot` IPC and
`window.vault.canVaultShot()` on the renderer side. The four refusal
branches return a human-readable `reason` string:
- `Shot has no job.json — run export_range from Resolve first.`
- `No final version marked. Render a version from AE, then mark it as final.`
- `No master render in <ver>/ — only previews found. Re-render the master.`
- `AE project file missing — open the shot in AE at least once.`

### Added — **AE comp-marker tagging (`CHIRAL:TAG=<value>` / `CHIRAL:VAULT`)**
`scripts/ae/vault_collect.jsx` now reads comp markers on the primary
comp and pipes them through to the asset's initial `tags[]`:
- **`CHIRAL:TAG=<value>`** — each marker comment of that form becomes a
  tag. A single comment can carry multiple tags separated by `;` or `,`
  (e.g. `CHIRAL:TAG=hero;CHIRAL:TAG=approved`).
- **`CHIRAL:VAULT`** — presence of this marker on a comp promotes that
  comp to the primary-vaulted comp, overriding both the shotName match
  and the longest-comp fallback. Useful when the project has multiple
  long comps (pre-comps, alt versions) and the user wants to pin which
  one represents the shot.

Tags are merged with any user-supplied tags in `vaultShot()`, deduped
case-insensitively. The chosen design uses comp markers rather than
layer label colors because (a) colors conflict with studio templating
conventions, and (b) markers are persistent, timestamp-neutral, and
visible in the AE timeline without opening the essential graphics panel.

### Changed — **Precondition-aware overflow menu**
`index.html` now refreshes the disabled-state of "Vault this shot" each
time the overflow menu opens: `window.vault.canVaultShot()` is polled
and the button is greyed out with an explanatory `title` tooltip when
preconditions fail. Click-time re-check gives a friendly `alert()`
instead of letting the user wait through an AE launch only to error out.

### Changed — **`vaultShot()` now routes errors through `canVaultShot()`**
The raw `No master render found in <path>` dialog that prompted this
session is replaced with the friendlier `canVaultShot` reason strings.
The pipeline and the UI grey-out can no longer disagree about what
counts as "vault-able."

### Tests — **76 → 81 (5 new)**
New `canVaultShot` block covers all four refusal branches plus the ok
path with explicit final-version / master-path projections.

---

## [0.5.0-dev3] — 2026-04-23 — **Hotfix: rebrand-aftermath path poison**

Emergency hotfix for a bug that blocked every tester from running
`export_range` in Resolve. Pure path-resolution cleanup — no protocol
or schema changes.

### Fixed
- **`export_range.py` / `relink_latest_render.py` now find the Electron
  config on non-dev machines.** The Electron rebrand bumped
  `productName` from `"Roundtrip"` to `"Chiral Network"`, which moved
  `app.getPath('userData')` from `%APPDATA%\Roundtrip\` to
  `%APPDATA%\Chiral Network\`. The Python scripts still hardcoded the
  legacy path, so on a fresh tester install the config read returned
  `{}`, the roundtripRoot fallback kicked in, and the fallback was a
  **hardcoded dev-machine path** (`F:\CLAUDE\roundtrip_root`) — which
  does not exist on testers' machines. `os.makedirs()` then blew up
  with `FileNotFoundError: [WinError 3] ... 'F:\\'`.
- Both scripts now try `%APPDATA%\Chiral Network\` first, then
  `%APPDATA%\Roundtrip\` as legacy, then fall back to a **safe per-user
  default** (`%USERPROFILE%\Documents\Chiral Network`). The dev-machine
  `F:\...` string has been purged from the shipped Python entirely.
- `_read_pending_shot_name()` in `export_range.py` was updated to use
  the same multi-location search and writes back to whichever location
  the read came from (so legacy installs don't silently duplicate
  config).

### Changed
- `scripts/resolve/chiral_version.py` → `SCRIPT_VERSION = "0.5.0-dev3"`.
  Testers will be nudged to re-install Resolve scripts via the Setup
  Wizard's *Install Resolve scripts* button (or *Repair* in the overflow
  menu) to pick up the fix. The Python <-> Electron protocol itself is
  unchanged.

### Notes for testers
If you were hitting `FileNotFoundError: 'F:\\'` after installing 0.5.0-dev2:
1. Install this build (0.5.0-dev3).
2. Open **Setup Wizard** → **Install Resolve scripts** to copy the
   patched Python into Resolve's Utility folder.
3. Re-run `export_range` from Resolve's Scripts menu.

---

## [0.5.0-dev2] — 2026-04-23 — **Vault MVP, part B: pipeline + UI + imports**

Phase B lands everything dev1 deferred: the AE handoff (Collect Files),
FFmpeg proxy + thumbnail generation, the full Vault IPC surface, a
standalone Vault window UI, batch "Vault Project", soft-delete/trash, and
Import-to-Resolve / Import-to-AE flows. Together with dev1 this is the
first end-to-end Vault that a tester can drive.

### Added — **AE handoff JSX (`scripts/ae/vault_collect.jsx`)**
Invocation contract matches `create_comp.jsx` / `render_version.jsx`:
Electron writes a vault-job JSON to `%TEMP%/roundtrip_current_vaultjob.txt`
and runs `AfterFX.exe -r vault_collect.jsx`. The JSX:
- Opens the source `.aep`, picks the primary comp (by name hint, else
  longest-duration fallback).
- Runs `reduceProject([primary])` then `collectFiles({collectSource:true})`
  into `<assetDir>/ae/`. Falls back to the legacy positional `collectFiles`
  signature on pre-2018 AE hosts.
- Enumerates **fonts** (every `TextLayer.sourceText.font`, deduped by
  `family|style`) and **plugins** (every effect's `matchName`, flagged
  `builtin:true` if it begins with `"ADBE "`).
- Captures `compSettings` (name, w/h, frameRate, duration, durationFrames,
  pixelAspect) and full AE version info (`app.version`, buildName/Number).
- Walks `targetDir/(Footage)/` recursively, produces a footage list with
  **paths relative to the asset dir** (portability contract held).
- Writes **exactly one sentinel** — `.vault.done.json` or `.vault.error.json`
  — which Electron polls. No code path can silently stall.
- Ships a minimal polyfilled `JSON.stringify` for CS6-era ExtendScript
  hosts that still lack native JSON.

### Added — **`lib/proxy.js` — FFmpeg proxy + thumbnail** (design lock §3)
The exact ffmpeg command from the Session 4 design doc §3:
- **proxy.mp4:** `libx264 -profile main -level 4.0 -pix_fmt yuv420p
  -preset veryfast -crf 28 -g 24 -keyint_min 24 -movflags +faststart -an`,
  `-vf scale=-2:480,fps=24`. Target ~1–3 MB per 10 s at 1080p source.
- **thumb.jpg:** single frame at 50% duration, 640 px wide, q:v 3, with
  `-ss` *before* `-i` for fast seek.
- **Single-slot FIFO queue** — vaulting 5 shots in a row does not saturate
  the CPU. Errors in one job don't poison the chain. `queueDepth()`
  reports pending+running for UI indicators.
- **Test-locked flags:** `buildProxyArgs` + `buildThumbArgs` covered by
  contract tests so any flag change trips CI and must be justified in
  the changelog.
- stderr piped to `<assetDir>/.proxy.log` for encode-failure forensics.

### Added — **`lib/vault_pipeline.js` — orchestration** (VAULT_PIPELINE)
State-free, ctx-parameterized module — main.js supplies electron bits, tests
can mock them.
- **`vaultShot(ctx, {projectDir, projectName, shotName, finalVersion, tags})`**
  mints an assetId, spawns vault_collect.jsx, polls the sentinel, copies the
  master render, kicks off proxy + thumb (queued, async — asset is browsable
  before they land), writes `asset.json`, rebuilds `index.json`. **Failed
  vaults are quarantined to `.trash/<assetId>-failed-<ts>/`** so the UUID
  isn't recycled and forensics survive.
- **`importAssetToResolve(ctx, {...})`** — copies master into
  `<targetProject>/<shotName>/versions/v01/`, writes a minimal `job.json`
  with `vaultedFromAssetId`, runs the existing relink pipeline via
  `ctx.runRelink`. Reuses rc5 Spec Lock modal via `ctx.confirmSpecDrift`
  hook (wired up when main.js surfaces it — UI hook reserved for dev3).
- **`importAssetToAE(ctx, {...})`** — `fs.cpSync` copies the entire `ae/`
  bundle into the target shot's `ae/` folder, writes `job.json`, leaves
  launch to the caller. **Strict plugin check** (design #4) when caller
  provides `ctx.installedPlugins`; lenient font warning via status strip.
- **Copy-not-link** for imports (design decision #4 / Session 4 doc §4):
  the target project survives independently if the vault is later moved
  or the asset deleted.
- **`findMasterInVersion(dir)`** — picks the largest non-preview media
  file in a version directory. Covered by tests.
- **`pollForSentinel(done, error, timeout)`** — exactly-one-fires promise;
  consumes the sentinel after reading. Covered by tests.

### Added — **Vault IPC surface (`main.js` → `ipcMain.handle`)**
All handlers return `{ok, ...}` or `{ok:false, error}`. Full list:
- `vault:getRoot` / `vault:pickRoot` — runtime root switching (not
  wizard-only; testers can change vaults without re-running setup).
- `vault:list` / `vault:read` / `vault:mediaPaths` / `vault:reveal` —
  grid + detail + media surface. `mediaPaths` returns absolute paths so
  the renderer can `file://`-source `<video>`/`<img>`.
- `vault:createFromShot` / `vault:createFromProject` — single-shot and
  batch. Batch iterates shots where `job.vaultMarked === true` and
  processes them **sequentially** (AE isn't re-entrant for Collect Files).
- `vault:delete` / `vault:listTrash` / `vault:restore` / `vault:purgeTrash`
  — soft delete + 7-day retention (design decision #3).
- `vault:importToResolve` / `vault:importToAE` — copy-style imports.
- `vault:rebuildIndex` — debug / recovery from manual vault tampering.
- `vault:verifyPortability` — surfaces any absolute-path offender across
  every `asset.json` (debug-menu candidate for dev3).
- `vault:open` — opens the standalone Vault window.
- `_buildVaultCtx()` — one place that wires AE_EXE, FFMPEG_EXE, vaultRoot,
  chiralVersion, spawnAE, emitStatus, readProjectSpec, and runRelink into
  the ctx shape `lib/vault_pipeline.js` expects. Rebuilt per IPC call so
  wizard edits take effect immediately.

### Added — **`shot:setVaultMarked` IPC + `vaultMarked` in shot:info**
Per-shot boolean flag (design decision on tagging mechanism). Toggled
from the new "Mark for batch vault" overflow entry. AE-side comp markers
(`CHIRAL:VAULT` convention) are a future alternative source that would
flip the same flag — schema does not care which side writes it. Surfaced
in `shot:info` output so the renderer can show a checkmark.

### Added — **Standalone Vault window (`app/vault.html`)**
Minimal but functional — design priority: correctness > polish; hover-play,
filtering, detail drawer iterate on this foundation.
- Grid of asset cards with thumbnail, name, origin project/shot, spec,
  tags, usage count.
- **Hover-play:** `<video>` swapped in on `mouseenter`, swapped back to
  `<img>` on `mouseleave`. Saves CPU on grid-open (no N concurrent
  decoders).
- Per-card actions: Import to Resolve / Import to AE / Reveal / Delete.
- Empty states for "no vault configured" and "vault configured but empty."
- Import dialog (native `<dialog>`) — picks target project, optional
  shot name override.
- Header: current vault path display, Pick / Refresh / Rebuild Index.
- Status strip echoes pipeline results.

### Added — **Overflow-menu entries in main UI** (`app/index.html`)
- **Open Vault…** — launches the standalone window via `vault:open`.
- **Vault this shot** — runs `vault:createFromShot` on current selection.
- **Mark for batch vault** — toggles `job.vaultMarked`.
- **Vault marked shots in project** — runs `vault:createFromProject`.

### Added — **Wizard integration for VaultRoot**
- `wizard:pickVaultRoot` IPC — no `defaultPath` hint (design decision #7
  — no C:\ default trap).
- `wizard:save` now accepts and persists `vaultRoot` field; validates
  writability before saving; empty value leaves prior setting intact
  (users can add a vault after first-run setup).
- `applyConfig()` calls `VAULT.initVault()` + `VAULT.purgeOldTrash()` on
  every config apply; idempotent.
- `preload.js` exposes `wizard.pickVaultRoot(suggested)`.

### Added — **Tests (11 new, 76 total)**
- `test/vault_pipeline.test.js` (8 tests): sentinel polling (done /
  error / timeout), master selection (largest non-preview / preview-only
  dir / missing dir), proxy queue (FIFO ordering / error-isolation /
  queueDepth tracking).
- `test/vault_pipeline.test.js` also includes 3 ffmpeg-arg **contract
  tests** that lock the documented flags — changing libx264/crf/scale/
  movflags/etc. requires updating both the test and this changelog.

### Notes — **What's explicitly NOT in dev2**
- **`ctx.confirmSpecDrift` renderer hook** — lib/vault_pipeline is ready
  to call it on spec mismatch at import time, but main.js doesn't yet
  surface a modal callback; falls through silently in MVP. Dev3 wires
  the rc5 modal in for genuine mismatch UX.
- **AE-side comp-marker vault trigger** (`CHIRAL:VAULT`) — schema is
  ready (`job.vaultMarked` doesn't care where the flip comes from).
- **Tag editing UI** — tags are stored + displayed, not yet editable.
- **Hover-play scrubbing** — current impl auto-plays the full proxy
  muted-looped; frame-accurate scrub-on-hover would need additional work.
- **Vault search/filter UX** — grid is unfiltered; a filter bar is
  a dev3 target once we know what testers need.
- **Rebuild of AE project on import** — we copy the collected bundle;
  we don't re-path expressions or footage references beyond what Collect
  Files already normalized. Most shots work out of the box; complex
  projects may need manual touch-up.

### Files changed
- **NEW:** `scripts/ae/vault_collect.jsx`, `app/lib/proxy.js`,
  `app/lib/vault_pipeline.js`, `app/vault.html`,
  `app/test/vault_pipeline.test.js`.
- **Modified:** `app/main.js` (Vault ctx + 16 IPC handlers, vault window,
  applyConfig init/purge hook, `vaultMarked` in shot:info, new
  `vault_collect` JSX path constant), `app/preload.js` (new `vault.*`
  namespace, `api.setVaultMarked` + `api.openVault`,
  `wizard.pickVaultRoot`), `app/index.html` (4 overflow entries + click
  handlers), `app/package.json` (0.5.0-dev1 → 0.5.0-dev2).

---

## [0.5.0-dev1] — 2026-04-23 — **Vault MVP, part A: foundation (schema + layout)**

Kicks off **Session 4 — The Vault MVP**. This build ships the foundation
only: the on-disk schema, the pure library modules, config plumbing, and
exhaustive tests. **No UI, no AE handoff, no FFmpeg proxy pipeline yet** —
those land in 0.5.0-dev2. Shipping the foundation first means the schema
decisions are locked in tests before any surface code can silently drift
from them.

Design decisions locked by user review before any code was written:

1. Vault trigger: **per-shot AND per-project batch** (both in scope).
2. Dedup of identical masters: **skipped for MVP** (may add later).
3. Asset deletion: **soft delete to `.trash/`** with 7-day retention.
4. Missing-dependency behaviour on import: **fonts lenient, plugins strict**.
5. AE version pinning: **record `origin.aeVersion`; warn on forward-compat
   downgrade at import time**.
6. Auto Spec Lock on vault-import: **yes for MVP** (may revisit if testers hit
   false positives).
7. VaultRoot default: **no default — wizard forces an explicit pick** to
   prevent accidentally filling the system drive.

Tagging model: app-side `job.vaultMarked` checkbox is the primary signal
(toggled from the shot card). AE-side markers (comp marker with
`CHIRAL:VAULT` comment) can be added later as an alternative signal that
flips the same flag — the schema does not care which source stamps it.

### Added — **`lib/asset.js` — pure asset-schema helpers** (VAULT_ASSET_SCHEMA)
- `ASSET_SCHEMA_VERSION = 1`. Additive migrations only (same pattern as
  `lib/manifest.js`).
- `createAsset({name, kind, origin, specAtVault, tags})` — factory that
  stamps defaults: files block with all-null slots, empty `dependencies`
  (footage/fonts/plugins), empty `usage[]`, ISO `vaultedAt` timestamp.
- `validateAsset(a)` — shape-level audit returning `{ok, errors[],
  warnings[]}`. Blocks reads/writes on: non-UUIDv4 `assetId`, empty `name`,
  missing `origin`/`specAtVault`, non-positive width/height/fps, **absolute
  paths anywhere in `files{}`**, `..` in any relative path. Future
  `schemaVersion` values warn but don't reject (forward-compat for
  schema migrations in flight).
- `writeAsset(assetDir, a)` throws with `err.validation` attached if the
  asset is invalid — so a broken manifest never reaches disk.
- `appendUsage(asset, {toProject, toShot, mode, at})` — **append-only**
  usage log. Never mutates prior entries. Unknown `mode` coerced to
  `'copy'` (link mode is deferred — see design note #4 in Session 4 doc).
- `findAbsolutePathFields(obj)` — recursive walk that flags any string
  matching `C:\\` / `\\\\` / `path.isAbsolute`. Used by the portability
  audit (below) and reserved for a future "Verify Vault Portability"
  debug command.
- `isValidAssetId(s)` — strict RFC 4122 v4 shape check. We generate our
  own IDs, so a non-v4 is always a bug or hand-edit.

### Added — **`lib/vault.js` — VaultRoot lifecycle + index + trash** (VAULT_LAYOUT)
- On-disk layout:
  ```
  <VaultRoot>/
  ├── vault.json           # { schemaVersion, createdAt, chiralVersion }
  ├── index.json           # denormalized cache, rebuildable
  ├── assets/<uuid>/…      # one asset per dir (ground truth)
  ├── .trash/<uuid>-<ts>/  # soft-delete quarantine (7d retention)
  └── .locks/              # reserved for per-asset write locks
  ```
- `isVaultRoot(p)` — cheap marker-only probe; does not walk `assets/`.
- `initVault(p, {chiralVersion})` — **idempotent**; running on an existing
  vault heals missing subdirs but **never overwrites the marker's
  `createdAt`/`chiralVersion`**. Safe to call on every app start.
- `rebuildIndex(vaultRoot)` — walks `assets/`, parses each `asset.json`,
  validates it, and writes `index.json` as the projection the Vault UI
  grid will read. **Losing index.json never loses data** — the rebuild
  is O(n) manifest reads. Skips + reports: manifest missing/unparseable,
  validation failure, **folder name ≠ assetId** (defensive against manual
  rename).
- `projectAsset(a)` — the projection shape: `{assetId, name, kind, tags,
  thumbnailRel, masterRel, proxyRel, specAtVault, originProject,
  originShot, vaultedAt, usageCount}`. Designed to feed the grid +
  search + hover-play without ever re-opening asset.json.
- `trashAsset(vaultRoot, assetId)` — soft delete. Atomic rename into
  `.trash/<assetId>-<ISO-ts>/`. Timestamp suffix means multiple
  delete/restore cycles of the same id don't collide.
- `restoreAsset(vaultRoot, trashEntryName)` — reverse rename. Refuses if a
  live asset with the same id already exists in `assets/` (the "re-vault
  after delete" case — user must explicitly resolve).
- `listTrash(vaultRoot)` / `purgeOldTrash(vaultRoot, retentionDays=7)` —
  enumerate + auto-purge. Safe to call on startup.
- `verifyPortability(vaultRoot)` — walks every `asset.json`, runs
  `findAbsolutePathFields` on each. Returns `{ok, checked, offenders[]}`.
  Surfaces assets that would break if the vault is moved to a different
  drive. Reserved for a debug menu item and future CI.

### Changed — **`lib/config.js`: `vaultRoot` field added** (default `null`)
- New user-configurable path alongside `roundtripRoot`, `afterEffectsPath`,
  `ffmpegPath`. **Intentionally null** — the wizard (0.5.0-dev2) will
  force an explicit pick. Empty state in the Vault UI when unset.

### Added — **Tests (31 new, 65 total)**
- `test/asset.test.js` (14 tests): UUID shape, validation (valid path,
  absolute-path rejection, `..` rejection, bad dimensions, future
  schemaVersion → warn), factory defaults, read/write roundtrip, invalid-
  write throws, missing-dir readAsset returns null, usage log append-
  only + mode coercion, `findAbsolutePathFields` hits + clean cases.
- `test/vault.test.js` (17 tests): init creates layout + marker,
  idempotent second-init, non-vault detection, `rebuildIndex` happy
  path + folder-name mismatch + missing-manifest skip + empty-vault
  safe, trash + restore + list + retention purge + fresh-entries-
  preserved, portability audit clean + dirty.

### Notes — **What's explicitly NOT in dev1**
- No AE JSX (`vault_collect.jsx`) — Phase B of the vaulting pipeline.
- No FFmpeg proxy orchestration — proxy.mp4 + thumb.jpg generation.
- No IPC handlers (`vault:list`, `vault:create`, `vault:delete`,
  `vault:import`) — handler surface lands with the UI.
- No renderer UI — Vault tab, grid, hover-play, import modals.
- No wizard step for VaultRoot picking.
- No `job.vaultMarked` flag wiring in the shot card.
- No Spec-Lock-at-import reuse of rc5 machinery.

These are all scheduled for 0.5.0-dev2. Foundation-first means the
schema is carved in tests before any consumer can accidentally lock in
a wrong assumption.

### Files changed
- **NEW:** `app/lib/asset.js`, `app/lib/vault.js`,
  `app/test/asset.test.js`, `app/test/vault.test.js`.
- **Modified:** `app/lib/config.js` (+`vaultRoot: null` default),
  `app/package.json` (0.4.9-rc5 → 0.5.0-dev1).

---

## [0.4.9-rc5] — 2026-04-23 — **Spec Lock: first user-visible feature of v0.4.9**

The foundation laid in rc2 + rc3 + rc4 finally lands as something testers
can see. On the first export from a project, Resolve stamps the timeline's
`{fps, width, height}` into `project.json.lockedSpec`. On every subsequent
export, those three values are compared; if they drift, the tester is given
a soft-confirm dialog in Resolve (Cancel / Proceed) and — if they proceed
— a red badge appears in the app header that drives a resolution modal.

### Added — **Soft spec-mismatch confirmation in Resolve**
- `export_range.py` `_handle_spec_lock` was rewritten from hard-abort to
  a three-branch flow: no lock → stamp silently; match → proceed silently;
  mismatch → pop `ask_user_confirm` dialog. Cancel aborts with no side
  effects; OK writes `.spec_mismatch.json` with `userAcknowledged: true`
  and lets the export continue. Rationale: legitimate workflows (different-
  fps inserts, reference footage at native rate) shouldn't have to fight
  the lock — the red badge in the app is where drifts get resolved
  properly.
- **Acknowledgement short-circuit**: if a sidecar already records the exact
  current drift AND has `userAcknowledged: true`, the Resolve dialog is
  skipped and the export proceeds silently. So exporting five shots at a
  different fps doesn't nag the user five times; the red badge alone is
  the reminder. Re-prompts trigger only when the drift *changes* (e.g.
  fps moves from 29.97 to 24).
- New `ask_user_confirm(title, msg) -> bool` helper: Fusion `AskUser`
  (OK/Cancel buttons built-in) with a tkinter `askokcancel` fallback for
  any environment where Fusion isn't reachable. Fails closed — if no GUI
  is available, returns False rather than silently proceeding.

### Added — **Spec Lock IPC: `project:applyNewSpec` + `project:clearMismatch`**
- `project:applyNewSpec(projName)` — promotes `.spec_mismatch.json`'s
  `currentSpec` into `project.json.lockedSpec`, wipes the sidecar. Equivalent
  to "unlock + next export re-locks" but skips the Resolve round-trip.
  Updates `lockedAt` and `lockedBy` (from `attemptedShot`).
- `project:clearMismatch(projName)` — drops the sidecar without touching
  the lock. For "I'll fix it in the timeline myself, just stop nagging me"
  cases. Next mismatched export will prompt again.
- Both are validated for missing-project / missing-sidecar / malformed-
  sidecar and return `{ok:false, error}` rather than throwing.

### Changed — **`dialog:confirm` now honors caller-supplied buttons**
- Pre-rc5 the handler hardcoded `['OK', 'Cancel']` and ignored the
  renderer's `buttons` array — an existing silent bug. Now the handler
  respects `buttons`, `defaultId`, `cancelId`, and `type` when provided,
  and returns `{ok, confirmed, chosenIndex, chosenLabel}`. Legacy 2-button
  callers are unchanged (`confirmed` still works). The Spec Mismatch modal
  uses the new `chosenIndex` to branch between Accept / Keep / Cancel.

### Changed — **Renderer: 3-way mismatch modal**
- `promptUnlockSpec` in `index.html` now branches on mismatch state:
  * Locked, no mismatch → old 2-button Unlock / Cancel (unchanged).
  * Locked + mismatch   → new 3-button modal with per-field diff:
      - "Accept new spec"   → calls `applyNewProjectSpec`
      - "Keep locked spec"  → calls `clearSpecMismatch`
      - "Cancel"            → no-op
  * `_refreshBadgeSoon()` helper forces a badge repaint after any action
    so the user sees state flip without waiting for the 3s rail tick.

### Added — **`lib/spec.js` shared helpers**
- `specsMatch(a, b)` — tolerant fps comparison (ε=0.01), exact width/height.
- `diffSpecs(locked, current)` — returns `[{field, locked, current}, …]`.
- `formatSpec(s)` — one-line `"1920×1080 · 23.976"` for the badge.
- `HARD_FIELDS` + `FPS_EPSILON` constants, matched 1:1 to `export_range.py`
  :: `_compare_specs`. Grep anchor **SPEC_LOCK_CONTRACT** — change both
  files in the same commit or the badge will flip-flop.

### Added — **Tests**
- `test/spec.test.js` — 13 new pure-function tests:
  * `specsMatch`: identity, epsilon-fps, width/height exact, null safety.
  * `diffSpecs`: match → empty, single-field, all-three (HARD_FIELDS order),
    epsilon suppression.
  * `formatSpec`: standard shape, fps rounding, missing-field fallback.
  * Constants-contract guard so renaming `HARD_FIELDS` breaks CI.
- Total suite: 34/34 passing.

### Changed — **`chiral_version.py` bumped to `0.4.9-rc5`**
- Because `export_range.py` behavior changed (dialog text, sidecar shape
  with `userAcknowledged` field). Electron's `checkScriptsVersion()` will
  nudge testers with old Resolve scripts to run Repair; `syncResolveScripts`
  on every launch covers most cases silently.

### Known gaps (intentionally out of scope)
- No per-shot spec overrides — a project is locked as a whole.
- No "retroactive relock without a Resolve mismatch event" UI.
- `colorScienceMode` is captured in `_build_timeline_spec` but still not
  enforced. Surfacing it as a soft drift indicator is Session 4 or later.
- Vault integration hasn't started — Spec Lock is standalone for now.

### Notes
- Sidecar shape evolved: `currentSpec` and `attemptedShot` are now always
  written by rc5 Python. Pre-rc5 sidecars (rare — only on machines that
  ran rc1 Python but never export_range again) are still readable by the
  app; missing `attemptedShot` falls back to the old `lockedBy` value.
- No schema version bumps to `project.json` — the field set is the same as
  rc2. Adding optional fields without a version bump is fine under the
  "additive = no migration" rule documented in `lib/manifest.js`.

---

## [0.4.9-rc4] — 2026-04-21 — **Hotfix: Python version gate + loud relink failures**

Targeted hotfix for a tester-reproducible silent relink failure. Export to
Resolve succeeded; render in AE succeeded; clicking "send to Resolve"
produced no clip on V2 and no error on screen. Root cause was a combination
of (a) the spawn resolving to the tester's system Python **3.14**, which is
outside the Resolve external scripting ABI's tested range, and (b) the
relink using `pythonw.exe` (windowless), which swallows unhandled
tracebacks — so the script crashed on `scriptapp("Resolve")` and left the
log file truncated at the line immediately before.

### Fixed
- **Python 3.10–3.13 is now enforced** for the Resolve relink path. Out-of-
  range interpreters are detected at startup; the relink dispatch refuses
  to spawn and emits a precise status-strip error: `"Relink blocked —
  Python 3.14.0 is not supported. Install Python 3.10 – 3.13 (3.12
  recommended) and click Repair."` No more silent no-ops.
- **Relink stderr is now captured to `<shotDir>/.relink.stderr.log`**.
  Future silent crashes in the Python layer leave an on-disk traceback
  instead of vanishing. File is overwritten on each spawn so it always
  reflects the most recent attempt.
- **Relink spawn now uses `python.exe` (console variant), not `pythonw.exe`**.
  Both are hidden via Windows `CREATE_NO_WINDOW` (no console flash), but
  only the console variant writes crash tracebacks to stderr. `export_range`
  and other in-Resolve scripts are unaffected — they run under Resolve's
  own bundled `fuscript.exe`.

### Changed — **`lib/detect.js` — `detectPython()`**
- Priority flipped: **bundled `vendor/python/python.exe` now wins over system
  Python** when it's present and in-range. Known-good shipped runtime beats
  whatever happens to be first on the tester's `PATH`. Falls back to
  system `py`/`python`/`python3` if bundled is absent.
- Returns `{path, source, version, inRange, tried[]}`. `version` is
  `{major, minor, patch, full}` parsed from `--version`; `tried` lists
  every candidate probed for diagnostic logging.
- Out-of-range-but-runnable returns are preserved (with `inRange: false`)
  so callers can produce precise errors instead of ambiguous "missing".
- New exports: `SUPPORTED_PYTHON`, `parsePythonVersionString`,
  `isPythonInSupportedRange` (pure functions, fully tested).

### Changed — **`lib/spawn.js` — `runRelink()`**
- Accepts `ctx.PYTHON_EXE` (preferred); legacy `ctx.PYTHON_EXE_NOCONSOLE`
  still works but logs a deprecation warning.
- `stdio` is now `['ignore', 'ignore', <stderrFd>]` with stderr opened to
  `<shotDir>/.relink.stderr.log` (truncating). Parent closes its fd after
  spawn; child keeps the inherited copy.

### Changed — **`main.js` startup**
- Tracks `PYTHON_VERSION` and `PYTHON_INRANGE` module-level. Logs both to
  the main-process console at launch. A status-strip error fires from
  `checkRuntimeFallbacks()` when Python is found but out of range, so the
  user sees the problem before clicking Send-to-Resolve.
- `runRelinkAndAwait` and `runForceRelinkAndAwait` both gate on
  `_assertPythonUsable()` before spawning. Out-of-range returns
  `{dispatched: false, reason: 'python-out-of-range'}`; the per-shot
  in-flight lock is NOT taken, so a later Repair-install of a supported
  Python unblocks the shot immediately.

### Added — **Tests**
- `test/python_version.test.js` — 4 pure-function tests for the parser
  and range check. Covers typical `--version` outputs (3.10.11, 3.12.0,
  3.14.0rc1), garbage input, boundary minors (9/10/13/14), and a realistic
  parse-then-check flow. Total suite: 21/21 passing.

### Known remaining work (not in this hotfix)
- Bundled `vendor/python/` and `vendor/ffmpeg/` aren't yet populated in
  the repo — the installer will ship without them until that's done. The
  detect fallback still works, but installs without a global Python 3.12
  will still fail loudly (as intended) until vendor is filled.
- Setup Wizard's Repair button should prompt for Python 3.12 install if
  detection returned an out-of-range hit. Queued for Session 3.

### Notes
- `chiral_version.py` stays at **0.4.9-rc1** — no Python script changes.
  Bumping it would fire the Resolve-scripts-out-of-date nudge on every
  machine even though the scripts are unchanged.
- No schema version bumps. No disk format changes. Safe to install over
  any 0.4.8+ build.

---

## [0.4.9-rc3] — 2026-04-21 — **Stability: Memoization + Audits**

Session 2 of the pre-Vault hardening pass. Still tester-invisible — no UI
changes, no disk-format changes. Tightens the hot paths the v0.4.9 Spec
Lock + Vault work will sit on top of, so the rail tick stays cheap as the
project tree grows.

### Added — **`lib/memoize.js`**
- New `memoizeByMtime(fn, getStatPath)` helper. Caches results keyed on the
  backing file's mtime; one `fs.statSync` replaces a full `readFileSync +
  JSON.parse` on the cache-hit path. No LRU, no TTL — the working set is
  bounded by "shots on disk" so a plain `Map` is right-sized.
- 4 new tests in `test/memoize.test.js` (total suite now 17/17 passing).

### Changed — **Hot paths memoized**
- `project:allSummary` and `project:shotsSummary` IPC handlers now use a
  `readJobMemo` wrapper around `readJob`. Before: 10 projects × 20 shots =
  200 JSON parses every 3s rail tick. After: 200 stats + parse only on
  mtime change. Atomic writes (tmp+fsync+rename) always bump mtime, so
  `withJob`/`atomicWriteJSON` invalidate the cache automatically.
- `emitStatus` now enforces a frozen `STATUS_KINDS` allow-list
  (`info | busy | ok | error`). Unknown kinds are coerced to `info` with a
  dev-console warning — stops a rogue call site from painting an undefined
  colour class in the status strip.

### Fixed
- `lib/config.js` `writeConfig` now uses `atomicWriteJSON` (tmp+fsync+
  rename) instead of a naïve `fs.writeFileSync`. Matches every other JSON
  writer in the app; prevents a half-written `config.json` if the process
  is killed mid-save. Last non-atomic JSON writer in the tree — audit
  clean as of this release.

### Internal
- Audit: `computeSanity` call sites catalogued (3 in `main.js`: lines ~356,
  382, 411). Memoized at the readJob layer rather than inside sanity
  itself — readJob is where the parse cost lives; sanity is four
  `existsSync` calls and not worth wrapping.
- Audit: all `fs.writeFileSync` sites reviewed. `spawn.js:174` (pointer
  file) and `detect.js:147` (writability probe, deleted immediately) kept
  as-is; neither is a JSON payload.
- Audit: `emitStatus` kinds in use = exactly {info, busy, ok, error}. No
  legacy 'warn' or 'success' callers found.

### Notes
- `chiral_version.py` stays at **0.4.9-rc1** — no Python script changes;
  bumping it would fire the repair nudge for no reason.
- No schema version bumps. No migrations needed. This release is pure
  wire-internal; existing `config.json`/`settings.json`/`project.json`
  files read and write unchanged.

---

## [0.4.9-rc2] — 2026-04-21 — **Foundation: Manifest + Migrations**

Invisible to the tester; purely Electron-side refactor. Lays the schema
groundwork the Vault's `asset.json` will stand on.

### Added — **`lib/manifest.js`**
- New canonical read/write/migrate layer for every versioned JSON file
  that isn't `job.json` (settings, project, future asset). API:
  `readManifest(path, {defaultValue, targetVersion, migrations,
  createIfAbsent})`, `writeManifest(path, obj, {targetVersion})`,
  `withManifest(path, opts, mutator)` — mirror of `withJob()` for
  trusted main-process code.
- Never throws across the bridge: missing file, permission failure,
  malformed JSON, top-level array all return a **deep-cloned**
  `defaultValue` so caller mutation can't poison the next read.
- Schema migrations are indexed by "version we're climbing FROM"
  (`migrations[0]` runs v0 → v1, etc.). Post-migration flush is atomic
  via the existing `atomicWriteJSON` primitive.

### Changed
- `main.js::readSettings` / `writeSettings` / `readProjectManifest` /
  `readSpecMismatch` / `project:unlockSpec` all routed through
  `lib/manifest.js`. Legacy unversioned `settings.json` and
  `project.json` files get stamped with `schemaVersion: 1` on first
  read (no-op migration today; slot is reserved so future reshapes
  drop in cleanly).

### Added — **First smoke-test harness**
- `app/test/manifest.test.js` covers 13 cases: missing-file default,
  deep-clone invariance, createIfAbsent seeding, malformed JSON,
  array-top-level rejection, schemaVersion stamping, caller-override
  preservation, migration chain ordering, already-current skip,
  migration gap, `withManifest` commit / no-commit, plus smoke on
  `sanitizeName`, `resolveJobFormat`, `resolveJobScale`.
- Run with `npm test`. Uses `node:test` + `node:assert/strict` — zero
  new deps.

### Notes
- `chiral_version.py` unchanged (Python scripts not touched this
  session) — stays at `0.4.9-rc1`. Repair nudge still fires against
  the rc1 bump for anyone upgrading from 0.4.8.

---

## [0.4.9-rc1] — 2026-04-21 — **Technical Spec Lock**

First half of the 0.4.9 release train. Small, defensive, preventative —
ships ahead of the Vault MVP so the tester can soak it while the asset
library work lands.

### Added — **Project spec lock**
- `export_range.py` snapshots the Resolve timeline's `{fps, width, height,
  colorScienceMode}` on a project's FIRST shot export and writes it as
  `lockedSpec` into a new `<projectDir>/project.json` manifest. Every
  subsequent export compares the open timeline against that lock; a hard
  mismatch on fps/width/height **aborts before the render queue is
  touched**, writes `<projectDir>/.spec_mismatch.json` with the diff, and
  pops a Resolve dialog naming the mismatch. `colorScienceMode` is
  recorded but not enforced across the AE round-trip — flagged for a
  future version once AE color-management behaviour is pinned down.
- Kills a whole class of silent-corruption bugs where an artist
  accidentally switched timeline fps or resolution mid-project and every
  subsequent render came back at the wrong cadence.
- fps comparison uses a 0.01 epsilon so `GetSetting("timelineFrameRate")`
  returning `23.976000000001` on some Resolve 20.x builds doesn't trip a
  false mismatch.

### Added — **Spec Lock header badge + unlock flow**
- New pill in the shot header (between the crumb and the shot label):
  - Hidden when the project has no lock yet.
  - **Green** `🔒 24fps · 1920×1080` when locked and the open timeline
    matches.
  - **Red + pulsing** `⚠ fps: 24 ≠ 23.976` when `.spec_mismatch.json`
    is present. Hover shows the full diff; click opens a native confirm
    dialog listing the mismatch and explaining that unlocking lets the
    next export set a new lock.
- New IPCs `project:getSpec` / `project:unlockSpec` (wired via preload
  as `window.api.getProjectSpec` / `unlockProjectSpec`). Badge repaint
  piggybacks on the existing 3s refresh tick; a signature cache keeps
  the CSS pulse animation smooth between ticks.
- Unlocking is deliberately an explicit UI action, not a `--force`
  flag — the decision is visible, auditable, and requires the same
  native dialog the v0.4.8 delete flow uses (so it can't be
  click-through suppressed).

### Notes
- `project.json` is a new on-disk artefact. Absent file = unlocked
  project; first export auto-creates it with `schemaVersion: 1` so
  future project-level state (Vault refs, render stats, etc.) can be
  added without a migration.
- `chiral_version.py` → `0.4.9-rc1` to trigger the Repair nudge on
  first launch (export_range.py gained the spec-lock pre-flight).

---

## [0.4.8] — 2026-04-20 — **The Stability Update**

### Fixed — **Context-menu data-loss bug (CRITICAL)**
- Right-clicking a shot row in the Project Overview Rail could surface
  the **"Delete project"** menu instead of the shot menu. Root cause:
  the `.rail-proj` wrapper contained both the project header and the
  shot `<li>` list, so `e.target.closest('.rail-proj')` matched on
  every shot-row click and the project-level ctx-menu was opened.
  Users who hit "Delete project" thinking they were deleting a single
  shot lost the entire project's work.
- The rail-scroll `contextmenu` handler now checks
  `e.target.closest('li[data-shot]')` **first**; only if that returns
  null does it fall back to `.rail-proj-head` (the explicit clickable
  header strip). The project-destructive menu is unreachable from a
  shot-list click — no bubble-up is possible.
- Destructive actions (Delete shot, Delete project) now route through
  a single `confirmAndDelete()` helper that calls
  `path:deletePreview` and shows the **absolute path** that will be
  removed, plus a red `⚠ N .aep file(s) will be permanently deleted`
  warning when AE projects are present. Replaces the legacy
  `window.confirm()` (which Chromium sometimes blocks) with a native
  `dialog.showMessageBox` that can't be suppressed.
- `shot:delete` IPC now accepts either a string (current project,
  named shot) or `{project, shot}` so rail-clicked shots in another
  project delete against the correct root instead of silently
  targeting the currently-selected project.

### Added — **Last-used render settings persist to new shots**
- `settings.json` now stores `lastRenderFormat`, `lastRenderQuality`,
  `lastRenderScale`. Every change to the Codec/Quality/Scale controls
  writes through, and `shot:info` lazy-seeds these onto freshly
  created shots that don't have them yet.
- Fixes a slider regression: switching format → MP4 used to collapse
  the scale slider to 50% because the `renderQuality === 'superfast'`
  fallback branch in `resolveJobScale` kicked in while `renderScale`
  was undefined. `setRenderFormat` now always writes an explicit
  `renderScale` (falling back to `lastRenderScale || 1.0`).

### Added — **UI NAME overrides Shot_XXX + Motion bin**
- Typing into the NAME field writes a `pendingShotName` into
  `%APPDATA%/Roundtrip/config.json`; the next `export_range.py` run
  consumes it, sanitises via `re.sub(r"[^A-Za-z0-9._-]+", "_", raw)`
  and clips to 64 chars, then uses it as the shot's folder name
  (with `foo`, `foo_2`, `foo_3` collision fallback). Falls back to
  `Shot_NNN` when empty.
- `relink_latest_render.py` imports first-render references into the
  Media Pool folder `Motion/<name>`, creating both folders as needed
  via `AddSubFolder`. Subsequent renders still `ReplaceClip` against
  the existing MediaPoolItem, so the bin structure is built once and
  reused.

### Added — **Force Relink (reconnect)**
- New overflow-menu button **↻ Force relink (reconnect)** and matching
  `shot:forceRelink` IPC. Fires `relink_latest_render.py
  --force-reconnect`, which calls
  `mpi.ReplaceClip(os.path.abspath(render_path))` on the existing
  Media Pool item. Recovers from "Media Offline" after drive-letter
  changes or project moves without requiring a re-import.
- Distinct status-strip states: *"Force-relinking…"*,
  *"Force-relink OK"*, *"Force-relink failed"*, so the artist can
  tell the one-shot reconnect apart from a full auto-relink.

### Added — **Alt-Tab animation pause + window defaults**
- `window:blur`/`window:focus` IPC toggles `body.app-blurred`; a
  single CSS rule (`.app-blurred *`) zeroes `animation-duration` and
  `transition-duration` while the window is unfocused. Saves CPU when
  the artist is working in AE/Resolve.
- Default window size is now **1280×800** (was 1100×720),
  `minWidth=960`, `minHeight=560`, so the rail + main pane fit
  comfortably on first launch.

### Changed
- `chiral_version.py` → `0.4.8` to trigger the Repair nudge on first
  launch (scripts changed: `pendingShotName` consumer added to
  `export_range.py`, `--force-reconnect` flag added to
  `relink_latest_render.py`).

---

## [0.4.7] — 2026-04-19

### Fixed — **Double relink = double clip on the timeline**
- A tester on Resolve 20.2.2.10 saw a freshly-rendered shot land on the
  timeline **twice** after clicking "Send to Resolve" while the
  post-render auto-relink was still in flight. The `relink.log` showed
  two concurrent Python processes (different PyRemoteObject memory
  addresses), each calling `AppendToTimeline` for the same render. The
  second process's `SetClipColor` hit a stale handle
  (`returned False on one item`), which is the tell.
- Added a **per-shot in-flight lock** in `lib/spawn.js`
  (`_relinkInFlight` Map keyed by absolute shot dir). Second+ callers
  short-circuit with a `{ dispatched: false, reason: 'already-in-flight' }`
  return. Lock is released in `waitForRelinkResult`'s `finally` on both
  success and timeout so a wedged Python process never holds it forever.
- `main.js:runRelinkAndAwait` now checks `SP.isRelinkInFlight()`
  **before** spawning and emits a user-visible
  *"Already relinking this shot in Resolve — please wait…"* on the
  status strip. Previously the second click was a silent no-op, which
  felt like the button was broken and encouraged more clicking.

### Notes
- Python-side relink script is unchanged; `chiral_version.py` stays at
  `0.4.6`. The bug was 100% in how Electron dispatched the spawn, not
  in what the Resolve scripts did once dispatched.

---

## [0.4.6] — 2026-04-19

### Fixed — **Single-frame render bug on Resolve 20.2.2.10**
- `export_range.py` now sends **absolute** timeline frames to
  `SetRenderSettings` (previously sent timeline-relative). Tester on
  Resolve 20.2.2.10 shipped a log showing payload `MarkIn=561 MarkOut=662`
  silently clamped to `MarkIn=86400 MarkOut=86400` in the queued job (the
  timeline started at 86400) — a single-frame render instead of the 102
  frames the user marked. Resolve's API contract for this field
  diverged between 20.x builds; absolute frames are the portable form.
- Added physical `timeline.SetMarkIn()` / `SetMarkOut()` calls with the
  same absolute values so the UI-side range state always matches the
  render payload. Belt-and-braces — some builds honor one path, some the
  other, setting both is harmless.
- Added explicit `"SelectAllFrames": False` back to the render settings
  dict to prevent the preset's own range behavior from overriding ours.

### Added
- **`[range-check]` log line** after `AddRenderJob` — compares the
  queued job's effective MarkIn/MarkOut against the requested values and
  logs `OK` or `MISMATCH` loudly. This is the canonical smoking-gun
  diagnostic for any future range divergence across Resolve builds.

### Changed
- Bumped `SCRIPT_VERSION` to `0.4.6` so the in-app "script version
  marker" check fires on tester machines and nudges **Repair
  installation** to redeploy the fixed scripts.

### Docblock
- Rewrote the frame-space contract comment at the top of
  `export_range.py` to reflect the 20.2.2.10 finding — the prior claim
  that `SetRenderSettings` expects timeline-relative frames was correct
  for one build we tested against and wrong for this one.

---

## [0.4.5] — 2026-04-19

### Added
- **Python compatibility audit.** Every Resolve-side script now declares
  its supported interpreter range (3.10 – 3.13) and self-checks at startup.
  Out-of-range interpreters log a loud warning instead of failing silently
  inside Resolve's `fusionscript.dll` import path. Documented the Python
  3.12 caveat affecting some Resolve 20.x builds.
- `scripts/resolve/chiral_version.py` — single source of truth for the
  Resolve-script version. Read at startup by the Electron app to detect
  stale installs in the user's Resolve `Utility/` folder.
- **Vendor / PATH runtime check.** On startup the app verifies it can find
  Python and ffmpeg in either `vendor/` or the system PATH; surfaces a
  status-strip warning when both fail (per binary, with separate copy).
- **Script version marker check.** When the bundled `chiral_version.py`
  diverges from the copy installed in Resolve, the status strip nudges
  the user to run **Repair installation**.
- `README.md`, `LICENSE` (MIT), `.gitignore`, this `CHANGELOG.md`.

### Changed
- `_parse_timecode_to_frame` in `export_range.py` now tolerates drop-frame
  timecode separators (`;`) and normalises before parsing. Prevents
  `ValueError` under Python 3.10+'s stricter `int()` coercion.
- Late `import re` in `export_range.py` lifted to the top of the file.
- All user-facing dialogs in the Resolve scripts now read **"Chiral
  Network"** instead of **"Roundtrip"**.

### Fixed
- Drop-frame timecodes (`HH:MM:SS;FF`) no longer raise during parse.

---

## [0.4.4] — 2026-04-19

### Changed — **Roundtrip → Chiral Network rename**
- App `productName`, `appId`, window title, `<h1>`, and rail wordmark all
  switched to **Chiral Network**. Internal config keys and on-disk paths
  (`%APPDATA%/Roundtrip/`, `roundtripRoot`, `roundtrip_*` pointer files)
  intentionally **preserved** — upgrading from 0.4.3 keeps every existing
  setting and project intact.

### Added — Visual identity (the IDE feel)
- Centralised CSS palette: `--bg-sunken/base/surface/raised/hover`,
  `--border-soft/mute/firm`, `--accent` (Chiral Blue `#6aa3ff`), semantic
  `--ok/warn/err/gold`. Inline hex purged across the stylesheet.
- Typography stack — Segoe UI Variable for prose, JetBrains Mono /
  Cascadia Code / Consolas for IDs (`vNN`, `Shot_001`, file paths).
- 4 px spacing rhythm via `--sp-1` … `--sp-6`.
- **Origin badges** — `RV` (Resolve-first) / `AE` (AE-first) inline pills
  in the rail, breadcrumb, and version cards.
- **Hover-Peek** — collapsed rail expands to 240 px as an absolute overlay
  on hover (300 ms intent), without reflowing the main content.
- **Alt+↑ / Alt+↓** — jump between projects, auto-selecting the first
  shot of the destination.
- **Clickable breadcrumb** — the project segment of the shot header
  switches to that project and scrolls the rail row into view.
- Soft empty state — friendlier "Welcome" copy, accent pill, paired card
  for the workflow steps.

### Fixed
- Context-menu truncation on long shot/project names — capped at 360 px,
  ctx-header now wraps instead of clipping.

---

## [0.4.3] — 2026-04-19

### Added — **EXECUTION PHASE 1 (8 audit items)**
- `lib/job.js`: `atomicWrite`, `atomicWriteJSON`, `withJob(dir, mutator)` —
  centralised read-modify-write with tmp + fsync + rename. Applied to
  `job.json`, `settings.json`, `renderjob.json`, `.relink.json`,
  `.render-progress.json`.
- `lib/projects.js`, `lib/spawn.js` — split out of `main.js` (2,394 lines
  → ~770 in `main.js`, ~285 in `spawn.js`, ~250 in `job.js`, ~120 in
  `projects.js`).
- **Stage-dir transactions.** New shots build in `<projDir>/.tmp_<shot>/`
  and atomically rename on success. Failed AE handoffs leave nothing
  half-built.
- **`.relink.json` round-trip.** Detached Resolve Python now writes a
  result file in the shot dir; Electron polls it for ~6 s. Status strip
  now reads `Relinked vXX in Resolve` / `Relink failed: <error>` / `no
  completion signal from Resolve`.
- **`.render-progress.json` polling.** AE JSX writes stage transitions
  (preparing → rendering → complete/error) with frame counts. Status
  strip shows `Rendering vXX · Ns elapsed (AE)`.
- **Keep-only-final guards.** `shot:keepOnlyFinal` now refuses if the
  selected version has no master and auto-relinks if the active was
  deleted.

### Changed
- Replaced all 13 `alert()` calls with `setStatus`/`reportError`/`dialog:confirm`.
- Purged dead state (`lastShotKey`, `lastShotListKey`, `lastProjectKey`,
  `lastProjectListKey`, `rebuildSimpleSelect`).

---

## [0.4.2] — 2026-04-17

### Added
- Project Overview Rail (vertical IDE-style sidebar): per-project sanity
  aggregation, accordion of projects → shots, persisted open/collapsed
  state, hamburger toggle.
- Shot Jump Palette (`Ctrl+Space`): VS Code-style fuzzy launcher for the
  current project's shots.
- Slim breadcrumb header replaced the legacy `<select>`-based shot row.
- Persistent status strip along the bottom edge with `kind-info/busy/ok/error`
  styling.
- Inline shot-label editing (double-click breadcrumb).

---

## [0.4.1] and earlier — Roundtrip MVP

Pre-rename history. The MVP delivered the core Resolve→AE→Resolve loop:
`export_range.py` → AE comp creation → versioned renders → `relink_latest_render.py`.
The architecture established here (pointer files for IPC, sentinel-file
JSX dispatch, `-r` against an already-running AE, MediaPoolItem unique-ID
binding) survives unchanged into Chiral Network.

---

## Disk-format compatibility

Chiral Network reads and writes the same on-disk shape as Roundtrip:

```
projects/
  <project>/
    <shot>/
      source/
        job.json
        reference.mp4
      ae/
        <shot>.aep
      renders/
        v01/<master>.mov
        v02/<master>.mov
        ...
      .relink.json         ← runtime, not committed
      .render-progress.json ← runtime, not committed
```

Settings live under `%APPDATA%/Roundtrip/` (path preserved for in-place
upgrade). Logs land in `%APPDATA%/Roundtrip/logs/`. A 0.4.x install can
upgrade to 0.5.x without re-running the wizard.
