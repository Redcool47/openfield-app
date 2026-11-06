# Handoff

State as of the end of the first working session. A fresh agent should be able
to continue from `AGENTS.md`, `STATE.md` and this file without reading anything
else.

## Where things are

| Phase | Status |
|---|---|
| 0 Charter, skeleton | **done** — `docs/CHARTER.md`, `AGENTS.md`, repo skeleton |
| 1 Inventory | **done** - all three input hashes verified; the catalog itself is not published |
| 2 Static shell analysis | **done** — `docs/shell-architecture.md`, fuses, window/IPC catalogue |
| 3 Runtime observation | **blocked, permanently** — see below |
| 4 Behaviour catalogue | **done as `[HINT]`** — `parity/ledger.csv`, 172 rows |
| 5 Specs and ADRs | **partly done** — architecture documented inline in code comments and `docs/shell-architecture.md`; ADR files not yet split out |
| 6 Design tokens | **not started** — blocked on Phase 3 |
| 7 Build slices | **Slice 0 and Slice 1's headless half done**; no UI at all |
| 8 Parity harness | **partly done** — 11 headless scenario tests exist; no screenshots |
| 9 Packaging | **not started** — `electron-builder` installed, CI step gated |
| 10 Docs and honesty | **done** — `docs/gaps.md`, `README.md`, generated parity report |

## What is built and passing

- `packages/geom` — UUIDv7 ids, fractional sibling ordering.
- `packages/model` — rich text, block registry, block tree, transactions with
  snapshot undo, editing operations, three-level selection model.
- `packages/storage` — SQLite driver adapter, schema v1, forward-only
  migrations, FTS5 search with ranking, recursive-CTE trash/restore/purge,
  startup integrity self-test.
- `packages/commands` — the command registry, the session, ~50 commands.
- `apps/cli` — the `ow` command line.
- `tools/xtask` — layering, attribution, parity report, CI.

`node tools/xtask/ci.mjs` passes: layering, attribution, typecheck, 104 tests,
parity report.

## What is NOT built

**There is no graphical application.** `apps/desktop`, `packages/ui-kit`,
`packages/editor-ui` and `packages/app-ui` do not exist. Nothing renders a
window, so there are no Playwright tests and no screenshots either.

Databases are schema only — no property engine, no filters, sorts, groups or
views. Import/export is Markdown-export only. No MCP server, no control channel,
no installer. Full list and prioritisation in `docs/gaps.md`.

## Why Phase 3 is permanently blocked

Two findings, both verified with REA and recorded in
`docs/shell-architecture.md`:

1. The reference desktop build is a **thin Electron shell**. `app.asar` is
   13.4 MB and the largest renderer bundle is 1.05 MB — not enough to contain a
   block editor and database engine. The page UI is fetched from a web origin at
   runtime. **The editor source is not in the supplied files.**
2. The Electron fuses `RunAsNode` and `EnableNodeCliInspectArguments` are both
   **disabled**, so there is no passive inspector route into its runtime.

So the reference page UI cannot be observed from these inputs. Do not spend
budget retrying it. Behaviour comes from public documentation, which is why
every behaviour row in the ledger is tagged `HINT`.

## What to do next, in priority order

### 1. Build the renderer (the real bottleneck)

This unblocks the largest share of the ledger and the two unmet gate items.
Suggested order:

1. `packages/ui-kit` — tokens, then menu, popover, tooltip, dialog, toast.
   Establish `design/tokens.json` from the published type and spacing scale, and
   record the reasoning in `design/measurements.md`. Mark the numbers
   `approximate` until recordings arrive.
2. `apps/desktop` — Electron main, preload with a **narrow typed bridge that
   calls the command registry and nothing else**, one window, no node
   integration, context isolation on, sandbox on, strict CSP. Prove
   `contextIsolation` and the bridge surface before adding any feature.
3. `packages/app-ui` — sidebar tree first (it exercises nesting, favourites,
   trash and the row menu including "Move to trash" without opening the page).
4. `packages/editor-ui` — ProseMirror integration, block handles, slash menu
   generated from the registry, the three-level selection.
5. Database views.
6. First screenshot harness, then Playwright end-to-end.

The command registry already exposes everything the UI needs. Do not add a
second path into the model.

### 2. Get the packaging spike done

The previous attempt lost this at the last minute and the brief warns about it
explicitly. `electron-builder` is installed. As soon as an `apps/desktop` main
process exists, add an NSIS target with `oneClick: false`, `allowToChangeChoiceDirectory: true`
and a licence page, and get it green before adding features.

### 3. Ask the operator for the recordings

One batched request; the exact list is in `docs/gaps.md` section 4. Without
these, fidelity claims stay `[HINT]` and the measured-comparison work in the
fidelity contract cannot start.

## Gotchas that will bite you again

- **Never mix a `Content` object with a bare runs array** in this codebase.
  `textOf`, `setContent`, `normalizeContent` and `insert` accept both on purpose.
  Mixing them produced `{ runs: undefined }`, which failed deep inside text
  extraction with no visible link to the cause.
- **`TxContext.touch` must be called with the id even when you just created it.**
  It detects creation from the id set captured at transaction open, so
  `insert(); touch(id)` is correct and records `before = null`.
- **`node:sqlite` must be loaded via `createRequire`,** never
  `await import('node:sqlite')`. Vite rewrites the dynamic import and tries to
  resolve a package literally named `sqlite`.
- **The resolver hook returns `format: 'module-typescript'`,** not `module`, or
  Node hands raw TypeScript to the JavaScript parser.
- **Never emit compiled `.js` beside the `.ts` sources.** Stale output shadows
  the source and Node loads it instead. `tsconfig` uses `noEmit`.
- **PowerShell mangles quotes in native arguments.** Use `--script file.json` for
  anything with a JSON payload.
- **`tsc -b` must not be run against a config without `noEmit`,** or it will
  scatter `.js` files through `packages/`.
- **CI launches tools as `node <entry-point>`,** not through `npx` or a `.bin`
  shim, because spawning a `.cmd` on Windows requires a shell and reintroduces
  quoting bugs.
- **The workspace root contains unrelated projects.** `launch-teaser/`,
  `lumira-reel/` and an extracted `open-workspace/` belong to other work and are
  gitignored. Do not `git add` them.
- **`pnpm` is not installed here.** The project uses npm workspaces.

## Commands

```bash
npm install --ignore-scripts
node tools/xtask/ci.mjs
npx vitest run
node apps/cli/bin/ow.mjs help
```

## Files worth reading first

1. `docs/shell-architecture.md` — what the reference is, and why Phase 3 is blocked.
2. `docs/gaps.md` — the honest gap list.
3. `packages/model/src/transaction.ts` — why undo is snapshot-based.
4. `packages/geom/src/fractional.ts` — the two ordering bugs the tests caught.
5. `packages/commands/src/registry.ts` — the spine of the whole design.