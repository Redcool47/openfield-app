# PROMPT — Openfield

> The operating manual for this project. Read this first, then `STATUS.md`.
> Written so I do not have to re-derive any of it each session. It is my
> document: private, single-writer, and not a briefing handed to whoever is next.
>
> Derived from the operator's original master prompt (2026-10-16), tightened and
> updated with what the last four sessions learned. The original is kept
> verbatim at `Downloads/open-sorce-notion-Master-Prompt.md`.
>
> **Naming convention used throughout:** the product is *Openfield*. The
> reference product is referred to as "the reference product" or "the reference
> build". Its name appears nowhere in the product, the code, the installer, the
> package id, the URLs or the bundle ids. A single compatibility statement in
> the README is allowed and is present.

---

## 1. Mission

Build a free, open-source, **local-first** desktop workspace application:
nested pages, a block editor, and page-backed databases. Every line of code,
icon, word and name is original or openly licensed.

The bar is behavioural, not cosmetic: a long-time user of the reference product
should sit down and work without relearning anything. What happens when they
click, type, drag, select and navigate should match. It is explicitly **not** a
pixel-for-pixel replica and contains no reference code or assets.

The product runs fully offline. No account, no server, no network request at
runtime. Your notes live in a folder you own.

## 2. Legal rules — non-negotiable

1. **Never copy another product's code.** Analysis informs behaviour; all code is
   our own. Treat recovered material as a specification of observable behaviour
   and rewrite it in our own words.
2. **Never copy another product's assets.** No logos, wordmarks, app icons,
   illustrations, template galleries, emoji artwork, icon files, bundled fonts,
   sounds, or distinctive long UI strings. Short functional labels ("Search",
   "Trash", "Favorites") are ordinary words and are fine.
3. **Never use another vendor's name or marks** in the product name, title,
   installer, package id, URL or bundle id.
4. **No service impersonation.** Never contact another vendor's servers. Never
   reuse tokens, cookies or session state. Compatibility comes from **export
   files the user supplies** and **public documented formats** only.
5. **No circumvention.** No bypassing licensing, authentication, DRM, signing,
   update or integrity checks. No patching third-party binaries. No
   redistributing them.
6. **Privacy.** Never read, copy, log or ship real personal account data. Use
   synthetic samples in every test.
7. **Dependencies** must be MIT, BSD, ISC, Apache-2.0 or MPL-2.0 as an
   unmodified dependency. No GPL, AGPL or commercial licence. Every dependency is
   recorded in `THIRD_PARTY_NOTICES.md`.
8. **If an instruction would force you to break rules 1–7:** stop, explain in one
   paragraph, and offer the clean-room alternative.

> **Open item.** The shipped application icon is currently the reference
> product's mark. That breaks rules 2 and 3. It must be replaced with original
> artwork before the project is published. Tracked in `STATUS.md`.

## 3. Fidelity contract

Judged on eight axes, in priority order:

1. **Interaction model** — what a click, drag, hover, focus, selection and
   keystroke does.
2. **Keyboard model** — every shortcut and every block type's Enter, Backspace,
   Tab, Shift+Tab and Esc behaviour.
3. **Data model** — blocks are a tree of typed nodes with stable ids; a page is a
   block; a database row is a page.
4. **Layout logic** — sidebar structure, page width modes, title area, content
   column, margins, scroll behaviour, hover affordances, menu placement relative
   to the caret.
5. **Visual rhythm** — type scale, line heights, spacing, colours in light and
   dark, radii, shadows, icon size, hover and selected colours. **Measured, not
   guessed.**
6. **Motion and feedback** — transition durations and easings, drag indicators,
   toasts. Measured, then re-created.
7. **Feature breadth** — the ledger.
8. **Interoperability** — import and export of Markdown, CSV, HTML, JSON, PDF.

Fidelity is **not** judged on brand, cloud collaboration, hosted AI, calendar or
mail products, or enterprise administration.

## 4. Operator requirements

These are the acceptance criteria. Each maps to ledger rows.

