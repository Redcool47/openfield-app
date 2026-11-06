/**
 * The Electron main process.
 *
 * Security posture, and why each decision was made:
 *
 *  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The
 *    renderer is untrusted code from the model's point of view; it gets a
 *    narrow, typed bridge and nothing else.
 *  - The bridge exposes **only** `execute(commandId, args)`. There is no
 *    "call this SQL" or "mutate this block" escape hatch, because a bridge that
 *    can write arbitrary state is a bridge nobody can reason about later.
 *  - Every IPC call validates its sender. Without this, any frame that manages
 *    to load in the window can drive the command registry.
 *  - A strict CSP and no remote content. The app is local-first: it loads only
 *    its own bundled assets and makes no network request.
 *
 * The main process is the *only* place the model is touched. That is what makes
 * the whole application testable headlessly: the scenario tests drive the same
 * session the UI does, minus the window.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { AppState, PageAppearance, PageNode } from '../shared/view-model.js';
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Give this process its own Chromium profile directory when asked.
 *
 * Must happen before anything reads a path from `app`, and before ready.
 *
 * Without it every launch in a test run shares `%APPDATA%\Electron`, and the
 * suite ends in `electron.launch: WebSocket error: read ECONNRESET` -- one
 * launch's profile lock still held by a process that has not finished exiting
 * when the next one starts. The same sharing is why a preference written by an
 * earlier run was still in place for the next one: preferences live in
 * localStorage on the file:// origin, which is per-profile.
 *
 * Electron's own `--user-data-dir` switch is not honoured by this build, so it
 * is set here in the one place that does work.
 */
const profileOverride = process.env.OW_USER_DATA;
if (profileOverride && profileOverride.length > 0) {
  app.setPath('userData', profileOverride);
}

let mainWindow: BrowserWindow | null = null;
let repo: Repository | null = null;
let session: Session | null = null;
const registry = createRegistry();

/** Absolute path of the workspace folder. The user picks this in settings. */
function workspaceDir(): string {
  // `OW_WORKSPACE` exists because Electron's `--user-data-dir` is not honoured
  // in this build, so every test run was opening -- and writing to -- the real
  // workspace. Tests that share one accumulate each other's pages, and an
  // assertion like "there is exactly one block" then fails on the second run for
  // a reason that has nothing to do with the code under test.
  const override = process.env.OW_WORKSPACE;
  if (override && override.length > 0) return override;
  return join(app.getPath('userData'), 'workspace');
}

// ---------------------------------------------------------------- view model

/**
 * Flatten the page tree for the sidebar.
 *
 * Depth is computed here so the renderer never has to recurse, which keeps it
 * free of model traversal and means a future virtualised list can consume this
 * array directly.
 */
function pageTree(parentPage: string | null, depth = 0, out: PageNode[] = []): PageNode[] {
  if (!repo) return out;
  for (const page of repo.childPages(parentPage)) {
    out.push({
      id: page.id,
      title: page.title,
      icon: page.icon,
      parentPage: page.parentPage,
      isFavorite: page.isFavorite,
      hasChildren: page.hasChildren,
      depth,
    });
    pageTree(page.id, depth + 1, out);
  }
  return out;
}

/**
 * Page presentation, with the storage row's 0/1 integers turned back into
 * booleans.
 *
 * Written as one function so the defaults live in one place: `font` is a string
 * column that a fresh page has as '', and the renderer has to know that means
 * 'sans'. Defaulting in two places is how a page ends up with no font and a
 * renderer that believes it does.
 */
function appearanceOf(row: ReturnType<Repository['getPage']>): PageAppearance {
  return {
    cover: row?.cover ?? null,
    fullWidth: row?.full_width === 1,
    smallText: row?.small_text === 1,
    font: row?.font && row.font.length > 0 ? row.font : 'sans',
  };
}

/**
 * The application's own version.
 *
 * `app.getVersion()` answers with Electron's version when the main script is
 * run from `dist/` rather than from a packaged app, because there is no
 * app-level package.json beside it. In development the real one is two
 * directories up; when packaged it is inside the asar.
 */
function appVersion(): string {
  const candidates = [
    join(app.getAppPath(), 'package.json'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Try the next one.
    }
  }
  return app.getVersion();
}

