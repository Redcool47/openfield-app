# Third-party notices

Every direct dependency of this project, with the licence read from its own
`package.json` at the pinned version. The `attribution` CI task fails when a
declared dependency is missing from this file.

All licences below are MIT, Apache-2.0, ISC, BSD or MPL-2.0, and are used as
unmodified dependencies. No copyleft (GPL, AGPL, SSPL) and no commercially
licensed library is linked into this project.

## Runtime dependencies

| Package | Version | Licence | Purpose |
|---|---|---|---|
| `better-sqlite3` | 11.7.0 | MIT | Optional native SQLite driver. The built-in `node:sqlite` driver is preferred and no native build is required for the CLI or the test suite. |
| `katex` | 0.16.19 | MIT | Equation rendering. Not yet wired into the editor. |
| `prosemirror-commands` | 1.6.2 | MIT | Editor command primitives for the ProseMirror-based block editor. |
| `prosemirror-history` | 1.4.1 | MIT | Undo grouping primitives. The transaction layer is authoritative for document undo. |
| `prosemirror-inputrules` | 1.4.0 | MIT | Markdown shortcut / input rule triggering. |
| `prosemirror-keymap` | 1.2.2 | MIT | Keyboard chord dispatch. |
| `prosemirror-model` | 1.24.1 | MIT | Document schema primitives. |
| `prosemirror-state` | 1.6.2 → 1.4.3 | MIT | Editor state and selection primitives. |
| `prosemirror-transform` | 1.10.2 | MIT | Transform primitives. |
| `prosemirror-view` | 1.37.2 | MIT | Editor rendering and DOM synchronisation. |
| `react` | 18.3.1 | MIT | UI runtime for the desktop renderer. |
| `react-dom` | 18.3.1 | MIT | DOM renderer for React. |

ProseMirror is used because IME composition, selection, clipboard and undo are
brutally hard to get right from scratch, and these are MIT-licensed. The block
schema, the slash menu, block selection, the drag handles and the multi-block
operations are our own code on top of it.

## Development and build dependencies

| Package | Version | Licence | Purpose |
|---|---|---|---|
| `typescript` | 5.7.2 | Apache-2.0 | Compiler and type checker. |
| `vite` | 6.0.7 | MIT | Dev server and bundler. |
| `vitest` | 2.1.8 | MIT | Unit and scenario test runner. |
| `@vitejs/plugin-react` | 4.3.4 | MIT | React JSX transform for Vite. |
| `electron` | 33.3.1 | MIT | Desktop shell. Not yet used at runtime; declared ahead of the packaging spike. |
| `electron-builder` | 25.1.8 | MIT | Installer packaging. Not yet wired. |
| `eslint` | 9.17.0 | MIT | Linting. Not yet configured. |
| `jsdom` | 25.0.1 | MIT | DOM environment for tests, when needed. |
| `@types/node` | 22.10.2 | MIT | Node type definitions. |
| `@types/react` | 18.3.18 | MIT | React type definitions. |
| `@types/react-dom` | 18.3.5 | MIT | React DOM type definitions. |
| `playwright` | 1.64.1 | MIT | End-to-end testing of the Electron desktop app; drives the real renderer through its command bridge. |
| `@playwright/test` | 1.64.1 | MIT | Playwright test runner (same package family as `playwright`, recorded separately because it is a direct dependency). |

## Platform components redistributed inside a build

| Component | Licence | Note |
|---|---|---|
| Node.js | MIT | Inside Electron. |
| Chromium | BSD-3-Clause | Inside Electron. |
| SQLite | Public domain | Bundled by Node and by Electron. |

## Deliberately absent

- No analytics, telemetry or crash-reporting SDK.
- No font, icon or image package. The product ships no artwork yet; see
  `ATTRIBUTION.md`.
- No network client beyond Node's standard library, and the product makes no
  request at runtime.
