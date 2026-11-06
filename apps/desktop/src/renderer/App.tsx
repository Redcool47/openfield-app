/**
 * The renderer.
 *
 * Two rules this file follows without exception:
 *
 *  1. **The renderer never touches the model.** It has no database handle, no
 *     block objects and no tree-walking code. It receives a flat view model from
 *     the main process and sends command ids back. Everything it displays came
 *     from a command or from a read.
 *  2. **Every mutation goes through `run(commandId, args)`.** There is no local
 *     optimistic state to drift out of sync with the main process, because the
 *     main process pushes a fresh view model after every command.
 *
 * The consequence is that this component set is as testable as the CLI: a
 * scenario is a list of command ids and assertions on the resulting view model.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon, Menu, Tooltip, ToastRegion, type MenuItemSpec, type ToastSpec } from '@ow/ui-kit';
import { SettingsDialog, type SettingsSection } from './settings.js';
import { AiBubble } from './ai-chat.js';
import { BlockEditor } from './editor.js';
import type { AppState, PageNode } from '../shared/view-model.js';
import { Cell, DatabaseTable, type DbValue } from './table.js';
import { HistoryPanel } from './history-panel.js';
import { QuickFind } from './quick-find.js';
import {
  ACCENTS,
  appearanceVars,
  getPreferences,
  resolveTheme,
  setPreferences,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  subscribe,
  type Preferences,
  type ThemePreference,
} from './preferences.js';

// ------------------------------------------------------------------- bridge

interface BlockRow {
  id: string;
  type: string;
  text: string;
  depth: number;
  hiddenChildren: number;
  checked: boolean;
  collapsed: boolean;
  hasChildren: boolean;
}



/**
 * The shape the preload returns from `execute`.
 *
 * `id` and `value` matter and were previously missing here: the editor reads
 * `value` to learn the id of a block it has just created, so a type that omits
 * it turns "create a block and put the caret in it" into an untyped guess.
 */
interface ExecuteResult {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

declare global {
  interface Window {
    ow: {
      execute(commandId: string, args?: Record<string, unknown>): Promise<ExecuteResult>;
      state(): Promise<AppState>;
      onState(handler: (state: AppState) => void): () => void;
    };
  }
}

const EMPTY: AppState = {
  workspacePath: '',
  version: '',
  shortcuts: [],
  database: null,
  rowOf: null,
  pages: [],
  people: [],
  favorites: [],
  recents: [],
  trashed: [],
  current: null,
  stats: { pages: 0, blocks: 0, ftsRows: 0, dbBytes: 0 },
  integrity: { ok: true, repaired: [], problems: [] },
};

// ---------------------------------------------------------------------- app

export function App() {
  const [state, setState] = useState<AppState>(EMPTY);
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const pageMenuAnchor = useRef<HTMLButtonElement | null>(null);
  const nextToastId = useRef(0);

  const toast = useCallback((message: string, action?: ToastSpec['action']) => {
    const id = `t${(nextToastId.current += 1)}`;
    setToasts((prev) => [...prev, { id, message, action }]);
    // Errors stay until dismissed; confirmations fade, because the window is
    // already visually busy and the toast is not the thing to look at.
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const run = useCallback(
    async (id: string, args?: Record<string, unknown>) => {
      const result = await window.ow.execute(id, args);
      if (!result.ok) toast(result.error ?? 'Command failed', undefined);
      // A successful open is navigation, and this is the one place every open
      // passes through -- the sidebar, the database, quick find, and any future
      // entry point all call `run`. Recording at the call sites instead would
      // leave whichever one was written last silently untracked, which is exactly
      // the bug that shows up as a Back button that does nothing.
      //
      // `navigate` does not go through `run`, so walking the trail does not
      // append to it.
      if (id === 'page.open' && result.ok) {
        const pageId = (args as { id?: string } | undefined)?.id;
        if (pageId && trailRef.current[atRef.current] !== pageId) {
          trailRef.current = trailRef.current.slice(0, atRef.current + 1);
          trailRef.current.push(pageId);
          atRef.current = trailRef.current.length - 1;
          setNav({ back: atRef.current > 0, forward: atRef.current < trailRef.current.length - 1 });
        }
      }
      return result;
    },
    [toast],
  );

  /**
   * Back and forward.
   *
   * The trail is ids, not page objects: navigation only ever needs to say
   * "open this", and holding titles would mean refreshing the list every time a
   * title changed. The renderer owns it rather than the session because it is a
   * property of this window's browsing, not of the document.
   */
  const trailRef = useRef<string[]>([]);
  const atRef = useRef(-1);

  const syncNav = useCallback(() => {
    setNav({ back: atRef.current > 0, forward: atRef.current < trailRef.current.length - 1 });
  }, []);

  const openPage = useCallback(
    (id: string) => {
      // Opening the page already at the cursor is not navigation: pushing it would
      // make Back look like it did nothing while the page stayed put.
      if (trailRef.current[atRef.current] !== id) {
        trailRef.current = trailRef.current.slice(0, atRef.current + 1);
        trailRef.current.push(id);
        atRef.current = trailRef.current.length - 1;
        syncNav();
      }
      void run('page.open', { id });
    },
    [run, syncNav],
  );

  const navigate = useCallback(
    async (delta: -1 | 1) => {
      const id = trailRef.current[atRef.current + delta];
      if (!id) return;
      atRef.current += delta;
      syncNav();
      // The raw bridge, not `run`: `run` records a successful open as navigation,
      // and walking the trail is the inverse of that, not a new entry. Going
      // through `run` here would push every step and make Back undo itself.
      const result = await window.ow.execute('page.open', { id });
      if (!result.ok) toast(result.error ?? 'Command failed', undefined);
    },
    [syncNav, toast],
  );

  useEffect(() => {
    let off = () => {};
    void window.ow.state().then((next) => {
      setState(next);
      off = window.ow.onState(setState);
    });
    return () => off();
  }, []);

  // The theme, resolved from the stored preference.
  //
  // `useSyncExternalStore` rather than a useEffect that subscribes, so the first
  // paint already has the right theme. An effect runs after the browser has
  // already painted the default, which produces a visible flash from light to
  // dark on every launch for anyone who chose dark -- the window would arrive
  // wrong and then correct itself.
  const preferences = useSyncExternalStore(subscribe, getPreferences);
  const systemDark = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
      },
      [],
    ),
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => false,
  );

