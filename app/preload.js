const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    info:       () => ipcRenderer.invoke('shot:info'),

    // Project lifecycle
    listProjects:   () => ipcRenderer.invoke('project:list'),
    selectProject:  (n) => ipcRenderer.invoke('project:select', n),
    createProject:  (n) => ipcRenderer.invoke('project:create', n),
    deleteProject:  (n) => ipcRenderer.invoke('project:delete', n),
    // Lightweight per-shot summary for the Ctrl+Space Shot Jump Palette
    // and the Project Overview Rail (sidebar):
    // [{name, label, sanity:{level, reasons}}]. Fetched on palette open,
    // not polled — stays off the 3s hot path.
    shotsSummary:   () => ipcRenderer.invoke('project:shotsSummary'),
    // dev38 — per-project overview. Heavier than shotsSummary (walks
    // renders/ and sums sizes) so only called on overview-page open.
    projectOverview: (project) => ipcRenderer.invoke('project:overview', project),
    // All projects with nested shots for the vertical rail accordion.
    // Returns [{name, shots:[{name, label, sanity}], sanity:{level}}].
    // One IPC covers the whole sidebar tree.
    allSummary:     () => ipcRenderer.invoke('project:allSummary'),

    // v0.4.9 — Spec Lock. getProjectSpec returns {locked, lockedAt, mismatch}
    // for the header badge; unlockProjectSpec clears the lock and the
    // sidecar mismatch file. Renderer owns the confirm dialog.
    getProjectSpec:    (name) => ipcRenderer.invoke('project:getSpec', name),
    unlockProjectSpec: (name) => ipcRenderer.invoke('project:unlockSpec', name),
    // v0.4.9-rc5 — mismatch modal actions. applyNewSpec promotes the
    // sidecar's currentSpec into project.json (Accept path); clearMismatch
    // drops the sidecar without touching the lock (Keep path).
    applyNewProjectSpec: (name) => ipcRenderer.invoke('project:applyNewSpec', name),
    clearSpecMismatch:   (name) => ipcRenderer.invoke('project:clearMismatch', name),

    // Shot lifecycle
    selectShot: (name) => ipcRenderer.invoke('shot:select', name),
    setTrack:   (i)    => ipcRenderer.invoke('shot:setTrack', i),
    setName:    (n)    => ipcRenderer.invoke('shot:setName', n),
    // Free-form shot label (distinct from setName; stored as job.label).
    setLabel:   (s)    => ipcRenderer.invoke('shot:setLabel', s),
    // dev16 audit: setRenderMode / setRenderQuality were exposed for a
    // dropdown that was never built (or was removed) — no renderer ever
    // called them. Stripped in dev17 along with the matching IPC
    // handlers in main.js. If we re-introduce a quality dropdown, also
    // restore the `shot:setRenderMode` / `shot:setRenderQuality` IPC
    // handlers (their job-mutator helpers _setShotRenderMode /
    // _setShotRenderQuality are still in main.js as no-ops? — actually
    // gone with the handlers, see git log for the writeJob shape).
    setRenderFormat: (f) => ipcRenderer.invoke('shot:setRenderFormat', f),
    setRenderScale:  (s) => ipcRenderer.invoke('shot:setRenderScale', s),
    // v0.4.8 — accepts either a string (current project, named shot) OR
    // an object {project, shot} for rail-clicked shots in another project.
    deleteShot: (arg) => ipcRenderer.invoke('shot:delete', arg),
    // v0.4.8 — read-only preview of what a delete would actually remove.
    // Returns { ok, path, aepCount, kind }. Used by the path-aware confirm
    // modal so users see the exact folder before consenting, and a red
    // warning when .aep files are present.
    deletePreview: (arg) => ipcRenderer.invoke('path:deletePreview', arg),
    // dev35 — shot trash. Soft-delete is the default for shot:delete now;
    // these handlers expose the rest of the recovery surface to the UI.
    shotTrash: {
        list:    ()             => ipcRenderer.invoke('shot:listTrash'),
        restore: (project, entry) => ipcRenderer.invoke('shot:restoreFromTrash', { project, entry }),
        purge:   (project, entry) => ipcRenderer.invoke('shot:purgeFromTrash',   { project, entry }),
        empty:   ()             => ipcRenderer.invoke('shot:emptyAllTrash'),
    },
    // v0.4.8 — Force Relink: reconnect a stale Resolve reference using
    // os.path.abspath(). Status strip drives the terminal state.
    forceRelink: () => ipcRenderer.invoke('shot:forceRelink'),
    // v0.4.8 — pending-shot-name override for next export_range.py run.
    // Empty string / null clears.
    setPendingShotName: (n) => ipcRenderer.invoke('shot:setPendingName', n),
    // Deletes every version folder except the passed one; falls back to
    // job.finalVersion when called without an argument (legacy behaviour).
    keepOnlyFinal: (v) => ipcRenderer.invoke('shot:keepOnlyFinal', v),

    // Native confirm dialog (dialog.showMessageBox). Returns
    // { ok, confirmed }. Used for destructive actions so we get OS-styled
    // modals instead of the (often blocked) renderer window.confirm().
    confirmDialog: (opts) => ipcRenderer.invoke('dialog:confirm', opts),

    // Version lifecycle
    setFinal:    (v) => ipcRenderer.invoke('version:setFinal', v),
    setActive:   (v) => ipcRenderer.invoke('version:setActive', v),
    deleteVersion: (v) => ipcRenderer.invoke('version:delete', v),
    revealVersion: (v) => ipcRenderer.invoke('version:reveal', v),

    // App version (from package.json via app.getVersion()) for the header.
    getAppVersion: () => ipcRenderer.invoke('app:version'),

    // Pipeline triggers
    sendToAE:   () => ipcRenderer.invoke('shot:sendToAE'),
    renderBack: () => ipcRenderer.invoke('shot:renderBack'),

    // AE-first workflow: create a project (or shot) seeded from AE's active
    // comp, then hand the rendered version back to Resolve at the playhead.
    createProjectFromAE: (name) => ipcRenderer.invoke('ae:createProject', name),
    createShotFromAE:    ()     => ipcRenderer.invoke('ae:createShot'),
    sendToResolve:       ()     => ipcRenderer.invoke('ae:sendToResolve'),
    openFolder: () => ipcRenderer.invoke('shot:openFolder'),
    openProjectFolder: () => ipcRenderer.invoke('project:openFolder'),
    openProjectsRoot:  () => ipcRenderer.invoke('projects:openRoot'),
    openAE:     () => ipcRenderer.invoke('shot:openAE'),

    // Context-menu reveal targets (shot-level). Each highlights the specific
    // file in Explorer via shell.showItemInFolder(); falls back to opening
    // a sensible parent folder when the file isn't produced yet.
    revealJob:          () => ipcRenderer.invoke('shot:revealJob'),
    revealLatestRender: () => ipcRenderer.invoke('shot:revealLatestRender'),
    revealAEP:          () => ipcRenderer.invoke('shot:revealAEP'),
    // Relink the latest rendered master into Resolve — same pipeline as
    // clicking "Set Active" on the newest version card.
    relinkLatest:       () => ipcRenderer.invoke('shot:relinkLatest'),

    // Re-open the Setup Wizard from the main UI (overflow menu → Setup Wizard…).
    openWizard: () => ipcRenderer.invoke('wizard:open'),

    // Self-repair / reset (overflow menu). repair() returns a structured
    // report; reset() pops a confirm dialog and relaunches the wizard.
    repair: () => ipcRenderer.invoke('app:repair'),
    reset:  () => ipcRenderer.invoke('app:reset'),

    // Global Help menu → renderer bridge. Main.js emits 'menu:action' with
    // 'repair' | 'reset' (wizard opens directly from main) so the renderer
    // can trigger the same click handlers the overflow menu uses.
    onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, name) => cb(name)),

    // Persistent status strip feed. Main process calls emitStatus() at key
    // lifecycle moments (AE launch, render start/finish, relink, repair).
    // Payload: { text, kind: 'info'|'busy'|'ok'|'error', ts }.
    onStatus: (cb) => ipcRenderer.on('status:update', (_e, payload) => cb(payload)),

    // v0.4.8 — Alt-Tab / focus signals. Renderer toggles body.app-blurred,
    // the stylesheet short-circuits animations while unfocused. Saves CPU
    // when the user is working in AE/Resolve.
    onWindowBlur:  (cb) => ipcRenderer.on('window:blur',  () => cb()),
    onWindowFocus: (cb) => ipcRenderer.on('window:focus', () => cb()),

    // dev20 — AE scripting busy state. Fires {busy, label, queueDepth}
    // whenever the main-process AE lock acquires/releases. Renderers grey
    // out AE-bound buttons while busy=true to prevent double-dispatch.
    onAEBusy: (cb) => ipcRenderer.on('ae:busy', (_e, state) => cb(state)),

    // dev43 — push-based refresh signals. Replaces the renderer's 3s
    // polling tick. Main process watches PROJECTS_DIR + <vault>/assets
    // via fs.watch (debounced 250-500ms) and broadcasts on change. The
    // renderer keeps a 30s safety tick paused while hidden; these
    // pushes are the primary signal.
    onProjectsChanged: (cb) => ipcRenderer.on('projects:changed', () => cb()),
    onVaultChanged:    (cb) => ipcRenderer.on('vault:changed',    () => cb()),

    // dev44 — cross-project arrival banner. Main fires this when a
    // brand-new shot lands in a project DIFFERENT from the user's
    // current one while they're already working. Payload: { project,
    // shot }. Renderer paints a banner with [Switch] / [Dismiss].
    onCrossProjectArrival: (cb) =>
        ipcRenderer.on('cross-project:arrival', (_e, payload) => cb(payload)),
    // Banner action handlers.
    dismissCrossProjectArrival: () => ipcRenderer.invoke('crossProject:dismiss'),
    // Boot-race rehydrate: the watcher can fire and main can broadcast
    // before the renderer registers `onCrossProjectArrival`. Renderer
    // calls peek() once after mount to catch any in-flight pending.
    peekCrossProjectArrival:    () => ipcRenderer.invoke('crossProject:peek'),

    // v0.5.0 — Vault MVP. Per-shot checkbox driving batch "Vault Project".
    setVaultMarked: (marked) => ipcRenderer.invoke('shot:setVaultMarked', !!marked),

    // v0.5.0 — open the standalone Vault window (vault.html). Separate
    // window so the main shot UI stays focused.
    openVault: () => ipcRenderer.invoke('vault:open'),
});

