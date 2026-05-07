// lib/arrival_policy.js — dev44.
//
// Pure decision function: given a newly-detected arrival from
// detectNewShotAcrossProjects() plus the user's current selection, what
// should the app DO about it? Three outcomes:
//
//   * 'none'         — no arrival, nothing to do.
//   * 'auto-jump'    — true cold start (no shot selected yet). Land on
//                      the new arrival without prompting; nothing to
//                      preserve.
//   * 'intra-project' — the arrival is inside the user's current
//                      project. Caller's existing intra-project
//                      auto-select rule (line 347 in main.js) still
//                      applies; this function intentionally doesn't
//                      override it.
//   * 'cross-project-banner' — the user IS on a shot, and the arrival
//                      is in a DIFFERENT project. Show the banner;
//                      never silently jump.
//
// Why a separate file? main.js's shot:info handler grew a complex
// auto-jump rule pre-dev44 that mutated state mid-handler. Extracting
// the policy makes the rule (a) one self-contained piece of code, (b)
// unit-testable without spinning up Electron, and (c) explicit about
// the four outcomes so future changes are obvious diffs against this
// table rather than scattered conditionals.

function classifyArrival({ newArrival, currentProject, currentShot }) {
    if (!newArrival) return 'none';
    // True cold start: no shot pinned. Auto-pick is helpful here —
    // user hasn't expressed a preference, and not landing on
    // SOMETHING would mean a blank UI. Cold start can still be a
    // cross-project arrival (the user's seeded project from
    // settings.json may differ from where the arrival landed); the
    // caller updates currentProject in that branch.
    if (!currentShot) return 'auto-jump';
    // Same project — let the caller's intra-project auto-select rule
    // handle this one. The cross-project banner would be misleading
    // ("appeared in [same project]") and the existing rule already
    // does the right thing per `userSelectedShot`.
    if (newArrival.project === currentProject) return 'intra-project';
    // User is on a shot in a DIFFERENT project. Don't yank them out
    // of their current context — surface a banner instead.
    return 'cross-project-banner';
}

module.exports = { classifyArrival };
