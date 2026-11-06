/**
 * View preferences, stored outside the document.
 *
 * Why localStorage and not the database: these are preferences about how *this*
 * installation looks, not facts about the user's work. Keeping them out of the
 * document means three things follow for free. A shared or synced page carries
 * no trace of the machine it was read on. Clearing preferences cannot lose work,
 * because no work lives here. And a corrupt or half-migrated entry can be
 * discarded without a repair path, since it holds nothing that matters.
 *
 * Everything is validated on read. The alternative -- trusting whatever JSON is
 * in storage and casting it -- means a value written by an older build, or a
 * half-written one, reaches the renderer as `undefined` and fails somewhere
 * unrelated, ten minutes later, in a component that knows nothing about
 * preferences. Every field falls back independently, so one bad value costs one
 * setting rather than the lot.
 */

export type ThemePreference = 'system' | 'light' | 'dark';

/** Three steps, not a free slider: each one is readable at a glance. */
export type TextSize = 'small' | 'medium' | 'large';
export type ContentWidth = 'narrow' | 'medium' | 'wide' | 'full';
/** Hex without the hash. Validated, because it becomes a CSS colour. */
export type Accent = string;

export interface Preferences {
  theme: ThemePreference;
  /** Sidebar open state, kept here so the window reopens the way it was left. */
  sidebarOpen: boolean;
  textSize: TextSize;
  contentWidth: ContentWidth;
  accent: Accent;
  /** Percent. Clamped on read so a hand-edited 4000 cannot brick the UI. */
  zoom: number;
  /** Sidebar width in pixels. Clamped to the same range the drag allows. */
  sidebarWidth: number;
  /**
   * The local user's name.
   *
   * There are no accounts, so this is a name the person typed. It is what
   * "last edited by" shows, and it is empty by default: a blank name is
   * honest, where a made-up one would be a lie about who touched the page.
   */  profileName: string;
  /**
   * Debug mode.
   *
   * Off by default. It shows things that are normally hidden: the AI bubble
   * even when AI is off, a diagnostics readout, and the command log.
   */
  debug: boolean;
}

const STORAGE_KEY = 'openfield.preferences';

/**
 * Light, not the operating system.
 *
 * This is the one deliberate divergence from the obvious choice. Following the
 * OS means a first run on a dark machine opens dark, and the first thing a new
 * user sees looks like a different product from the one they installed. Light is
 * also the mode that can be read on a projector and printed, so it is the safer
 * default for a document editor. 'system' stays available as an explicit choice.
 */
const DEFAULTS: Preferences = {
  theme: 'light',
  sidebarOpen: true,
  textSize: 'medium',
  contentWidth: 'medium',
  accent: '3b82f6',
  zoom: 100,
  sidebarWidth: 260,
  profileName: '',
  debug: false,
};

const THEMES: readonly string[] = ['system', 'light', 'dark'];
const TEXT_SIZES: readonly string[] = ['small', 'medium', 'large'];
const WIDTHS: readonly string[] = ['narrow', 'medium', 'wide', 'full'];

/** Sidebar drag limits. Below the minimum the tree stops being readable; above
 * the maximum the editor stops being the point. */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;

/** The accents on offer. A free colour picker lets people pick an unreadable one. */
export const ACCENTS: { value: Accent; label: string }[] = [
  { value: '3b82f6', label: 'Blue' },
  { value: '6366f1', label: 'Indigo' },
  { value: '0d9488', label: 'Teal' },
  { value: 'c026d3', label: 'Magenta' },
  { value: 'ea580c', label: 'Orange' },
];

function isTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEMES.includes(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value) ? (value as T) : fallback;
}

function isHex6(value: unknown): value is Accent {
  return typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value);
}

/**
 * Read preferences, replacing anything unrecognised with its default.
 *
 * Exported as a pure function of its argument so the validation can be tested
 * without a browser, which is the only reason the fallback logic is worth having
 * at all -- otherwise it is code nobody exercises.
 */
