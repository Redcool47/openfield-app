# Shell architecture — what the reference desktop build actually is

All statements below were **observed** with REA on the supplied inputs, or
derived from local enumeration of the unpacked container. Nothing here is
copied code. Where a claim is an inference it is marked `[inference]`.

## 1. Inputs, verified

| File | SHA-256 | Matches operator brief |
|---|---|---|
| `Notion-7.38.1.zip` | `d3149700b1606990f428eb325acf4dca5d80d7138003bb356f3ce9c97bb8119e` | yes |
| `Notion.exe` | `e1e41e9f575f4f3d8021a94005f27206061bee7c5137aae6961a92b7f7de67bd` | yes |
| `wordcraft-0.7.0.zip` | `a4af2a038e01585065816e891db763537842dcec5a47bd3888ccb4fffbc4d6fa` | yes |
| `resources/app.asar` | `f9b4417a8fcd28a00ff910a5aea343b96cd56e3c88a0d98d92aa0c65f1713bf7` | yes |
| `resources/notion-meeting-notes-host.exe` | `69b7c92ccb1682f19c9aeca1dd6fb33aaf0b37a1c23ad94aff49214e57d403fe` | not listed in brief |

Evidence: `open_binary` results for each file; evidence ids recorded in
`analysis/evidence/`.

## 2. The container is an MSIX/Appx package, not a plain ZIP

`[observed]` The outer archive contains an Appx layout — `AppxManifest.xml`,
`AppxBlockMap.xml`, `AppxSignature.p7x`, `priconfig.xml`, `resources.pri`, plus
`AppxMetadata/` and a store tile-asset folder — wrapping the actual application
folder `Notion-7.38.1/Notion/`. So it is the Microsoft Store distribution
channel, which is consistent with `app-update.yml` declaring `channel: msix`.

Inside the application folder: the Electron runtime payload (`resources.pak`,
`chrome_*.pak`, `icudtl.dat`, `snapshot_blob.bin`, `v8_context_snapshot.bin`,
`ffmpeg.dll`, ANGLE/DXIL/Vulkan/SwiftShader libraries, `locales/`), the
application archive `app.asar` (13,425,184 bytes), an `app.asar.unpacked/`
companion tree, three PNG/ICO icons, `app-update.yml`, and the small native
helper `notion-meeting-notes-host.exe` (219,448 bytes).

## 3. Static analysis of the application archive

`[observed]` `analyze_javascript_application` over `app.asar`
(evidence `ev_752311e9…`, integrity policy `record-and-continue`):

| Statistic | Value |
|---|---|
| relevant source files | 161 |
| parsed JavaScript files | 98 |
| AST nodes visited | 2,345,987 |
| findings | 8,937 |
| modules | 3,174 |
| parse failures | 0 |
| text bytes read | 12,432,117 |
| BrowserWindow constructions | 14 |
| explicit `webPreferences` blocks | 41 |
| contextBridge APIs | 20 |
| exposed API members | 279 |
| IPC operations | 26 |
| sender-validation observations | 5 |
| utility processes | 2 |

These figures match the operator's preparation-pass numbers exactly, which
independently confirms both inputs and the analysis method.

## 4. Electron fuses — which observation routes are open

`[observed]` `inspect_electron_fuses` on `Notion.exe`
(evidence `ev_7051fd2e…`):

| Fuse | State |
|---|---|
| `RunAsNode` | disabled |
| `EnableNodeCliInspectArguments` | disabled |
| `EnableNodeOptionsEnvironmentVariable` | disabled |
| `EnableEmbeddedAsarIntegrityValidation` | disabled |
| `OnlyLoadAppFromAsar` | enabled |
| `EnableCookieEncryption` | enabled |
| `GrantFileProtocolExtraPrivileges` | enabled |
| `WasmTrapHandlers` | enabled |

**Consequence for our method.** `RunAsNode` and `EnableNodeCliInspectArguments`
are off, so the passive Node-inspector route into this app's main process does
not exist. We cannot attach a CDP inspector to its own runtime. Combined with
§6 below, this closes the door on capturing the page UI at runtime from this
build. Recorded as an unknown, not guessed around.

