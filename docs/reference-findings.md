# Reference findings

What was established by examining the operator-supplied builds, how, and what it
rules out. Everything here is evidence-backed; where something could not be
determined, it says so rather than estimating.

## Inputs examined

| Input | Version | SHA-256 (first 16) | Notes |
|---|---|---|---|
| `files.zip` → `Notion-7.38.1.msix` | 7.38.1 | verified against the brief | the originally supplied build |
| `all-notion-setups.zip` → `Notion-7.39.0.msix` | 7.39.0 | `4521c3714ce414e7` | newer build, supplied later |
| `files.zip` → `wordcraft-0.7.0.zip` | 0.7.0 | — | a separate, unrelated sample app |

Both MSIX packages are ZIP64 archives even at 170 MB, because .NET tooling emits
ZIP64 extensions unconditionally. `tools/extract-zip-member.mjs` handles that
rather than bailing: the central directory reports its offsets as `0xffffffff`
and carries the real values in the ZIP64 records.

## 7.39.0 static analysis

Run with `analyze_javascript_application` over the extracted `app.asar`
(13,466,133 bytes, SHA-256 `4521c371…`):

| Figure | 7.38.1 | 7.39.0 |
|---|---|---|
| Relevant files | 161 | 161 |
| Parsed JavaScript files | 98 | 98 |
| AST nodes visited | 2,345,987 | 2,354,625 |
| `BrowserWindow` constructions | 14 | 14 |
| contextBridge APIs | 20 | 20 |
| Exposed API members | 279 | **281** |
| IPC operations | 26 | 26 |
| Utility processes | 2 | 2 |

Two more exposed members and no structural change. This is a routine point
release of the shell.

## The central finding: there is no editor in the artifact

This is the single most important result of the whole analysis, and it decides
what can and cannot be verified.

The `.webpack/renderer/` tree of the shipped application contains exactly these
surfaces:

```
activity_monitor          meeting_notification_pill   tab_browser_view
client_placeholder       migration                    tabs
darkmode_placeholder     popup                        windows_and_tabs
internal_settings        speaker_and_microphone_status
sqlite_browser
```

Every one of them is application chrome: a system activity monitor, a settings
pane, a notification pill, microphone status, a SQLite browser, tab and window
management. Two names give the game away — `client_placeholder` and
`darkmode_placeholder` are the screens shown *while the remote interface loads*.
They are placeholders for a UI that is not in the package.

Corroborating measurements on the extracted 7.38.1 tree:

- **CSS / SCSS / LESS files: 0**
- **Font files (woff, woff2, ttf, otf): 0**

A page editor with no stylesheet and no typeface is not a page editor that has
been minified away; it is not present.

## What this rules out

**Spacing, type scale, and visual parity cannot be recovered from the supplied
builds.** Not "are hard to extract" — they are absent. Any tool pointed at these
files for that purpose, including the reverse-engineering tooling used here,
returns nothing because there is nothing to return. This is a property of the
input, not a limitation of the method.

The application is a thin Electron shell around a **remote** web interface. The
runtime fuses compound it: `RunAsNode` and `EnableNodeCliInspectArguments` are
both disabled, so the Inspector and `ELECTRON_RUN_AS_NODE` are unavailable, and
the UI that would render is served from a server rather than from disk. There is
no supported route to observing the reference interface running.

## Consequences for the parity ledger

Every behaviour row that depends on observing the reference stays `[HINT]`. That
is the honest state, and the ledger says so rather than claiming parity that was
never observed.

What *was* verifiable has been used:

- **Colours**, measured pixel-by-pixel from operator-supplied footage via
  `tools/measure-frame.mjs`. See `design/measurements.md`.
- **Behaviour**, from the operator-supplied published shortcut reference, which
  is documentation rather than observation — a weaker but real source. See
  `design/measurements.md` for the corrections it forced.

## One incidental confirmation

The 7.39.0 package ships `better-sqlite3` as an unpacked native module. This
project independently reached the same choice for the same reason: it is the
only SQLite binding that works across the Node versions in scope without a
native build step in the install path. Two unrelated codebases arriving at the
same dependency is weak evidence, but it is evidence.

## Still needed from the operator

Ranked by how much each unblocks:

1. **A native-resolution still of a page of blocks.** Video compression destroys
   glyph edges, so type size, line height and the content measure cannot be
   measured from the footage that exists. One 1:1 screenshot settles it.
2. **Database view screenshots** — a table with filters open, a board, and the
   property editor.
3. **A clean dark-mode frame.** The dark page background measured cleanly; the
   dark sidebar sample was contaminated by a video overlay.

None of these block further construction. They block *verification*, which is a
different thing and is tracked separately in `docs/gaps.md`.