// v0.5.0 — Vault MVP. Separate namespace so the Vault tab / asset browser
// binds to its own surface. Every handler returns {ok, ...} or {ok:false}.
contextBridge.exposeInMainWorld('vault', {
    pickRoot:  ()              => ipcRenderer.invoke('vault:pickRoot'),

    list:              ()        => ipcRenderer.invoke('vault:list'),
    mediaPaths:        (id)      => ipcRenderer.invoke('vault:mediaPaths', id),
    rebuildIndex:      ()        => ipcRenderer.invoke('vault:rebuildIndex'),
    reveal:            (id)      => ipcRenderer.invoke('vault:reveal', id),

    canVaultShot:      (arg)     => ipcRenderer.invoke('vault:canVaultShot', arg || null),
    createFromShot:    (arg)     => ipcRenderer.invoke('vault:createFromShot', arg || null),
    createFromProject: (arg)     => ipcRenderer.invoke('vault:createFromProject', arg || null),
    // dev13 — clip-mode entry points.
    clipFromShot:      (arg)     => ipcRenderer.invoke('vault:clipFromShot', arg || null),
    importClipToAE:    (args)    => ipcRenderer.invoke('vault:importClipToAE', args),

    delete:      (id)            => ipcRenderer.invoke('vault:delete', id),

    importToResolve: (args)      => ipcRenderer.invoke('vault:importToResolve', args),
    importToAE:      (args)      => ipcRenderer.invoke('vault:importToAE', args),
    // dev19 — asset → into running AE project. Default click on an asset
    // card's "→ AE" button. The legacy "as new shot" dialog stays
    // reachable via the secondary "as shot…" button.
    importAssetToOpenAE: (args)  => ipcRenderer.invoke('vault:importAssetToOpenAE', args),

    // dev20 — same AE busy event as `window.api.onAEBusy`, exposed under
    // the vault namespace so vault.html can bind without poking at api.
    onAEBusy: (cb) => ipcRenderer.on('ae:busy', (_e, state) => cb(state)),

    // dev43 — vault watcher pushes. fs.watch on <vaultRoot>/assets/
    // (debounced 500ms) emits 'vault:changed' on each quiet period.
    onVaultChanged: (cb) => ipcRenderer.on('vault:changed', () => cb()),

    // dev33 — "Add asset" picker. Opens a native .aep file dialog
    // (or accepts a pre-resolved path) and vaults the project as an
    // external asset. Returns { ok, canceled? } when the user backs
    // out of the picker, distinguishable from a real failure.
    addExternalAEP: (args) => ipcRenderer.invoke('vault:addExternalAEP', args || {}),

    // dev24 — virtual folders. Metadata-only; asset bytes never move.
    folders: {
        create: (name)              => ipcRenderer.invoke('vault:folders:create', { name }),
        rename: (id, name)          => ipcRenderer.invoke('vault:folders:rename', { id, name }),
        remove: (id)                => ipcRenderer.invoke('vault:folders:delete', { id }),
        assign: (assetId, folderId) => ipcRenderer.invoke('vault:folders:assign', { assetId, folderId }),
    },

    // dev32 — trash drawer. listTrash returns deletedAt + daysRemaining
    // for each entry; restore moves an entry back into assets/;
    // emptyTrash wipes everything regardless of age (gated by a confirm
    // dialog in the UI). 7-day auto-purge on boot is unchanged.
    trash: {
        list:    ()      => ipcRenderer.invoke('vault:listTrash'),
        restore: (entry) => ipcRenderer.invoke('vault:restore', { entry }),
        empty:   ()      => ipcRenderer.invoke('vault:emptyTrash'),
    },
    // dev17 audit: getRoot, read, listTrash, restore, purgeTrash,
    // verifyPortability were exposed but no renderer consumed them. Trash
    // UI was scoped out for MVP; getRoot/read/verifyPortability were
    // debug-friendly hooks that never grew a UI. Stripped in dev17 with
    // the matching IPC handlers. Trash retention is still enforced —
    // VAULT.purgeOldTrash() runs internally on app boot. To re-expose,
    // restore the `vault:listTrash` / `vault:restore` / `vault:purgeTrash`
    // / `vault:read` / `vault:getRoot` / `vault:verifyPortability`
    // ipcMain.handle blocks (they're kept in git history) and add the
    // wrappers back here.
});

