/**
 * The view model shared by the main and renderer processes.
 *
 * This type used to be declared twice, once per process, and the two copies had
 * to be edited in step. Adding a field to it failed to compile in one process
 * and compiled fine in the other, which is a worse failure than no compiler: it
 * looked like the change had landed when only half of it had.
 *
 * Declared once here. Both sides import it, so a change that affects one side
 * without the other is a compile error instead of a runtime surprise.
 *
 * It is a *view* model, not the document. Nothing here is a model type that the
 * renderer could mutate: everything is read-only data, and every change travels
 * back as a command.
 */

/** One page in the sidebar tree. */
export interface PageNode {
  id: string;
  title: string;
  icon: string | null;
  parentPage: string | null;
  isFavorite: boolean;
  hasChildren: boolean;
  /** The kind of a callout: note, tip, info, warning or caution. */
  calloutKind?: string;
  depth: number;
}

export interface DbPropertyView {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string }[];
}

export interface DbRowView {
  id: string;
  title: string;
  /**
   * Keyed by property id. Values are plain objects rather than a Map because
   * they cross an IPC boundary, and structured cloning does not preserve Maps.
   */
  values: Record<string, unknown>;
}

/**
 * The database attached to the open page, or null when it is a document.
 *
 * Null rather than an empty collection, so "this page is a document" is
 * distinguishable from "this database has no rows".
 */
export interface DatabaseView {
  collection: {
    id: string;
    name: string;
    schema: { properties: DbPropertyView[] };
  };
  views: { id: string; type: string; name: string }[];
  rows: DbRowView[];
}

/** How a page presents itself. Every field has a defined default. */
export interface PageAppearance {
  cover: string | null;
  fullWidth: boolean;
  smallText: boolean;
  /** 'sans' | 'serif' | 'mono'. */
  font: string;
}

export interface AppState {
  workspacePath: string;
  /** The application version, for the settings panel. */
  version: string;
  /** Commands that have a keyboard binding, for the cheat sheet. */
  shortcuts: { id: string; title: string; category: string; win: string; mac: string }[];
  /** The database on this page, if it is one. */
  database: DatabaseView | null;
  /**
   * The database this page is a *row* of, if any.
   *
   * Separate from `database` because the two are different questions and the
   * page alone cannot answer either: hosting a collection makes a page a
   * database, being a child of a page that hosts one makes it a row. A row page
   * with no `database` used to be indistinguishable from an ordinary document,
   * so there was nowhere to hang its properties.
   */
  rowOf: { collection: DatabaseView['collection']; values: Record<string, unknown> } | null;
  pages: PageNode[];
  /** The workspace's people directory, for person properties. */
  people: { id: string; name: string }[];
  favorites: PageNode[];
  /** Recently opened, newest first. Excludes trashed pages. */
  recents: PageNode[];
  trashed: PageNode[];
  current: {
    id: string;
    title: string;
    rows: ReturnType<import('@ow/commands').Session['outline']>;
    /** Per-page presentation. Present because the columns exist on the page
        row; without them in the view model the renderer would have to guess or
        the settings would be write-only. */
    appearance: PageAppearance;
    /** Read-only: the editor refuses edits and the header shows a lock. */
    locked: boolean;
    /** When the page was last edited, epoch ms. */
    updatedAt: number;
  } | null;
  stats: { pages: number; blocks: number; ftsRows: number; dbBytes: number };
  integrity: { ok: boolean; repaired: string[]; problems: string[] };
}