function buildState(): AppState {
  if (!repo || !session) throw new Error('workspace is not open');

  // A page can be a database rather than a document. Both are rendered from the
  // same state object so the renderer asks one question -- "is there a
  // collection here?" -- instead of deciding from the page's shape, which it
  // cannot see.
  let database: AppState['database'] = null;
  if (session.pageId) {
    const collections = repo.databases.listCollections(session.pageId);
    const collection = collections[0];
    if (collection) {
      database = {
        collection,
        views: repo.databases.listViews(collection.id),
        // Flattened to plain rows: Maps do not survive structured cloning, and
        // the renderer has no reason to know the storage shape.
        rows: repo.databases.rows(collection.id).map(({ page, values }) => ({
          id: page.id,
          title: page.title,
          values: Object.fromEntries(values),
        })),
      };
    }
  }

  // The reverse question to the one above: not "does this page host a
  // collection" but "is it a row in one". Both are needed, and neither answers
  // the other -- a row page has no collection of its own.
  let rowOfView: AppState['rowOf'] = null;
  if (session.pageId) {
    const owner = repo.databases.collectionOfRow(session.pageId);
    if (owner) {
      rowOfView = {
        collection: owner,
        values: Object.fromEntries(repo.databases.valuesForPage(session.pageId)),
      };
    }
  }

  return {
    workspacePath: workspaceDir(),
    // The app's own version, for the settings panel.
    version: appVersion(),
    // Generated from the registry, not from the shortcut table. The table is
    // the thing that drifted: it declared chords with no command behind them,
    // and a cheat sheet built from it would advertise keys that do nothing.
    // Reading `keys` off each command means an entry exists only if the
    // command does.
    shortcuts: registry
      .all()
      .flatMap((c) =>
        // A command with no binding contributes no row at all. Listing it with a
        // blank key would be worse than omitting it.
        c.keys?.win ? [{ id: c.id, title: c.title, category: c.category, win: c.keys.win, mac: c.keys.mac ?? c.keys.win }] : [],
      ),
    rowOf: rowOfView,
    database,
    pages: pageTree(null),
    people: repo.people(),
    favorites: repo.favoritePages().map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      parentPage: p.parentPage,
      isFavorite: true,
      hasChildren: p.hasChildren,
      depth: 0,
    })),
    recents: repo.recentPages(8).map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      parentPage: p.parentPage,
      isFavorite: p.isFavorite,
      hasChildren: p.hasChildren,
      depth: 0,
    })),
    trashed: repo.trashedPages().map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      parentPage: p.parentPage,
      isFavorite: false,
      hasChildren: false,
      depth: 0,
    })),
    current: session.pageId
      ? {
          id: session.pageId,
          title: repo.getPage(session.pageId)?.title ?? '',
          rows: session.outline(),
          appearance: appearanceOf(repo.getPage(session.pageId)),
          locked: repo.getPage(session.pageId)?.locked === 1,
          updatedAt: repo.getPage(session.pageId)?.updated_at ?? 0,
        }
      : null,
    stats: repo.stats(),
    integrity: repo.selfTest(),
  };
}

function pushState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('ow:state', buildState());
  } catch (error) {
    console.error('failed to push state:', error);
  }
}

// --------------------------------------------------------------------- window

/**
 * Append a startup trace line when OW_TRACE names a file.
 *
 * Electron on Windows is a GUI-subsystem binary: its stderr goes nowhere useful
 * unless logging is switched on, and switching it on still loses main-process
 * output in some launch configurations. Diagnosing "the window never appears"
 * therefore needs a trace that does not depend on stdio at all.
 *
 * Off unless the environment variable is set, and the file is appended to rather
 * than truncated so successive launches accumulate into one timeline.
 */
function trace(message: string): void {
  const file = process.env.OW_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    // A trace that cannot be written must never take the app down with it.
  }
}

/**
 * Where the window was last left, or sensible defaults.
 *
 * Restoring without checking would open a window that has been dragged onto a
 * monitor which is no longer attached -- off-screen, unreachable, and the kind of
 * bug that gets reported as "the app won't start". Anything unparseable or
 * off-screen falls back to the defaults rather than throwing, because a bad
 * geometry file must never be the reason the app will not open.
 */