// Setup Wizard — separate namespace so wizard.html can bind to a distinct
// surface without polluting the main UI's `window.api`. All handlers return
// plain objects; none throw across the bridge.
contextBridge.exposeInMainWorld('wizard', {
    getMode:          ()      => ipcRenderer.invoke('wizard:getMode'),
    detect:           ()      => ipcRenderer.invoke('wizard:detect'),
    pickAEExe:        ()      => ipcRenderer.invoke('wizard:pickAEExe'),
    pickAEFolder:     ()      => ipcRenderer.invoke('wizard:pickAEFolder'),  // dev52 — folder-mode AE picker
    pickRoot:         (s)     => ipcRenderer.invoke('wizard:pickRoot', s),
    // v0.5.0 — separate vault picker (may live on a different drive).
    pickVaultRoot:    (s)     => ipcRenderer.invoke('wizard:pickVaultRoot', s),
    defaultRoot:      ()      => ipcRenderer.invoke('wizard:defaultRoot'),
    probeWritable:    (p)     => ipcRenderer.invoke('wizard:probeWritable', p),
    installResolveScripts: () => ipcRenderer.invoke('wizard:installResolveScripts'),
    installPython:         () => ipcRenderer.invoke('wizard:installPython'),
    save:             (cfg)   => ipcRenderer.invoke('wizard:save', cfg),
    finish:           ()      => ipcRenderer.invoke('wizard:finish'),
    cancel:           ()      => ipcRenderer.invoke('wizard:cancel'),
});