export function normalise(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS };
  const candidate = raw as Partial<Record<keyof Preferences, unknown>>;

  return {
    // An unknown theme falls back rather than throwing. A build that adds a
    // theme must not make an older build un-openable.
    theme: isTheme(candidate.theme) ? candidate.theme : DEFAULTS.theme,
    // `!== false` rather than a truthiness test: a missing key and an explicit
    // false are different intentions, and only one of them means "closed".
    sidebarOpen: candidate.sidebarOpen !== false,
    textSize: oneOf(candidate.textSize, TEXT_SIZES, DEFAULTS.textSize),
    contentWidth: oneOf(candidate.contentWidth, WIDTHS, DEFAULTS.contentWidth),
    accent: isHex6(candidate.accent) ? candidate.accent.toLowerCase() : DEFAULTS.accent,
    // Clamped rather than rejected: 4000 is a typo, not an attack. Falling back
    // to 100 would look like the setting had no effect; clamping keeps the
    // user's intent visible as an extreme value they can drag back.
    zoom:
      typeof candidate.zoom === 'number' && Number.isFinite(candidate.zoom)
        ? Math.min(200, Math.max(50, Math.round(candidate.zoom)))
        : DEFAULTS.zoom,
    // The drag clamps to the same range, so a stored value outside it is a
    // stale one and gets pulled back to something the UI can lay out.
    sidebarWidth:
      typeof candidate.sidebarWidth === 'number' && Number.isFinite(candidate.sidebarWidth)
        ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(candidate.sidebarWidth)))
        : DEFAULTS.sidebarWidth,
    // Trimmed and length-capped. A name is shown in a header next to a
    // timestamp, so an unbounded one would push the layout around.
    profileName:
      typeof candidate.profileName === 'string'
        ? candidate.profileName.trim().slice(0, 64)
        : DEFAULTS.profileName,
    // `=== false` rather than a truthiness test: a missing key and an explicit
    // false are different intentions, and only one of them means "off".
    debug: candidate.debug === true,
  };
}

let current: Preferences = readFromStorage();
const listeners = new Set<() => void>();

function readFromStorage(): Preferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return normalise(JSON.parse(raw));
  } catch {
    // Unparseable JSON, or storage unavailable entirely -- private mode, a
    // locked profile, a quota. Preferences are not worth failing to open over.
    return { ...DEFAULTS };
  }
}

function writeToStorage(value: Preferences): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A preference that will not persist is still worth applying this session.
  }
}

/** Merge a partial change in, validate the result, store and notify. */
export function setPreferences(patch: Partial<Preferences>): Preferences {
  current = normalise({ ...current, ...patch });
  writeToStorage(current);
  for (const listener of listeners) listener();
  return current;
}

export function getPreferences(): Preferences {
  return current;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The theme actually to paint, which is not always the preference.
 *
 * 'system' has to be resolved against the OS, and it has to keep resolving: a
 * user who chose 'system' expects the window to follow the machine when it
 * changes at sunset, not just at launch. Returning the resolved value rather
 * than the preference means callers never have to know which one they hold.
 */
export function resolveTheme(
  preference: ThemePreference,
  query: { matches: boolean } | undefined,
): 'light' | 'dark' {
  if (preference === 'system') return query?.matches ? 'dark' : 'light';
  return preference;
}

/**
 * The CSS custom properties these preferences drive.
 *
 * Returned as a plain object rather than applied here, so the mapping is a pure
 * function and can be asserted in a unit test without a DOM. The caller sets
 * them on `documentElement`.
 *
 * The width values are a ramp rather than one adjustable number because each
 * stop corresponds to a reading measure people already know -- a narrow column,
 * a page, a page plus room, the whole window. "Content width: 742px" tells
 * nobody anything useful.
 */
export function appearanceVars(prefs: Preferences): Record<string, string> {
  const scale = { small: '0.925', medium: '1', large: '1.1' }[prefs.textSize];
  const width = { narrow: '620px', medium: '760px', wide: '1000px', full: 'none' }[prefs.contentWidth];
  return {
    '--ow-scale': scale,
    '--ow-content-width': width,
    '--ow-accent': `#${prefs.accent}`,
    // Zoom is a font-size multiplier on the root so every rem-derived size in the
    // app scales together. Scaling the root font-size rather than applying a CSS
    // transform keeps text crisp and keeps scrolling and hit-testing correct.
    '--ow-zoom': String(prefs.zoom / 100),
  };
}