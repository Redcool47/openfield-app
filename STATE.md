# STATE (update after every meaningful step)

Updated: 2026-11-06   Commit: (see git log)   Session: 10
Phase: 7 (build)   Slice: trailer live footage; next slice: database formulas, relation/rollup, calendar and timeline views   Milestone target: v0.5 alpha

## This session

- The trailer is now live footage of the app being used, not stills. A drawn
  cursor over a screenshot promised a product the viewer never saw move, and
  three things the film exists to show — typing, colouring a line, a page
  reflowing when its font changes — cannot be shown by a still at all.
  `node trailer/record.mjs` records the real Electron window through Playwright
  and cuts the take into seven all-intra shots (`trailer/shots/`, 22.9 s of
  action); `trailer/index.html` plays them back to back in the 1440x853 window
  box. Total film 28.5 s (was 40.4 s), rendered at 1920x1080/30. The last beat
  is quick find, keyboard only: the one place in the film where nothing is
  clicked, and the clearest statement of what the app is for.
- The recording writes variable frame rate video, so a shot cut timed from
  `duration - takeLength` drifted up to a second and put the wrong action in a
  shot. The recorder now paints a full-window red frame immediately before the
  take; decoding the first 12 s at 20 fps and finding the last red frame gives
  the offset exactly. Cue times come from the shot's own clock, so the drawn
  cursor cannot drift inside a shot.
- A real feature was added for the film, not faked for it: **text colour**.
  The model already carried `color`/`background` on runs; `setColor`,
  `mark.color.set`, nine hues in `design/tokens.json`, a colour popover in the
  selection bar, model tests, and a contrast gate extended over every hue on
  every surface (88 pairs).
- Six real bugs found while recording, each fixed at the root and covered:
  - a row added from the database table never appeared in it (the table kept
    its own `rows` state and nothing copied the new one in);
  - a space in a row title opened that row's page mid-word (the cell's key
    handler ignored `e.target`);
  - the page title could not be focused by mouse at all (the rubber-band
    selection handler swallowed the press because a title is not a block);
  - `page.rename` copied the title into the first block and ignored the caller's
    `id`, so naming a row renamed the open database page and pages showed their
    own name twice;
  - `/todo` found nothing in the slash menu (the label is "To-do list" and the
    plain word is not a substring of it);
  - the sidebar "New page" button created a page without opening it.
- Seven, found in the render: arriving at a page through quick find painted its
  title as the "Untitled" placeholder for a few frames, then corrected itself.
  The title was written into the h1 by a passive effect, so the empty element
  painted first and `:empty::before` drew the placeholder. It is a layout effect
  now, and a focused title the browser shows as empty is filled rather than
  trusted.
- `npx hyperframes check` on the trailer: 0 errors, 11 warnings (the project's
  long-standing "should be a sub-composition" shape warnings). Render: 28.5 s,
  5.3 MB, peak −1.6 dBFS, no clipping.
- Fixed: the "Mentioned in" panel was rendered above the page title, so a page
  that anything links to opened on a list of links instead of on itself.
- Fixed: `desktop-editor.spec.ts` isolated the Chromium profile but not the
  workspace, so its docs screenshot showed 1606 pages accumulated by earlier
  runs. The undo test also assumed three keystrokes coalesce into one undo
  step, which depends on a 600 ms burst window; it now sends one input event.
- The repository is filled out: CI workflow, issue and pull request templates,
  CONTRIBUTING, SECURITY, CHANGELOG, description and topics, a screenshot in
  the README, and the root version caught up with the desktop app at 0.2.0.
- The README was rewritten to read like a repository someone arrives at rather
  than a status report: what the app is in two sentences, a two-image tour, and
  a "Get it running" block that works from a clean clone. It says plainly that
  there is no installer yet, instead of implying a download that does not exist.

## Earlier this session

- Built the first version of the trailer under `trailer/`: a 40 s HyperFrames
  composition (1920x1080) that composited stills captured from the real app on a
  gradient wash, with captions, a cursor and a drawn Markdown file card. That
  version is superseded by the recorded one above; `trailer/capture.mjs` still
  reproduces the stills but the film no longer uses them.
- Replaced the sidebar's `⌘` placeholder with an original mark: a field of
  four plots, one seeded. Inline SVG in App.tsx, so no asset file, no font and
  no third-party artwork.
- Fixed the settings rail growing a horizontal scrollbar: the nested AI tab was
  `width: 100%` plus a 12px margin, so it overflowed the rail by 12px.
- CI green after the change: layering, attribution, typecheck, unit, parity,
  package, 84 e2e.

- Earlier, still current: picked up from a stale STATE.md / gaps.md / HANDOFF.md.
- Picked up from stale STATE.md / gaps.md / HANDOFF.md. Those docs claimed
  "there is no graphical application yet" and "packaging not started," but the
  repo already contains a built Electron desktop app (apps/desktop), a ui-kit
  package (packages/ui-kit), a contenteditable block editor with undo/redo and
  inline marks routed through the command registry, and an NSIS installer
  (docs/images/app-packaged.png, app-first-run.png). Reconciling docs with
  reality is this session's first job.