function restoredBounds(): { width: number; height: number; x?: number; y?: number } {
  const defaults = { width: 1280, height: 800 };
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'window.json'), 'utf8');
    const saved = JSON.parse(raw) as { width?: number; height?: number; x?: number; y?: number };
    if (typeof saved.width !== 'number' || typeof saved.height !== 'number') return defaults;
    const { width, height } = saved;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return { width, height };
    // Require some of the window to be reachable on an attached display.
    const visible = screen.getAllDisplays().some((d) =>
      saved.x! < d.workArea.x + d.workArea.width &&
      saved.x! + width > d.workArea.x &&
      saved.y! < d.workArea.y + d.workArea.height &&
      saved.y! + height > d.workArea.y,
    );
    return visible ? { width, height, x: saved.x, y: saved.y } : { width, height };
  } catch {
    // No file yet on first run, or a corrupt one. Either way, defaults.
    return defaults;
  }
}

/** Persist the window geometry so the next launch opens where this one was. */
function saveBounds(win: BrowserWindow): void {
  try {
    // A maximised window's restored bounds are the pre-maximise size, which is
    // what "where I left it" means -- so normalise first.
    if (win.isMaximized()) win.unmaximize();
    const bounds = win.getNormalBounds();
    writeFileSync(
      join(app.getPath('userData'), 'window.json'),
      JSON.stringify(bounds),
      'utf8',
    );
  } catch {
    // Losing a geometry file is not worth failing to quit over.
  }
}