  useEffect(() => {
    const resolved = resolveTheme(preferences.theme, { matches: systemDark });
    document.documentElement.setAttribute('data-theme', resolved);
  }, [preferences.theme, systemDark]);

  // Text size, width, accent and zoom all ride on CSS custom properties.
  // setProperty rather than `el.style.x = ...` because the names contain `--`.
  useEffect(() => {
    const root = document.documentElement.style;
    for (const [key, value] of Object.entries(appearanceVars(preferences))) {
      root.setProperty(key, value);
    }
    // Zoom multiplies the root font size so every rem-derived size moves
    // together. A CSS transform would scale pixels instead, which blurs text
    // and leaves scrollbars and hit-testing at the wrong size.
    root.fontSize = `${16 * (preferences.zoom / 100)}px`;
  }, [preferences]);

  // Dark, when the preference says so and the machine is dark. Used only to pick
  // which icon the toggle shows, and derived rather than stored so it cannot
  // disagree with what is actually on screen.
  const showingDark = resolveTheme(preferences.theme, { matches: systemDark }) === 'dark';

  // Resizing is a live drag rather than a value committed on mouseup: the sidebar
  // is the thing being dragged, so it has to move with the pointer. Held in
  // local state during the drag and written once at the end, because
  // setPreferences hits localStorage on every call.
  const [sidebarWidth, setSidebarWidthState] = useState(preferences.sidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const resizing = useRef(false);

  // The people directory, keyed by id, for rendering person properties by name.
  const peopleById = useMemo(
    () => Object.fromEntries(state.people.map((p) => [p.id, p])),
    [state.people],
  );

  const pageMenuItems: MenuItemSpec[] = useMemo(() => {
    const appearance = state.current?.appearance;
    if (!state.current || !appearance) return [];
    const set = (patch: Record<string, unknown>) =>
      void run('page.appearance.set', { id: state.current!.id, ...patch });
    // Each item states the state it turns ON, not the toggle's current value.
    // "Full width" with no tick is ambiguous; "Switch to narrow" is not.
    return [
      {
        key: 'width',
        label: appearance.fullWidth ? 'Use narrow width' : 'Full width',
        icon: <Icon name="page" />,
        onSelect: () => set({ fullWidth: !appearance.fullWidth }),
      },
      {
        key: 'small',
        label: appearance.smallText ? 'Normal text size' : 'Small text',
        icon: <Icon name="text" />,
        onSelect: () => set({ smallText: !appearance.smallText }),
      },
      { key: 'sep1', label: '', disabled: true, onSelect: () => {} },
      {
        key: 'font-sans',
        label: appearance.font === 'sans' ? '✓ Sans serif' : 'Sans serif',
        icon: <Icon name="text" />,
        onSelect: () => set({ font: 'sans' }),
      },
      {
        key: 'font-serif',
        label: appearance.font === 'serif' ? '✓ Serif' : 'Serif',
        icon: <Icon name="text" />,
        onSelect: () => set({ font: 'serif' }),
      },
      {
        key: 'font-mono',
        label: appearance.font === 'mono' ? '✓ Monospace' : 'Monospace',
        icon: <Icon name="code" />,
        onSelect: () => set({ font: 'mono' }),
      },
      { key: 'sep2', label: '', disabled: true, onSelect: () => {} },
      {
        key: 'history',
        label: 'Version history',
        icon: <Icon name="undo" />,
        onSelect: () => setShowHistory(true),
      },
      {
        key: 'cover',
        label: appearance.cover ? 'Remove cover' : 'Add cover',
        icon: <Icon name="image" />,
        onSelect: () => set({ cover: appearance.cover ?? '' }),
      },
    ];
  }, [state.current, run]);

  const setSidebarWidth = useCallback((width: number) => {
    setSidebarWidthState(width);
    setPreferences({ sidebarWidth: width });
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizing.current) return;
      setSidebarWidthState(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, event.clientX)));
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.classList.remove('ow-resizing');
      // One write at the end rather than one per pointermove.
      setPreferences({ sidebarWidth: sidebarWidthRef.current });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    // A toggle, not a cycle. 'system' is reachable from the menu rather than by
    // pressing the shortcut again: a three-state cycle means the button does
    // something different each time, and nobody can predict where it stops.
    setPreferences({ theme: showingDark ? 'light' : 'dark' });
  }, [showingDark]);

  // App-level shortcuts. Registered once, dispatched by command id so there is
  // one implementation of each behaviour regardless of which key triggered it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        setFindOpen(true);
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        void run('page.create', { title: '' }).then((r) => {
          if (r.ok) {
            const v = r.value as { id?: string } | undefined;
            if (typeof v?.id === 'string') openPage(v.id);
          }
        });
      } else if (key === '\\') {
        event.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        void run('history.redo');
      } else if (key === 'z') {
        event.preventDefault();
        void run('history.undo');
      } else if (key === 'y') {
        // Redo under its Windows spelling as well. This listener is the single
        // owner of undo and redo -- the block editor deliberately does not also
        // handle them, because two owners meant one Ctrl+Z undid twice.
        event.preventDefault();
        void run('history.redo');
      } else if (key === 'l' && event.shiftKey) {
        // Ctrl+Shift+L was declared in the shortcut table from the start and had
        // nothing behind it: pressing it did nothing at all. A shortcut listed in
        // a cheat sheet that silently does nothing is worse than no shortcut,
        // because it reads as a broken app rather than an unfinished one.
        event.preventDefault();
        toggleTheme();
      } else if (key === '[') {
        // Back and forward, on the keys every browser reserves for them. Ctrl+[ is
        // Alt+Left on Windows, and using both spellings means the one the user
        // reaches for is the one that works.
        event.preventDefault();
        void navigate(-1);
      } else if (key === ']') {
        event.preventDefault();
        void navigate(1);
      } else if (key === 'arrowleft' && event.altKey) {
        event.preventDefault();
        void navigate(-1);
      } else if (key === 'arrowright' && event.altKey) {
        event.preventDefault();
        void navigate(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run, state.pages, toggleTheme, navigate]);

  return (
    <div className="ow-app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      {sidebarOpen && (
        <Sidebar
          state={state}
          run={run}
          toast={toast}
          onClose={() => setSidebarOpen(false)}
          width={sidebarWidth}
          onResizeStart={() => {
            resizing.current = true;
            document.body.classList.add('ow-resizing');
          }}
          theme={preferences.theme}
          onThemeChange={(next) => setPreferences({ theme: next })}
          onNavigate={openPage}
          prefs={preferences}
          setPrefs={setPreferences}
        />
      )}
      <main className="ow-main">
        {/* The AI bubble, bottom left. It only appears when AI is on with a key
            of the user's own, or when the debug mode is on and they want to
            look at it. */}
        <AiBubble
          run={run}
          debug={preferences.debug}
          onOpenAiSettings={() => window.dispatchEvent(new CustomEvent('ow:open-settings', { detail: 'ai' }))}
          diagnostics={[
            { label: 'page', value: state.current?.id ?? '—' },
            { label: 'blocks', value: String(state.current?.rows.length ?? 0) },
            { label: 'pages', value: String(state.stats.pages) },
            { label: 'commands', value: String(state.stats.ftsRows) },
          ]}
        />
        <TopBar
          state={state}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onNavigate={navigate}
          onOpenPage={openPage}
          pageMenuItems={pageMenuItems}
          pageMenuOpen={pageMenuOpen}
          setPageMenuOpen={setPageMenuOpen}
          pageMenuAnchor={pageMenuAnchor}
          canGoBack={nav.back}
          canGoForward={nav.forward}
          run={run}
        />
        <PageView state={state} run={run} onOpenPage={openPage} preferences={preferences} />
        {showHistory && state.current && (
          <HistoryPanel
            pageId={state.current.id}
            run={run}
            onClose={() => setShowHistory(false)}
          />
        )}
      </main>
      <ToastRegion toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
        <QuickFind
          open={findOpen}
          onClose={() => setFindOpen(false)}
          onOpenPage={openPage}
          search={async (q) => {
            const r = await run('search.quickFind', { query: q });
            if (!r.ok) return [];
            // `pageId`, not `id`. Reading `id` here gave undefined, which opened
            // no page at all and looked like the search had failed.
            return (r.value as { pageId: string; title: string; snippet: string }[]).map((hit) => ({
              id: hit.pageId,
              title: hit.title,
              snippet: hit.snippet,
            }));
          }}
        />
    </div>
  );
}