- Committed the pending editor.tsx change (Ctrl/Cmd+Z undo, Ctrl/Cmd+Y redo,
  Ctrl+B/I/U/E inline marks via history.undo / history.redo / mark.*.toggle
  commands) — part of the green build.
- Baseline verified: `tsc -b` clean, 114 tests pass (geom 16, model 62,
  storage 25, slice-1 scenario 11).

## Corrections to earlier conclusions in this log

None new this session; the earlier corrections in STATE.md (window-show, sidebar
below-fold, DPI screenshot) still hold.

## Done (last 10)

- L0 packages/geom: UUIDv7 ids, fractional ordering, pure helpers.
- L1 packages/model: rich text, block registry, block tree, transactions with
  snapshot undo, editing operations, three-level selection model.
- L2 packages/storage: SQLite driver adapter, schema v1, forward-only migrations,
  FTS5 search with ranking, recursive-CTE trash/restore/purge, integrity
  self-test.
- L3 packages/commands: the command registry, the session, ~50 commands;
  apps/cli (ow) as the agent interface.
- apps/desktop: Electron main, narrow preload bridge (execute/state/onState),
  one window, context isolation + sandbox + strict CSP. Sidebar tree with
  favourites, trash, row menu incl. "Move to trash" without opening the page.
  TopBar, page view, per-block contenteditable editor.
- packages/ui-kit: design tokens (light/dark), original 16x16 line icons,
  Menu/Tooltip/Modal/Toast overlays with keyboard support and focus trapping.
- Packaging: electron-builder NSIS wizard (oneClick: false, directory choice,
  licence page); win-unpacked build launches and shows its window.
- tools/xtask: layering, attribution, parity report, one-command CI.
- docs: CHARTER.md, requirements-from-operator.md, shell-architecture.md,
  reference-findings.md, gaps.md, LICENSE, NOTICE.

## Doing now

Nothing in flight. The film is rendered and its sound measured; the repository
metadata, templates and workflow are in place. CI green at this commit.

## Next (max 5)

1. Replace the packaged app icon (`apps/desktop/build/icon*.png`, `icon.ico`,
   `logo.png`): they are still the reference product's mark, which breaks the
   clean-room rules. The sidebar mark in the running app is now original; the
   installed binary's icon is not.
2. Formula language for database properties (`DB-PROP-0020` / `DB-FORM-0050`):
   a hand-written parser, no `eval`.
3. Relation and rollup properties (`DB-PROP-0021`).
4. Calendar (`DB-CAL-0001`), timeline (`DB-TIME-0001`) and chart
   (`DB-CHART-0001`) views.
5. The remaining UI rows (`UI-0004/0005/0006/0007`), agent rows
   (`AGENT-0006/0007`), canvases and page-properties UI.
   (db-core 0%, db-props 6%, db-filter 0%, db-views 0% — the largest remaining
   Tier 1 gap).

## Open unknowns (REA ledger ids)

- U-001 The reference page UI could not be observed. Permanently blocked from
  these inputs; blocked on operator-supplied recordings or screenshots.
- U-002 No populated local SQLite cache was supplied; our schema is designed
  from public API shapes.
- U-003 6 literal IPC channels observed against 26 operations; dynamic naming
  scheme partly characterised. Not blocking.
- U-004 Semantics of most of the 279 exposed bridge members were not traced.
  Deliberate; tracing drifts toward code copying.

## Blockers / need from operator

- ONE batched request, per the brief's section 12.4. Exact list in
  docs/gaps.md section 4. Priority: recordings/screenshots of sidebar row menu,
  slash menu, block types in light/dark, database table view, settings, trash;
  the published keyboard shortcut list; optionally a Markdown/CSV export.
- Not blocking. Keep building.

## Test status

- unit: 344 passed (30 files, `npx vitest run`)
- typecheck: clean
- e2e: 84 passed (5.5 min), full suite re-run after the workspace-isolation fix
- CI: PASSED — layering, attribution, typecheck, unit, parity, package, e2e
- parity: 172 rows, weighted 88.8%, 0 downgraded
- trailer: rendered, 40.0 s, 1920x1080, 30 fps, AAC audio, peak −7.9 dBFS;
  every cut checked frame by frame, the mix measured rather than listened to

## Gotchas learned

- An e2e launch that sets `OW_USER_DATA` but not `OW_WORKSPACE` isolates the
  profile and writes into whatever workspace the app defaults to. One spec did
  exactly that and its documentation screenshot showed 1606 pages left by
  earlier runs.
- A test must not assume three keystrokes coalesce into one undo step: the burst
  rule is a 600 ms window, so on a loaded machine the burst splits. Send one
  input event when the test is about the undo route, and leave the burst rule to
  the model's own coalescing test.
- The trailer's cursor is aimed from `trailer/frames/cues.json`, which
  `capture.mjs` prints from real bounding boxes. A hand-picked coordinate looked
  right and landed one row below the row it meant to click.
- A fractional index must forbid trailing zero digits. `"z"` and `"z0"` are the
  same fraction written two ways, so a naive generator eventually emits a key
  with nothing between it and its own prefix.
