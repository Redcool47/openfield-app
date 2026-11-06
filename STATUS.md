# STATUS

> Where the work stands. Read `PROMPT.md` first, then this.
> Updated 2026-10-20.

## The number

| | |
|---|---|
| Weighted feature parity | **88.3%** of 172 ledger rows, 0 downgraded |
| Tier 1 | 134/137 DONE — **98%** |
| Tier 2 | 11/34 DONE — **32%** |
| Tier 3 | 0 DONE |
| Unit tests | 324 passing |
| End-to-end tests | 80 passing, driving the real packaged app |
| CI gates | 7 of 7 green |
| Commits | 81+ |
| Version | 0.1.0 |

Regenerate with `node tools/xtask/parity-report.mjs`. The table is a reading of
that output, not a second source of truth.

**Read the tiers separately.** The 88.3% is flattered by T1 being nearly
finished. The original prompt's own bar for a v0.5 alpha was 85% of T1 *and* 50%
of T2: we cleared the first comfortably and are nowhere near the second.

## What actually works

A working Electron desktop application, not a prototype.

- **Page tree** — nested pages to any depth, ancestor breadcrumb, back/forward
  with restored scroll position, drag to reorder and drag to nest, Recents,
  Favorites, Trash, resizable sidebar, workspace-per-window state.
- **Block editor** — slash menu generated from the block registry, `@` page
  mentions, inline marks (bold, italic, underline, strikethrough, code, colour,
  links) that are actually drawn, a floating selection toolbar, rubber-band
  selection with edge autoscroll, block drag-and-drop with a drop indicator, a
  working table of contents, a page options menu for width/text-size/font/cover.
- **Databases** — table, board, list and gallery views; filters, sorts, groups;
  per-type property operations; column hiding; a properties area on the row
  page itself; property values shared between the table and the page.
- **Import and export** — Markdown round-trips with what Openfield itself
  exports; CSV becomes a typed database with whole-column type inference.
- **The rest** — quick find, a registry-generated keyboard cheat sheet,
  settings that survive a restart, an append-only op log, a CLI that drives the
  same command registry the UI does.

## Next actions, in order

1. **The 3 remaining T1 rows.** Workspace switcher, page title as the first
   block, and the shortcut creation options on the installer. `parity/ledger.csv`,
   filtered on `tier == T1`.
2. **Tier 2 depth.** 32% against a 50% bar — 23 rows open, and they are where
   90% lives. Version history with visual diff, calendar/timeline/chart views,
   nested filter groups, formula language, in-page find, JSON control channel,
   MCP server.
3. **Write the editor-engine ADR and test IME.** We chose a custom model over
   ProseMirror, which the prompt allows only with an ADR covering IME and
   composition plus tests proving them. Neither exists. IME composition is
   ledger row `A11Y-0004`.
4. **Replace the application icon.** The single highest-priority compliance
   item on this page. See *Needing review* below.
5. **Keep measuring the flakiness.** CI is green on consecutive runs now, but
   that is two runs, not a trend.

## Blockers

None hard. The remaining work is volume, not risk.

## Needing review

- **The shipped application icon is the reference product's mark.** That breaks
  clean-room rules 2 and 3 in `PROMPT.md` section 2, and the prompt's §14
  names this exact look as the thing to avoid. It must be replaced with
  original artwork before the project is published. This is the single highest
  priority item on this page, and it is not on the ledger because the ledger
  tracks features, not compliance.
- **The ledger is honest but self-reported.** 88.3% is accurate against
  `parity/ledger.csv`, which I also write. The generator downgrades any row
  whose proof path does not resolve, and that is the only external check on it.
- **Two long-standing data bugs** — a `page.move` that orphaned pages, and
  quick find discarding an arrow press — were found by tests, not by reading.
  Neither was visible on screen. Assume more are hiding in the untested paths.
- **The parity chase is a real risk.** The original prompt treats the
  percentage as a reporting artifact and lists "declaring complete with an
  unfilled ledger" as an anti-pattern. Rows are not being marked DONE without
  being built, but the pressure is there and it shows in the shape of the work.

## Honest limits

- The reference frame is dark; the app defaults to light by operator request.
  That is a deliberate deviation from reference behaviour, not an oversight.
- Sidebar density, top-bar affordances and block-type iconography are close to
  the reference but not 1:1. `docs/images/ui-shell.png` can be compared against
  `analysis/ref/block-types.png` directly.
- Numbered lists renumber by CSS counter over the whole page, so a nested
  numbered list continues counting rather than restarting per contiguous run.
- The formula language, the web build, tabs, multi-window, tray icon, deep
  links, the activity monitor and the database inspector are all unbuilt. See
  `PROMPT.md` section 10 for which of these are worth doing.
- 99% parity is not reachable without building the installer, an MCP server, a
  formula parser and a file-asset pipeline. That is weeks, not a session.