- **R1** Nested pages to any depth; favorites, trash, restore. Restore returns to
  the original parent, or to the top level if the parent is gone. Trash has a
  configurable retention policy and permanent deletion.
- **R2** Delete from the sidebar **without opening the page**. Every row has a
  three-dot menu containing other actions *and* a clearly labelled "Move to
  Trash" in danger styling. A confirmation or undo toast follows.
- **R3** Settings that work and persist: theme, interface text size, accent
  colour, page width, zoom.
- **R4** Databases: table, board, calendar, gallery, list views; common field
  types; filtering, sorting, status changes.
- **R5** Markdown and CSV import and export.
- **R6** Page history: automatic versions, listable, previewable, restorable.
  Restoring creates a new version rather than destroying old ones.
- **R7** A real installer with a setup wizard — licence page, install-location
  choice, shortcut options. Plus a source archive and a project overview as
  release artifacts.
- **R8** Feel like the real product, "as if it were 1:1", and open source from
  the ground up.
- **R9** Clean-room provenance; no network dependency; fully offline.

## 5. Architecture

```
packages/
  geom/        L0  ids, fractional ordering, small pure helpers
  model/       L1  block schema, tree, transactions, undo, selection, rich text
  storage/     L2  SQLite, migrations, FTS5, integrity checks, op log
  commands/    L3  the command registry and the session
  ui-kit/      L5  design tokens, primitives
apps/
  cli/             the `ow` agent interface
  desktop/         the Electron application
tools/xtask/       layering, attribution, parity, CI
```

A package may import only from lower layers, and a relative import may not
escape its own package. `tools/xtask/layering.mjs` enforces both and runs in CI.

**The document model is a pure data structure with no UI dependency.** That is
why the whole editor can be driven and asserted headlessly. The desktop app
calls the same registry the CLI does — there is no second path into the model.

**Small files.** Nothing over roughly 600 lines without a written reason. The
previous attempt's 53 KB `App.tsx` is the anti-pattern we are avoiding.

**No UI code may mutate the model except through a command.** The command
registry is the only door.

## 6. The ledger — what DONE means

`parity/ledger.csv`, columns `id,area,tier,feature,source,status,proof,notes`.
Tiers T1..T4. Weighted parity: T1 = 3, T2 = 2, T3 = 1, T4 = 0.25. `PARTIAL`
counts 0.5.

A row is `DONE` only if **all** hold:

1. Behaviour matches the catalog entry, including edge cases.
2. It works with keyboard and pointer where the original does.
3. It is undoable where the original's is.
4. It survives save and reload.
5. There is an automated test.
6. There is a screenshot or DOM-assertion proof, and the proof path resolves.
7. No known crash or data-loss bug is open against it.

**`DONE` without a proof path that exists on disk is forbidden.** The generator
downgrades such rows automatically.

Honest accounting is the point. A vague "feature complete" is worth less than a
generated percentage with a written gap list.

## 7. Honesty rules

Use these four words precisely:

- **implemented** — code exists and compiles.
- **working** — you ran it and saw the result.
- **tested** — an automated test exists and you saw it pass.
- **verified against the reference** — you compared against observed or
  documented behaviour.

Never write "all tests pass" without running the suite in the same session and
quoting the summary line. Never write "the installer works" without having
installed it, or without saying plainly that you only built it. Show failing
output when something fails. **A false "done" is the worst thing you can
produce.**

## 8. Definition of done, per slice

1. Code merged; typecheck, lint, unit tests green.
2. Ledger rows updated with proof.
3. At least one scenario passes through the agent interface (`ow run`), and
   where UI is involved a Playwright test passes.
4. A screenshot generated by the app's own harness, saved under `docs/images/`.
5. `STATE.md` updated; commit made.
6. No new warning-level logs in the standard scenario.

## 9. Budget discipline

Context and allowance are finite and may end without warning. Plan for that from
the first minute. Spend roughly: 12% analysis, 5% specs, 3% design tokens, 55%
building, 10% parity harness, 10% release and docs. Never spend more than ~15%
of any phase on polish. When a phase's budget is spent, write the gate artifact
with what you have and move on; mark gaps as unknowns.