// ------------------------------------------------------------------- sidebar

/**
 * Save text to a file the user chooses.
 *
 * An object URL rather than a data URL: a data URL for a large export gets
 * truncated on some platforms, and revoking immediately after the click is what
 * keeps the blob from leaking for the life of the window.
 */
function download(name: string, body: string, ext: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}${ext}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Sidebar({
  state,
  run,
  toast,
  onClose,
  theme,
  onThemeChange,
  onNavigate,
  width,
  onResizeStart,
  prefs,
  setPrefs,
}: {
  state: AppState;
  run: (id: string, args?: Record<string, unknown>) => Promise<ExecuteResult>;
  toast: (m: string, a?: ToastSpec['action']) => void;
  onClose: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onNavigate: (id: string) => void;
  width: number;
  onResizeStart: () => void;
  prefs: Preferences;
  setPrefs: (patch: Partial<Preferences>) => void;
}) {
  const { textSize, contentWidth, accent, zoom } = prefs;
  const [section, setSection] = useState<'favorites' | 'pages' | 'recents' | 'trash' | null>('pages');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Which settings section is open. Held here so the AI bubble can ask for one.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  // The AI bubble lives outside the sidebar, so it asks for a settings
  // section with an event rather than reaching into this component.
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setSettingsSection(detail === 'ai' ? 'ai' : 'general');
      setShowSettings(true);
    };
    window.addEventListener('ow:open-settings', open);
    return () => window.removeEventListener('ow:open-settings', open);
  }, []);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());  // `| null` in the type argument is what makes this a MutableRefObject.
  // `useRef<HTMLButtonElement>(null)` infers RefObject, whose `current` is
  // readonly, so assigning an anchor to it is a type error. The cast form hides
  // that; spelling out the nullable type is both correct and honest.
  const menuAnchor = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuFor && !(e.target as Element)?.closest('[data-row-menu]')) setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [menuFor]);

  const rows =
    section === 'favorites'
      ? state.favorites
      : section === 'trash'
        ? state.trashed
        : section === 'recents'
          ? state.recents
          : state.pages;

  const openPage = (id: string) => {
    onNavigate(id);
    setSection('pages');
  };

  /**
   * The row menu.
   *
   * "Move to trash" takes an explicit page id rather than trashing "the open
   * page". That is operator requirement R2: a page must be deletable from the
   * sidebar without opening it first. An earlier version of this app could only
   * trash the open page, which made the action unavailable for every other row.
   */
  const rowMenuItems = (page: PageNode): MenuItemSpec[] => [
    { key: 'open', label: 'Open', icon: <Icon name="page" />, onSelect: () => openPage(page.id) },
    {
      key: 'favorite',
      label: page.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      icon: <Icon name={page.isFavorite ? 'starFilled' : 'star'} />,
      onSelect: () => void run('page.favorite.toggle', { id: page.id, favorite: !page.isFavorite }),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: <Icon name="duplicate" />,
      onSelect: () =>
        void run('page.duplicate', { id: page.id }).then((r) => {
          if (r.ok) {
            const v = r.value as { id?: string } | undefined;
            if (typeof v?.id === 'string') openPage(v.id);
          }
        }),
    },
    {
      key: 'rename',
      label: 'Rename',
      icon: <Icon name="text" />,
      onSelect: () => {
        const title = window.prompt('Rename page', page.title);
        if (title !== null) void run('page.rename', { title });
      },
    },
    {
      key: 'move',
      label: 'Move to...',
      icon: <Icon name="moveTo" />,
      onSelect: () => {
        // A prompt, not a picker: the sidebar is already a searchable page list,
        // and a second one built only for "which parent" is a lot of surface for
        // a question with an obvious text answer. Empty means top level, which is
        // the one move a name cannot express.
        const want = window.prompt('Move under which page? Leave empty for top level', '');
        if (want === null) return;
        const query = want.trim();
        if (query === '') {
          void run('page.move', { id: page.id, parentPage: '' });
          return;
        }
        void run('search.quickFind', { query }).then((r) => {
          if (!r.ok) return;
          const hit = (r.value as { pageId: string; title: string }[]).find(
            (h) => h.title.toLowerCase() === query.toLowerCase(),
          );
          // Substring matches are not good enough here: moving a page under
          // whichever row happened to rank first would be a silent data change.
          if (!hit) {
            toast(`No page named "${query}"`);
            return;
          }
          void run('page.move', { id: page.id, parentPage: hit.pageId });
        });
      },
    },
    {
        key: 'export',
        label: 'Export markdown',
        icon: <Icon name="import" />,
        onSelect: () =>
          void run('export.markdown', { pageId: page.id }).then((r) => {
            if (!r.ok) return;
            download(`export-markdown`, `${(r.value as { markdown: string }).markdown}`, '.md', 'text/markdown');
            toast('Exported');
          }),
      },
      {
        key: 'copy',
      label: 'Copy link',
      icon: <Icon name="link" />,
      onSelect: () => {
        void navigator.clipboard
          .writeText(`openfield://page/${page.id}`)
          .then(() => toast('Link copied'))
          .catch(() => toast('Could not reach the clipboard'));
      },
    },
    { key: 'sep1', label: '', disabled: true, onSelect: () => {} },
    ...(section === 'trash'
      ? [
          {
            key: 'restore',
            label: 'Restore',
            icon: <Icon name="undo" />,
            onSelect: () => void run('page.restore', { id: page.id }),
          },
          {
            key: 'purge',
            label: 'Delete permanently',
            danger: true,
            icon: <Icon name="delete" />,
            onSelect: () => void run('page.deleteForever', { id: page.id }),
          },
        ]
      : [
          {
            key: 'trash',
            label: 'Move to trash',
            danger: true,
            icon: <Icon name="trash" />,
            onSelect: () => {
              void run('page.moveToTrash', { id: page.id });
              toast('Page moved to trash', {
                label: 'Undo',
                run: () => void run('page.restore', { id: page.id }),
              });
            },
          },
        ]),
  ];

  /**
   * Drag a sidebar row to reorder it among its siblings, or to nest it.
   *
   * Three zones on the target row: top third reorders above, bottom third
   * below, middle nests. Two thirds each rather than a single midpoint, because
   * a midpoint is a one-pixel target and nesting by accident while trying to
   * reorder is the complaint every tree drag attracts.
   *
   * Reordering goes through `page.reorder` and nesting through `page.move` --
   * two commands that already renumber siblings in one transaction. A drag that
   * computed its own new positions would be a third implementation of the same
   * ordering rule, and would drift from the other two.
   */
  const [draggingPage, setDraggingPage] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; where: 'above' | 'below' | 'into' } | null>(null);

  const dragHandlers = useMemo(
    () => ({
      draggingId: draggingPage,
      hint: dropHint,
      start(id: string, event: React.DragEvent) {
        event.dataTransfer.setData('text/plain', id);
        event.dataTransfer.effectAllowed = 'move';
        setDraggingPage(id);
      },
      over(id: string, event: React.DragEvent) {
        if (!draggingPage) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - box.top) / box.height;
        setDropHint({ id, where: ratio < 0.34 ? 'above' : ratio > 0.66 ? 'below' : 'into' });
      },
      drop(id: string, event: React.DragEvent) {
        event.preventDefault();
        const dragged = event.dataTransfer.getData('text/plain');
        setDraggingPage(null);
        setDropHint(null);
        if (!dragged || dragged === id) return;

        // The zone is worked out from this event's own coordinates, not read
        // from `dropHint`. dragover sets that state, but state does not flush
        // until React re-renders, and a dragover immediately followed by a drop
        // in the same frame would leave it null -- the drop would then quietly
        // do nothing, which is the hardest kind of broken to notice.
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - box.top) / box.height;
        const where: 'above' | 'below' | 'into' = ratio < 0.34 ? 'above' : ratio > 0.66 ? 'below' : 'into';

        if (where === 'into') {
          void run('page.move', { id: dragged, parentPage: id });
          return;
        }
        // Join the target's siblings, then step one place in the direction the
        // pointer showed. There is no "move before page X" command, and
        // inventing one here would be a third ordering implementation.
        const parent = state.pages.find((p) => p.id === id)?.parentPage ?? '';
        void run('page.move', { id: dragged, parentPage: parent }).then(() => {
          void run('page.reorder', { id: dragged, direction: where === 'above' ? -1 : 1 });
        });
      },
      end() {
        setDraggingPage(null);
        setDropHint(null);
      },
    }),
    [run, draggingPage, dropHint, state.pages],
  );

  return (
    <nav className="ow-sidebar" style={{ width }} aria-label="Pages">
      <div
        className="ow-sidebar-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          onResizeStart();
        }}
        // Keyboard-resizable too: a separator you can only drag is a control
        // some people can never reach.
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setPrefs({ sidebarWidth: Math.max(SIDEBAR_MIN, width - 16) });
          if (e.key === 'ArrowRight') setPrefs({ sidebarWidth: Math.min(SIDEBAR_MAX, width + 16) });
        }}
      />
      <div className="ow-sidebar-head">
        <button type="button" className="ow-workspace" title={state.workspacePath}>
          {/* The mark: a field of plots, one of them seeded. Drawn here rather
              than loaded as an image so it takes the text colour and needs no
              asset file. */}
          <svg className="ow-workspace-icon" viewBox="0 0 20 20" aria-hidden="true">
            <rect width="20" height="20" rx="5" fill="currentColor" />
            <rect x="4" y="4" width="5" height="5" rx="1.4" fill="var(--ow-bg)" opacity="0.5" />
            <rect x="11" y="4" width="5" height="5" rx="1.4" fill="var(--ow-bg)" />
            <rect x="4" y="11" width="5" height="5" rx="1.4" fill="var(--ow-bg)" />
            <rect x="11" y="11" width="5" height="5" rx="1.4" fill="var(--ow-bg)" />
          </svg>
          <span className="ow-workspace-name">My workspace</span>
        </button>
        <Tooltip label="Collapse sidebar (Ctrl+\)">
          <button type="button" className="ow-icon-btn" aria-label="Collapse sidebar" onClick={onClose}>
            <Icon name="chevronDown" />
          </button>
        </Tooltip>
      </div>

      <ul className="ow-nav-list">
        <li>
          <button type="button" className="ow-nav-item" onClick={() => void run('search.quickFind', { query: '' })}>
            <Icon name="search" />
            <span>Search</span>
          </button>
        </li>
        <li>
          <button type="button" className="ow-nav-item">
            <Icon name="home" />
            <span>Home</span>
          </button>
        </li>
        <li>
          <button type="button" className="ow-nav-item">
            <Icon name="inbox" />
            <span>Inbox</span>
          </button>
        </li>
      </ul>

      <div className="ow-sections">
        <Section
          title="Favorites"
          icon="star"
          count={state.favorites.length}
          open={section === 'favorites'}
          onToggle={() => setSection((s) => (s === 'favorites' ? null : 'favorites'))}
        />
        <Section
          tree
          title="Pages"
          icon="page"
          count={state.pages.length}
          open={section === 'pages'}
          onToggle={() => setSection((s) => (s === 'pages' ? null : 'pages'))}
        >
          {state.pages.length === 0 && <p className="ow-empty-hint">No pages yet.</p>}
          {rows.map((page) => (
            <SidebarRow
              key={page.id}
              page={page}
              active={state.current?.id === page.id}
              expanded={expanded.has(page.id)}
              canExpand={page.hasChildren}
              onToggleExpand={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(page.id)) next.delete(page.id);
                  else next.add(page.id);
                  return next;
                })
              }
              onOpen={() => openPage(page.id)}
              onMenu={(anchor) => {
                menuAnchor.current = anchor;
                setMenuFor(page.id);
              }}
              onAddChild={() => {
                void run('page.create', { title: '', parentPage: page.id }).then(() => setSection('pages'));
              }}
              drag={dragHandlers}
    onMove={(dir) => void run('page.reorder', { id: page.id, direction: dir })}
            />
          ))}
        </Section>
        <Section
          title="Recents"
          icon="date"
          count={state.recents.length}
          open={section === 'recents'}
          onToggle={() => setSection((s) => (s === 'recents' ? null : 'recents'))}
        >
          {state.recents.length === 0 && <p className="ow-empty-hint">Nothing opened yet.</p>}
          {state.recents.map((page) => (
            <SidebarRow
              key={page.id}
              page={page}
              active={state.current?.id === page.id}
              expanded={false}
              canExpand={false}
              onToggleExpand={() => {}}
              onOpen={() => openPage(page.id)}
              onMenu={(anchor) => {
                menuAnchor.current = anchor;
                setMenuFor(page.id);
              }}
            />
          ))}
        </Section>
        <Section
          title="Trash"
          icon="trash"
          count={state.trashed.length}
          open={section === 'trash'}
          onToggle={() => setSection((s) => (s === 'trash' ? null : 'trash'))}
        >
          {state.trashed.length === 0 && <p className="ow-empty-hint">Trash is empty.</p>}
          {section === 'trash' &&
            rows.map((page) => (
              <SidebarRow
                key={page.id}
                page={page}
                active={false}
                expanded={false}
                canExpand={false}
                onToggleExpand={() => {}}
                onOpen={() => openPage(page.id)}
                onMenu={(anchor) => {
                  menuAnchor.current = anchor;
                  setMenuFor(page.id);
                }}
              />
            ))}
        </Section>
      </div>

      <div className="ow-sidebar-foot">
        <button
          type="button"
          className="ow-nav-item ow-new-page"
          onClick={async () => {
            // Open what was just made. Creating a page and leaving the user on
            // the previous one makes the button look like it did nothing: the
            // new page only appears as an "Untitled" row in a long list.
            const created = await run('page.create', { title: '' });
            const id = (created.value as { id?: string } | undefined)?.id;
            if (id) onNavigate(id);
            setSection('pages');
          }}
        >
          <Icon name="plus" />
          <span>New page</span>
        </button>

        <button
          type="button"
          className="ow-nav-item ow-settings-open"
          aria-haspopup="dialog"
          onClick={() => setShowSettings(true)}
        >
          <Icon name="settings" />
          <span>Settings</span>
        </button>
      </div>

      {/* The cheat sheet is its own dialog rather than a panel inside
          Settings. Two elements with role=dialog stacked inside one another
          is a modal inside a modal: the backdrop and the escape key
          stop meaning what they say. */}
      {showShortcuts && (
    <div className="ow-overlay ow-overlay--above" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={() => setShowShortcuts(false)}>
      <div className="ow-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ow-dialog-head">
          <h2 className="ow-dialog-title">Keyboard shortcuts</h2>
          <button type="button" className="ow-icon-btn" aria-label="Close shortcuts" onClick={() => setShowShortcuts(false)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="ow-dialog-body">
          {Object.entries(
            state.shortcuts.reduce<Record<string, typeof state.shortcuts>>((groups, s) => {
              (groups[s.category] ??= []).push(s);
              return groups;
            }, {}),
          ).map(([category, items]) => (
            <section key={category} className="ow-sheet">
              <h3 className="ow-sheet-head">{category}</h3>
              <dl className="ow-sheet-list">
                {items.map((s) => (
                  <div key={s.id} className="ow-sheet-row">
                    <dt className="ow-sheet-title">{s.title}</dt>
                    <dd className="ow-sheet-keys">
                      {/* Both spellings, because the sheet is read on the
                          machine it was printed on, not on the one that
                          generated it. */}
                      <kbd>{IS_MAC ? s.mac : s.win}</kbd>
                      {!IS_MAC && <kbd className="ow-sheet-alt">{s.mac}</kbd>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )}

      {/* Settings, out of the sidebar body.

          Six labelled control groups stacked under the page tree made the
          sidebar read as a settings panel with a page list wedged into it,
          and pushed the navigation itself below the fold. The tree is what
          the sidebar is for; everything else belongs behind one control. */}
      {showSettings && (
        <SettingsDialog
          prefs={prefs}
          setPrefs={setPrefs}
          onThemeChange={onThemeChange}
          run={run}
          onShowShortcuts={() => {
            // The cheat sheet is its own dialog, not a panel inside Settings. Two
            // stacked dialogs mean the backdrop and the escape key stop meaning
            // what they say, so Settings closes and the sheet takes over.
            setShowSettings(false);
            setShowShortcuts(true);
          }}
          onClose={() => setShowSettings(false)}
          section={settingsSection}
          onSection={setSettingsSection}
          workspacePath={state.workspacePath}
          version={state.version}
        />
      )}

      <Menu
        open={menuFor !== null}
        anchorRef={menuAnchor}
        items={menuFor ? rowMenuItems(rows.find((p) => p.id === menuFor)!) : []}
        onClose={() => setMenuFor(null)}
        minWidth={220}
        label="Page actions"
      />
    </nav>
  );
}

function Section({
  title,
  icon,
  count,
  open,
  onToggle,
  children,
  tree,
}: {
  title: string;
  icon: 'star' | 'page' | 'trash' | 'date';
  count: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  /** Only the Pages section is a tree; the others are flat lists. */
  tree?: boolean;
}) {
  return (
    <section className="ow-section">
      <button
        type="button"
        className="ow-section-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name={icon} size={14} />
        <span className="ow-section-title">{title}</span>
        <span className="ow-section-count">{count}</span>
      </button>
      {open && (
        <div
          className="ow-section-body"
          // Pages is a real tree; Favourites and Trash are flat lists. Claiming
          // tree semantics there makes a screen reader announce expandable levels
          // that do not exist.
          role={tree ? 'tree' : 'group'}
          aria-label={tree ? title : undefined}
        >
          {children}
        </div>
      )}
    </section>
  );
}

function SidebarRow({
  page,
  active,
  expanded,
  canExpand,
  onToggleExpand,
  onOpen,
  onMenu,
  onAddChild,
  onMove,
  drag,
}: {
  page: PageNode;
  active: boolean;
  expanded: boolean;
  canExpand: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
  onMenu: (anchor: HTMLButtonElement) => void;
  onAddChild?: () => void;
  /** Alt+Arrow moves the page among its siblings. The keyboard route to the same
      move the row menu offers, so reordering never requires a mouse. */
  onMove?: (direction: -1 | 1) => void;
  /**
   * Drag handlers, built by Sidebar so the state they need lives next to the
   * command runner. Passing one object rather than five props keeps the row from
   * re-rendering on every pointer move during a drag.
   */
  drag?: {
    start: (id: string, event: React.DragEvent) => void;
    over: (id: string, event: React.DragEvent) => void;
    drop: (id: string, event: React.DragEvent) => void;
    end: () => void;
    draggingId: string | null;
    hint: { id: string; where: 'above' | 'below' | 'into' } | null;
  };
}) {
  const hint = drag?.hint?.id === page.id ? drag.hint.where : null;
  return (
    <div
      className="ow-row"
      // Tree semantics, so a screen reader announces depth and position rather
      // than reading out a flat list of links that happens to be indented.
      role="treeitem"
      aria-level={page.depth + 1}
      aria-selected={active || undefined}
      data-active={active || undefined}
      draggable={Boolean(drag)}
      data-dragging={drag?.draggingId === page.id ? 'true' : undefined}
      data-drop={hint}
      onDragStart={drag ? (e) => drag.start(page.id, e) : undefined}
      onDragOver={drag ? (e) => drag.over(page.id, e) : undefined}
      onDrop={drag ? (e) => drag.drop(page.id, e) : undefined}
      onDragEnd={drag ? drag.end : undefined}
      style={{ paddingLeft: `${8 + page.depth * 14}px` }}
    >
      {canExpand ? (
        <button
          type="button"
          className="ow-row-chevron"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      ) : (
        <span className="ow-row-chevron ow-row-chevron-empty" />
      )}
      <button type="button" className="ow-row-main" onClick={onOpen} onKeyDown={(e) => {
          // Alt+Arrow, not plain Arrow: plain arrows already move focus between
          // rows, and taking those would break keyboard navigation entirely.
          if (!onMove || !e.altKey) return;
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          onMove(e.key === 'ArrowUp' ? -1 : 1);
        }}>
        <span className="ow-row-icon">{page.icon ?? <Icon name="page" size={14} />}</span>
        <span className="ow-row-title">{page.title || 'Untitled'}</span>
      </button>
      <button
        type="button"
        data-row-menu
        className="ow-row-menu"
        aria-label={`Actions for ${page.title || 'Untitled'}`}
        aria-haspopup="menu"
        onClick={(event) => onMenu(event.currentTarget)}
      >
        <Icon name="dots" size={14} />
      </button>
      {onAddChild && (
        <button
          type="button"
          data-row-add
          className="ow-row-add"
          aria-label={`Add a child page to ${page.title || 'Untitled'}`}
          onClick={(event) => {
            event.stopPropagation();
            onAddChild();
          }}
        >
          <Icon name="plus" size={12} />
        </button>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- topbar

function TopBar({
  state,
  sidebarOpen,
  onToggleSidebar,
  onNavigate,
  onOpenPage,
  pageMenuItems,
  pageMenuOpen,
  setPageMenuOpen,
  pageMenuAnchor,
  canGoBack,
  canGoForward,
  run,
}: {
  state: AppState;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNavigate: (delta: -1 | 1) => void;
  onOpenPage: (id: string) => void;
  pageMenuItems: MenuItemSpec[];
  pageMenuOpen: boolean;
  setPageMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pageMenuAnchor: React.MutableRefObject<HTMLButtonElement | null>;
  canGoBack: boolean;
  canGoForward: boolean;
  run: (id: string, args?: Record<string, unknown>) => Promise<ExecuteResult>;
}) {
  return (
    <header className="ow-topbar">
      <button
        type="button"
        className="ow-icon-btn"
        aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <Icon name={sidebarOpen ? 'chevronDown' : 'chevronRight'} />
      </button>
      {/* Back and forward. Disabled rather than hidden when they would do
          nothing: a button that disappears moves the neighbours around it, and
          nobody can learn where the control lives. */}
      <Tooltip label="Back">
        <button
          type="button"
          className="ow-icon-btn"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={() => void onNavigate(-1)}
        >
          <Icon name="chevronLeft" />
        </button>
      </Tooltip>
      <Tooltip label="Forward">
        <button
          type="button"
          className="ow-icon-btn"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={() => void onNavigate(1)}
        >
          <Icon name="chevronRight" />
        </button>
      </Tooltip>
      <nav className="ow-breadcrumb" aria-label="Breadcrumb">
        <CrumbTrail state={state} onOpenPage={onOpenPage} />
      </nav>
      <div className="ow-topbar-right">
        <button type="button" className="ow-text-btn">
          Share
        </button>
        <Tooltip label="Favorite">
          <button
            type="button"
            className="ow-icon-btn"
            aria-label="Favorite"
            onClick={() => void run('page.favorite.toggle', {})}
          >
            <Icon name="star" />
          </button>
        </Tooltip>
        <Tooltip label="More">
          <button type="button" className="ow-icon-btn" aria-label="Page options" aria-haspopup="menu" onClick={(e) => { pageMenuAnchor.current = e.currentTarget; setPageMenuOpen((v) => !v); }}>
            <Icon name="dots" />
          </button>
        </Tooltip>
        <Menu
          open={pageMenuOpen}
          anchorRef={pageMenuAnchor}
          items={pageMenuItems}
          onClose={() => setPageMenuOpen(false)}
          minWidth={210}
          label="Page options"
        />
      </div>
    </header>
  );
}

/**
 * The ancestor chain, outermost first.
 *
 * Built from `state.pages`, the same flat list the sidebar tree is built from,
 * rather than from a new field in the view model. `parentPage` is already there
 * for exactly this purpose, and the breadcrumb is a read, so it needs no command
 * and no model change to have somewhere to come from.
 */
function CrumbTrail({ state, onOpenPage }: { state: AppState; onOpenPage: (id: string) => void }) {
  const byId = new Map(state.pages.map((p) => [p.id, p]));
  const trail: { id: string; title: string }[] = [];
  let cursor = state.current ? byId.get(state.current.id)?.parentPage ?? null : null;
  let guard = 0;
  while (cursor && guard < 1000) {
    const node = byId.get(cursor);
    if (!node) break;
    trail.unshift({ id: node.id, title: node.title });
    cursor = node.parentPage;
    guard += 1;
  }

  if (trail.length === 0) {
    return (
      <>
        <span className="ow-crumb-icon">{state.current ? '📄' : ''}</span>
        <span className="ow-crumb">{state.current?.title || 'Untitled'}</span>
      </>
    );
  }

  return (
    <>
      {trail.map((crumb, i) => (
        <span className="ow-crumb-chain" key={crumb.id}>
          {i > 0 && <span className="ow-crumb-sep" aria-hidden="true">/</span>}
          <button
            type="button"
            className="ow-crumb"
            onClick={() => onOpenPage(crumb.id)}
          >
            {crumb.title || 'Untitled'}
          </button>
        </span>
      ))}
      <span className="ow-crumb-sep" aria-hidden="true">/</span>
      <span className="ow-crumb ow-crumb-current">{state.current?.title || 'Untitled'}</span>
    </>
  );
}

// ------------------------------------------------------------------ page view

/**
 * Whether to print the Mac spelling of a shortcut first.
 *
 * Both spellings are shown on non-Mac rather than one: the sheet is read on the
 * machine it was opened on, and someone working across two should not have to
 * guess which column is theirs.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

const BLOCK_ICON: Record<string, Parameters<typeof Icon>[0]['name']> = {
  paragraph: 'text',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  bulletedListItem: 'bulletedList',
  numberedListItem: 'numberedList',
  todo: 'todo',
  toggle: 'toggle',
  quote: 'quote',
  callout: 'quote',
  code: 'code',
  divider: 'divider',
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  pdf: 'file',
  bookmark: 'bookmark',
  equation: 'equation',
  embed: 'embed',
  database: 'database',
  page: 'page',
  table: 'table' as never,
  tableOfContents: 'toc',
  breadcrumb: 'breadcrumb',
  columns: 'columns' as never,
  column: 'columns' as never,
  syncedBlock: 'duplicate',
};

/**
 * Scroll position per page, so going back lands where you left.
 *
 * A module-level Map rather than component state: the position has to outlive
 * the PageView that produced it, and it is meaningless anywhere but here.
 * Bounded so a long session cannot grow it without limit.
 */
const scrollMemory = new Map<string, number>();
const SCROLL_MEMORY_LIMIT = 50;

function rememberScroll(pageId: string | undefined, top: number): void {
  if (!pageId) return;
  scrollMemory.set(pageId, top);
  if (scrollMemory.size > SCROLL_MEMORY_LIMIT) {
    const oldest = scrollMemory.keys().next();
    if (!oldest.done) scrollMemory.delete(oldest.value);
  }
}

function PageView({
  state,
  run,
  onOpenPage,
  preferences,
}: {
  state: AppState;
  run: (id: string, args?: Record<string, unknown>) => Promise<ExecuteResult>;
  onOpenPage: (id: string) => void;
  /** The local preferences, for the last-edited-by name. */
  preferences: Preferences;
}) {
  const titleHost = useRef<HTMLHeadingElement>(null);
  const titleModel = state.current?.title ?? '';
  const appearance = state.current?.appearance;
  const locked = state.current?.locked ?? false;
  const updatedAt = state.current?.updatedAt ?? 0;
  // The local user's name, for "last edited by". Empty is honest: there are no
  // accounts, and a made-up name would be a lie about who touched the page.
  const profileName = preferences.profileName;

  /**
   * Pages that mention this one.
   *
   * Loaded when the page changes rather than on every render: the query scans
   * block content, and doing that per keystroke would be absurd.
   */
  const [backlinks, setBacklinks] = useState<{ pageId: string; title: string; snippet: string }[]>([]);
  useEffect(() => {
    const id = state.current?.id;
    if (!id) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    void run('page.backlinks', { id }).then((result) => {
      if (cancelled || !result.ok) return;
      setBacklinks((result.value as { backlinks: typeof backlinks }).backlinks);
    });
    return () => {
      cancelled = true;
    };
  }, [state.current?.id, state.current?.updatedAt]);
  const peopleById = useMemo(
    () => Object.fromEntries(state.people.map((p) => [p.id, p])),
    [state.people],
  );
  const pageId = state.current?.id;
  const scrollHost = useRef<HTMLDivElement>(null);
  const previousPage = useRef<string | undefined>(undefined);

  // Save the outgoing page's scroll on every page change, then restore the
  // incoming one in a layout effect -- a normal effect runs before the browser
  // has painted, and scrollTop assigned against a stale layout is discarded.
  useLayoutEffect(() => {
    if (previousPage.current !== pageId) {
      rememberScroll(previousPage.current, scrollHost.current?.scrollTop ?? 0);
      previousPage.current = pageId;
      const saved = pageId ? scrollMemory.get(pageId) : undefined;
      if (saved !== undefined && scrollHost.current) scrollHost.current.scrollTop = saved;
    }
  }, [pageId]);

  /**
   * Commit the title on blur, not per keystroke.
   *
   * The reason that bites is undo. `page.rename` pushes its own history entry,
   * so a per-keystroke rename fills the undo stack with single letters and Ctrl+Z
   * steps back through "c", "o", "n" instead of undoing the edit the user just
   * made. It also compares before firing, so focusing a title and moving away
   * without typing costs nothing and pushes no history at all.
   */
  const commitTitle = useCallback(
    (value: string) => {
      const next = value.replace(/\s+/g, ' ').trim();
      if (next === titleModel) return;
      void run('page.rename', { title: next });
    },
    [run, titleModel],
  );

  // Write the model back into the DOM only when the user is not editing it --
  // the same defence the block editor uses. React re-rendering over a
  // contenteditable the browser is actively editing wipes the character typed.
  //
  // A layout effect, not a passive one: the h1 starts empty and its "Untitled"
  // placeholder is what `:empty::before` paints, so filling it after the paint
  // showed the placeholder for a few frames on every arrival at a titled page.
  // A focused title that the browser shows as empty is still filled, because
  // what it holds then is stale, not something the user typed yet.
  useLayoutEffect(() => {
    const el = titleHost.current;
    if (!el) return;
    if (document.activeElement === el && el.textContent !== '') return;
    if (el.textContent !== titleModel) el.textContent = titleModel;
  }, [titleModel]);

  if (!state.current) {
    return (
      <div className="ow-page ow-page-empty">
        <p>No page selected.</p>
      </div>
    );
  }
  const rows = state.current.rows;
  // A page that holds a collection renders as a table, not as blocks. Both are
  // pages; asking which one is a question about state the renderer already has,
  // rather than a second concept to keep in sync.
  const database = state.database;
  if (database) {
    return (
      <div className="ow-page-scroll ow-page-scroll--wide">
          <DatabaseTable
            people={peopleById}
          db={database}
          run={run}
          onOpenPage={onOpenPage}
        />
      </div>
    );
  }
  return (
    <div className="ow-page-scroll" ref={scrollHost}>
      {/* Properties, for a page that is a row in a database.
          Rendered from the same Cell the table uses, so a value edited here and
          one edited in the table are the same editor with the same validation.
          Two implementations of a property editor would disagree about what a
          date accepts, and the disagreement would only show up in the database. */}
      {state.rowOf && state.rowOf.collection.schema.properties.length > 0 && (
        <section className="ow-props" aria-label={`${state.rowOf.collection.name} properties`}>
          {state.rowOf.collection.schema.properties.map((property) => (
            <div className="ow-props-row" key={property.id}>
              <span className="ow-props-name">{property.name}</span>
              <Cell
                property={property}
                value={(state.rowOf!.values[property.id] as DbValue | undefined) ?? null}
                collectionId={state.rowOf!.collection.id}
                pageId={state.current?.id ?? ''}
                busy={false}
                onBusy={() => {}}
                run={run}
                people={peopleById}
              />
            </div>
          ))}
        </section>
      )}
      <article
        className="ow-page"
        data-width={appearance?.fullWidth ? 'full' : 'normal'}
        data-font={appearance?.font ?? 'sans'}
        data-small-text={appearance?.smallText ? 'true' : undefined}
      >
        <div className="ow-cover-placeholder" aria-hidden="true" />

        {/* What the page is and when it last changed, in one line under the
            title. The lock is here rather than in the top bar because it is a
            property of this page, not of the window. */}
        <div className="ow-page-meta">
          {locked && (
            <span className="ow-page-locked" title="This page is locked and cannot be edited">
              <Icon name="lock" size={12} />
              Locked
            </span>
          )}
          {updatedAt > 0 && (
            <span className="ow-page-edited">
              {profileName
                ? `Last edited by ${profileName} on ${new Date(updatedAt).toLocaleString()}`
                : `Last edited on ${new Date(updatedAt).toLocaleString()}`}
            </span>
          )}
        </div>
        <h1
            ref={titleHost}
            className="ow-page-title"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label="Page title"
            spellCheck
            data-placeholder="Untitled"
            onBlur={(e) => commitTitle(e.currentTarget.textContent ?? '')}
            onKeyDown={(e) => {
              // Enter commits rather than inserting a line break. A title is one
              // line; a soft break inside it is invisible in the sidebar and
              // breaks the outline.
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
                return;
              }
              // Escape reverts. Without it the only way back to the old title is
              // retyping it, which is a trap in a field that does not obviously
              // save itself.
              if (e.key === 'Escape') {
                e.preventDefault();
                e.currentTarget.textContent = titleModel;
                e.currentTarget.blur();
              }
            }}
          />
        <BlockEditor rows={rows} run={run} pages={state.pages.map((p) => ({ id: p.id, title: p.title }))} />
      </article>
      {/* Below the page, where a reader arrives after the text: a page is
          "mentioned in" the pages that link to it, not the other way round. */}
      {backlinks.length > 0 && (
        <section className="ow-backlinks" aria-label="Pages that mention this one">
          <h2 className="ow-backlinks-head">Mentioned in</h2>
          <ul className="ow-backlinks-list">
            {backlinks.map((b) => (
              <li key={b.pageId}>
                <button type="button" className="ow-backlinks-item" onClick={() => onOpenPage(b.pageId)}>
                  <span className="ow-backlinks-title">{b.title || 'Untitled'}</span>
                  {b.snippet && <span className="ow-backlinks-snippet">{b.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