async function createWindow(): Promise<void> {
  repo = await Repository.open(join(workspaceDir(), 'openfield.sqlite'));
  repo.ensureWorkspace('default', 'My workspace');

  // Open the most recently visited page so a relaunch lands where the user left
  // off rather than on an empty surface.
  const resume = repo.recentPages(1)[0] ?? repo.allPages()[0];
  session = new Session(repo, { autosaveMs: 400 });
  if (resume) session.openPage(resume.id);

  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 640,
    minHeight: 480,
    show: false,
    // Named here as well as embedded in the binary by `win.icon`. In development
    // the window is not the packaged .exe, so setting only the build config
    // leaves a dev window wearing Electron's default atom.
    icon: join(here, '../../build/icon.png'),
    backgroundColor: '#fdfdfc',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  // Paint only once there is something to show. A white flash on launch reads as
  // a broken app, and the reference shows a placeholder rather than nothing.
  //
  // Two events plus a timer, and any one of them is enough. Both events do fire
  // in practice -- `ready-to-show` arrives a few milliseconds after
  // `did-finish-load` -- so this is belt-and-braces rather than a fix for an
  // observed failure. It stays because the cost is a few lines and the
  // alternative is a window that never appears, which is the worst failure mode
  // an app has: worse than a window that appears one frame early.
  //
  // What this block did fix: a launcher that passes SW_HIDE in the process
  // startup info (`Start-Process -WindowStyle Hidden`, among others) makes the
  // window stay hidden even though show() succeeded. `show()` returning without
  // throwing proves nothing about visibility, so `trace()` exists to tell those
  // two situations apart.
  let shown = false;
  const show = (): void => {
    trace('show() entered');
    if (shown) {
      trace('show() already shown; returning');
      return;
    }
    if (!mainWindow) {
      trace('show() has no mainWindow; returning');
      return;
    }
    if (mainWindow.isDestroyed()) {
      trace('show() window destroyed; returning');
      return;
    }
    try {
      mainWindow.show();
      shown = true;
      trace('show() succeeded');
    } catch (error) {
      // Leave `shown` false so a later event can retry. A throw here must not
      // permanently disable showing, which is the failure this whole block
      // exists to prevent.
      trace(`show() threw: ${String(error)}`);
    }
  };
  const showTimer = setTimeout(show, 2000);
  trace(`showTimer armed; window id ${mainWindow.id}`);
  mainWindow.once('ready-to-show', () => trace('event: ready-to-show'));
  mainWindow.once('ready-to-show', show);
  mainWindow.webContents.once('did-finish-load', () => trace('event: did-finish-load'));
  mainWindow.webContents.once('did-finish-load', show);
  mainWindow.webContents.once('dom-ready', () => trace('event: dom-ready'));

  // Without these the failure is silent, which is how the packaged-build window
  // bug survived several launches before anyone noticed it.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[window] failed to load ${url}: ${description} (${code})`);
    show();
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[window] preload ${preloadPath} failed: ${error.message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[window] renderer gone: ${details.reason} (exit ${details.exitCode})`);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });

  const devServer = process.env.OW_DEV_SERVER;
  // Navigation guards are installed BEFORE the page loads, not after.
  //
  // This ordering is the point, not a style preference. `loadFile()` does not
  // reliably settle in the packaged build -- it neither resolved nor rejected,
  // which was found by tracing rather than by reading -- so anything placed
  // after the await is code that may never run. A window-open handler and a
  // navigation guard that might not be installed are not guards. Installing
  // them first makes them independent of the load completing.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.OW_DEV_SERVER
      ? url.startsWith(process.env.OW_DEV_SERVER)
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  try {
    if (process.env.OW_DEV_SERVER) {
      await mainWindow.loadURL(process.env.OW_DEV_SERVER);
    } else {
      await mainWindow.loadFile(join(here, '../renderer/index.html'));
    }
    trace('load settled: resolved');
  } catch (error) {
    trace(`load settled: rejected ${String(error)}`);
    // A failed load must still leave a window on screen with something in it,
    // rather than an invisible process the user cannot close.
    show();
  }

  // Geometry probe, for when a screenshot disagrees with what the CSS says it
  // should be. Screenshots lie about scale -- a window at 1280 device pixels on
  // a 200% display is a 640px CSS viewport -- and guessing which is wrong is how
  // a correct layout gets "fixed" into a broken one. Off unless OW_TRACE is set.
  if (process.env.OW_TRACE) {
    void mainWindow.webContents
      .executeJavaScript(
        `JSON.stringify({
           dpr: window.devicePixelRatio,
           inner: [window.innerWidth, window.innerHeight],
           chain: ['.ow-app','.ow-sidebar','.ow-main','.ow-page-scroll','.ow-page','.ow-blocks']
             .map(s => {
               const e = document.querySelector(s);
               if (!e) return { s, missing: true };
               const b = e.getBoundingClientRect();
               const c = getComputedStyle(e);
               return { s, left: Math.round(b.left), w: Math.round(b.width),
                 display: c.display, flex: c.flex, maxW: c.maxWidth,
                 alignSelf: c.alignSelf, width: c.width, minW: c.minWidth,
                 parent: e.parentElement ? e.parentElement.className : null };
             })
         })`,
        true,
      )
      .then((json) => trace(`geometry ${json as string}`))
      .catch((error: unknown) => trace(`geometry probe failed: ${String(error)}`));
  }

  mainWindow.on('close', () => {
    // Saved on close rather than on every move, which would write a file per
    // pixel of a drag.
    saveBounds(mainWindow!);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ------------------------------------------------------------------------ ipc

/**
 * Reject any IPC from a frame that is not our own window.
 *
 * Cheap, and it closes the obvious hole: without it, a frame that somehow
 * navigated into our window could drive the command registry.
 */
function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow) return false;
  const url = event.senderFrame?.url ?? '';
  const devServer = process.env.OW_DEV_SERVER;
  return devServer ? url.startsWith(devServer) : url.startsWith('file://');
}

function registerIpc(): void {
  ipcMain.handle('ow:state', (event) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    return buildState();
  });

  ipcMain.handle('ow:execute', async (event, payload: unknown) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    if (!session) throw new Error('workspace is not open');

    // The renderer sends an id and an argument object, never a function or a
    // prototype-bearing value. Validate the shape before it reaches the
    // registry so a malformed message cannot exploit argument handling.
    const { id, args } = (payload ?? {}) as { id?: unknown; args?: unknown };
    if (typeof id !== 'string') throw new Error('command id must be a string');
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new Error('command args must be an object');
    }

    const result = await runCommand(id, (args ?? {}) as Record<string, unknown>, {
      session,
      registry,
      soft: true,
    });
    pushState();
    return result;
  });
}

// --------------------------------------------------------------------- boot

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    registerIpc();
    try {
      await createWindow();
    } catch (error) {
      // A failure to open the workspace must be visible, not a silent hang.
      console.error('failed to create window:', error);
      app.quit();
      return;
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    try {
      session?.dispose();
      repo?.close();
    } catch {
      // Nothing useful to do while shutting down.
    }
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    try {
      session?.dispose();
      repo?.close();
    } catch {
      // Ignore: the process is exiting.
    }
  });
}