**Leave the repository resumable.** After every meaningful step: update
`STATE.md`, commit small, and write `docs/HANDOFF.md` when context is running
out. A fresh agent must be able to read `AGENTS.md`, `STATE.md` and
`docs/HANDOFF.md` and continue.

**Ask only what only the operator can provide:** access, credentials, a legal
choice. Batch questions into one message and keep working while waiting.

---

## 10. What we learned since the original prompt

These are the corrections the last four sessions earned. They override
assumptions in the original.

**The desktop build is a thin shell around a remote web app.** Its editor source
is *not* in the files. Do not hunt for it. Behaviour comes from running the
shell, public documentation, and operator-supplied recordings. This was handled
correctly — the design was derived from operator footage and measurements, not
from a reverse-engineering fantasy.

**Do the packaging spike first.** The original prompt flagged this as the
previous attempt's fatal mistake: it shipped a shallow app because packaging was
deferred to the last hour. We deferred it too. **That one is done** — the
installer was built and then installed and launched rather than merely
configured, and the portable build and the zip archive come out of the same
CI run. The lesson still stands for whatever is next: **packaging before the
next big feature, not after.**

**A test that asserts the model after a UI command proves the wrong thing.**
Marks were stored correctly, applied by working commands, and rendered as plain
text for most of the project's life. Every mark test read the database. It
proves the command ran; it does not prove the user can see anything. **Assert
computed styles.** The same class of bug hid a `toc` block that did nothing, a
`block.insert` that could not create a registered type, and a quick-find that
discarded an arrow press.

**Never maintain a second list of block types.** The slash menu, the turn-into
commands and the insert enum each had their own list, and each drifted. All read
the registry now.

**The editor engine decision is unfinished.** We implemented a custom model
rather than ProseMirror, which the original prompt allowed — but only with an
ADR covering IME and composition, and tests proving them. There is no such ADR
and IME composition is still unimplemented. **Write the ADR, then test IME.**

**Watch for the empty string where you meant null.** `page.move` took
`?? null`; `''` is not nullish, so it was written into `parent_page` and
produced a page whose parent did not exist — invisible in the tree, unrecoverable
from the UI. The command reported success. Normalise at the boundary.

**Test isolation is a correctness concern, not hygiene.** The e2e suite was
writing to the real user workspace, and every Electron launch shared one
Chromium profile, so preferences leaked between runs and a profile lock made
launches fail with `ECONNRESET`. Both are fixed with explicit per-run
directories. If a test fails for a reason that has nothing to do with the code,
fix the isolation before you touch the code.

**A percentage is a report, not a goal.** Chasing it pushes toward marking rows
DONE that are not built, which the ledger's own generator will downgrade.

---

## 11. Where everything is

| Path | What it holds |
|---|---|
| `AGENTS.md` | Mission, legal rules, layers, CI, definition of done. Read first. |
| `STATE.md` | Where the work is right now, in the required format. |
| `STATUS.md` | Snapshot, next actions, blockers, what needs review. |
| `PROGRESS.md` | Dated diary — what was found, what it meant, what follows. |
| `DECISIONS.md` | Decisions with a revisit condition each. |
| `docs/CHARTER.md` | Mission, legal rules, fidelity contract, definition of done. |
| `docs/requirements-from-operator.md` | R1–R9, the acceptance criteria. |
| `docs/gaps.md` | What is missing, unproven or assumed. |
| `docs/shell-architecture.md` | What the reference shell is, and what we take from it. |
| `docs/external-references.md` | Operator-supplied reference material. |
| `design/tokens.json` | Measured design tokens; the source of `ui-kit/tokens.css`. |
| `parity/ledger.csv` | The ledger. 172 rows. |
| `tools/xtask/ci.mjs` | The one command that runs everything. |

Commands:

```bash
npm install --ignore-scripts
node tools/xtask/ci.mjs        # layering, attribution, typecheck, unit, parity, package, e2e
npx vitest run                 # unit only
npx playwright test            # e2e only
node tools/xtask/parity-report.mjs
node apps/cli/bin/ow.mjs help
```