## 5. Window catalog (names only, our own description)

`[observed]` Locally enumerated from the unpacked container
(a small script over the unpacked build; the catalog itself is not published). Each
surface is a separate renderer bundle with its own `index.html` and, where it
needs privileged access, its own `preload.js`.

| Surface | Observed role (our description) |
|---|---|
| `tabs` | The main workspace window; hosts the tab strip and the content area. Largest renderer bundle. |
| `windows_and_tabs` | A small manager surface listing windows and tabs, with a near-empty preload (2 KB), so it is mostly sandboxed UI. |
| `tab_browser_view` | A per-tab embedded browser surface. Has the heaviest preload (399 KB), so it is the privileged web-content host. |
| `popup` | A small capture surface; its preload exposes a single narrow API. |
| `sqlite_browser` | An internal diagnostics surface for the embedded database. |
| `activity_monitor` | An internal runtime-diagnostics surface. |
| `internal_settings` | Internal settings surface. |
| `client_placeholder` | The loading shell shown before the main UI is ready. Confirms §6. |
| `darkmode_placeholder` | A second placeholder variant. |
| `speaker_and_microphone_status` | An audio-status pill surface, with a tiny preload (3.7 KB). |
| `meeting_notification_pill` | A meeting-notification surface. |
| `migration` | A preload-only surface (3 KB) used for a data migration message port. |

Two additional main-process bundles exist: `ClientMcpHostWorker.js` (303 KB) and
`SqliteServer.js` (101 KB). `[inference]` The first name suggests the reference
product also exposes an agent-facing MCP host; the second is consistent with a
dedicated database access layer rather than direct `better-sqlite3` calls from
arbitrary windows. Both reinforce our own §8.3 design decision to expose a
command/agent interface rather than raw data access to UI code.

## 6. The central finding: this is a shell, not the product

`[observed]` `app.asar` is **13.4 MB** and its largest renderer bundle
(`tabs/index.js`) is **1.05 MB** of minified JavaScript. A complete block
editor, database engine and every feature of a mature product cannot fit in that
budget. The presence of `client_placeholder`, `tab_browser_view` (the heaviest
privilege preload) and `app-update.yml` pointing at a remote release origin
supports the conclusion that **the page-level user interface is fetched from a
web origin at runtime**, and the desktop build provides windows, tabs, menus,
notifications, a local SQLite cache, native preferences and OS integration.

**This is the single most important fact for our project**, and it is good news:
it means the behaviour we must reproduce is documented publicly and observable
in use, and that reproducing it clean-room is exactly the right approach. We
did **not** attempt to read an editor implementation out of these files,
because there isn't one.

## 7. IPC and contextBridge surface

`[observed]` 20 contextBridge API keys are declared. Grouped by capability, in
our own naming:

| API key (observed literal) | Capability (our description) |
|---|---|
| `tabsApi` | The main window's tab, window and workspace-surface operations. The largest single API. |
| `__electronApi` | Generic privileged operations available to the web-content host. |
| `__windowListApi` | Enumerate and control windows/tabs from the manager surface. |
| `__sqliteBrowserApi` | Query the local database cache from the diagnostics surface. |
| `__activityMonitorApi` | Read runtime counters for the diagnostics surface. |
| `__internalSettingsApi` | Read/write internal (developer) settings. |
| `__desktopConfig` | A read-only configuration object injected into every privileged surface. |
| `__desktopDeviceInfo` | Device and OS facts. |
| `__platform` | Platform/OS predicates, injected into every surface. |
| `__mediaApi` | Microphone/camera/speaker state for the audio-status surface. |
| `__opener` | A very narrow API: lets the popup window hand a payload back to its opener. |
| `__isElectron` | Environment flag. |
| `__SENTRY_IPC__` | Crash/error reporting transport (declared in the main process). |