- Never mix short integer keys with fractional keys: `"az" < "b"` but
  `10*62+61 > 11`, so order silently breaks past 100 siblings.
- `textOf`, `setContent`, `normalizeContent` and `insert` accept **either** a
  `Content` or a bare runs array on purpose. Mixing the two spellings silently
  produced `{ runs: undefined }`, failing far from the cause.
- `TxContext.touch` detects creation from the id set captured at transaction
  open, so the natural `insert(); touch(id)` order records `before = null`
  correctly and undo removes rather than restores.
- Typing coalescing is declared per transaction (`coalescible`), never inferred
  from touched-block counts. The inferred version merged structural changes into
  adjacent keystrokes.
- `previousBlock` originally returned null for every root-level block because it
  indexed the ancestor chain one level too deep.
- `purgeBlock` deleted rows without detaching them, leaving a tree referencing
  missing blocks; the post-transaction assertion caught it.
- `tx.remove` recorded a snapshot without deleting, so Backspace-merge left a
  ghost block behind. It now detaches and deletes.
- `snippet()` and `bm25()` need the FTS5 **table name**, not an alias; SQLite
  rejects an alias with "no such column".
- Transactions must be re-entrant: `restorePage` calls `reindexPage`, which is
  itself transactional.
- `node:sqlite` must be loaded through `createRequire`; a dynamic
  `await import('node:sqlite')` is rewritten by Vite into a resolvable
  specifier and fails looking for a package named `sqlite`.
- The CLI resolver hook must return `format: 'module-typescript'`, not `module`.
- Never emit compiled `.js` beside the `.ts` sources; stale output shadows the
  source. `tsconfig` uses `noEmit`.
- PowerShell mangles quotes in native arguments. Use `--script file.json` for
  any JSON payload.
- CI launches tools as `node <entry-point>`; spawning a `.cmd` on Windows needs
  a shell and reintroduces quoting bugs.
- A keybinding index must be per platform, or chords that are intentionally the
  same on Windows and macOS read as conflicts and the check becomes noise.
- `pnpm` is not installed here, so the project uses npm workspaces.
- The workspace root contains unrelated projects (`launch-teaser`, `lumira-reel`,
  and an extracted copy of a previous attempt). They are gitignored so they
  cannot enter this repository's history.
- gaps.md / HANDOFF.md / STATE.md can go stale faster than the code: this
  session found them claiming "no graphical application" when a desktop app
  already exists. Always reconcile docs with `git log` and the tree before
  planning.

## Commands

- install: `npm install --ignore-scripts` (no native build step required)
- ci: `node tools/xtask/ci.mjs`
- test: `npx vitest run`
- typecheck: `npx tsc -b tsconfig.build.json`
- run: `node apps/cli/bin/ow.mjs help`
- parity: `node tools/xtask/parity-report.mjs`

## Editor work (continued)

The app rendered blocks but could not be typed into. It now is, entirely through
the command registry.

- **New commands.** `block.setText` (coalescible, grouped per block) and
  `block.setChecked`. Typing previously had nowhere to go, and the to-do
  checkbox was calling `block.toggleOpen`, which was simply wrong.
- **The editor.** One `contenteditable` per block, so each keystroke maps to one
  block and there is no internal model to reconcile. Enter splits, Tab and
  Shift+Tab indent, Backspace merges at the start of a block, and the slash menu
  opens and filters as you type. Marks (Ctrl+B/I/U/E, Ctrl+Shift+S) need a
  selection and leave it selected so consecutive marks compose.
- **Two real bugs found and fixed.**
  - `tx.touch()` was called *after* the mutation in two commands. touch clones
    the block as it is at call time, so undo recorded the new value as the
    "before" state and did nothing at all. Fixed the ordering, and stated the
    precondition in the API rather than leaving it as folklore.
  - Coalescing could never happen: `History` refuses to merge edits that name no
    group, and `Session.edit` never passed one. Every keystroke was its own undo
    entry, which is the exact problem coalescing was meant to solve.
- **One owner per shortcut.** Ctrl+Z was handled by both the editor and a global
  listener, so one press fired two undos. Neither half was wrong alone.
- **CI holes closed.**
  - `apps/desktop` and `packages/ui-kit` had no tsconfig and were never
    typechecked. A missing import shipped a blank page and CI was green. Adding
    them surfaced five real errors immediately.
  - The Playwright suite existed but never ran in CI. It is a step now.
  - Optional steps hardcoded their duration to 0 ms and printed no verdict, so a
    skipped step and a passed one looked alike.
  - Playwright failure screenshots had been committed. Now ignored.

## Still true, and still worth repeating

- The reference application cannot be observed running. REA on both 7.38.1 and
  7.39.0 finds **zero CSS files and zero font files**, and every renderer is
  application chrome. Spacing and type scale are not hard to extract from the
  supplied builds; they are absent from them. See `docs/reference-findings.md`.
- `tools/measure-screenshot.mjs` now measures a native-resolution still. It was
  validated against a screenshot whose answer was already known: it reports
  background `#171716` and ink `#cacacb`, both values already measured from
  video. It needs the PNG as a file; an attachment cannot be measured.