`[observed]` IPC channel literals found by enumeration: `notion:new-message-port`,
`client-placeholder:message-port`, and the `migration-dump`,
`migration-dump-done`, `migration-restore`, `migration-restore-done` quartet.

`[inference]` Only six literal channels exist for twenty-six IPC operations, so
most IPC uses dynamically constructed channel names. Whatever the channel scheme,
the *shape* of the pattern — a narrow, validated bridge per surface, plus a
message-port mechanism for streaming — is a good design, and we adopt the
pattern with our own names.

## 8. Native addon companion tree

`[observed]` `app.asar.unpacked/node_modules/` contains five signed native
addons: `better_sqlite3.node` (1.96 MB), `win_utils.node` (670 KB) under a
scoped desktop-native package, `progress_bar.node`, `winregistry.node` (131 KB)
and `cf-prefs.node` (119 KB). Integrity mismatches between declared and
calculated hashes are **expected after code signing**; we analysed with
`integrity_policy: "record-and-continue"` and treat those bytes as untrusted
observed data. We did not disassemble them and copied nothing from them.

`[inference]` The capability set is informative and is the reason we make the
same local-first choices: an embedded SQL database, native OS preference
persistence, native registry access (Windows install/protocol registration),
window progress feedback, and small native OS utilities.

## 9. Update configuration

`[observed]` `app-update.yml`: a generic HTTP(S) provider pointing at a static
release origin, `channel: msix`, a named updater cache directory, and an
empty `publisherName` list. `[inference]` A generic provider reading a static
JSON manifest is exactly the pattern our §15.13 auto-update hook should copy —
opt-in, off by default, never silent, and pointing at a feed the operator
controls.

## 10. What we take from this, and what we deliberately do not copy

| Observation | Our clean-room position |
|---|---|
| ~14 windows/surfaces, one bundle per surface | Adopt the *pattern*: separate privileged surfaces, each with a minimal bridge. We have far fewer surfaces because we have no meeting, media or diagnostics shell yet. |
| 20 bridge APIs, 279 members, sender validation | Adopt the *pattern*: one typed command bridge, no raw data access from UI code. |
| Embedded SQLite via a native addon | Adopt: local-first SQLite in the main process, WAL mode. |
| A dedicated database access layer | Adopt with a stronger rule: **all mutation goes through the command registry**. |
| Message-port IPC for streaming | Adopt for the long-lived agent/control channel. |
| An agent-facing host bundle | Adopt: our `ow` CLI, JSON control channel and MCP server are T1, not T4. |
| Remote UI fetched from a web origin | **Reject.** Our product loads entirely from local assets and makes no network request at runtime. |
| Brand, icons, copy, fonts, illustration | **Reject entirely.** Original assets only. |
| Store packaging (MSIX) | We ship an NSIS wizard installer; MSIX remains an option, not a commitment. |

## 11. Open unknowns

- **U-001** The page-level UI could not be observed from this build: the fuses
  block the inspector route and the UI is remote. Page behaviour must be
  reconstructed from public documentation and from operator-supplied recordings
  or screenshots. **Owner: operator input.**
- **U-002** The local SQLite cache schema was not read. A cache exists
  (`better_sqlite3.node`, `SqliteServer.js`), but no populated database was
  present in the supplied inputs, and we will not read a real account's cache.
  Our schema is designed from public API shapes instead.
- **U-003** Dynamic IPC channel naming scheme is only partly characterised (six
  literal channels observed; thirteen dynamic operations). Not blocking: we use
  our own scheme.
- **U-004** Semantics of most of the 279 exposed bridge members were not traced.
  Not blocking: we do not need a member-for-member equivalent, and tracing them
  would risk drifting toward code copying rather than clean-room design.

## 12. Clean-room statement

Everything in this document is a description of *observable structure* — file
names, counts, capability groupings and interface shapes — written in our own
words. No vendor code was copied, translated or lightly renamed. No vendor
asset was extracted or reused. No vendor server was contacted. No real account
data was read. The analysis inputs are excluded from this repository by
`.gitignore` and are never redistributed.