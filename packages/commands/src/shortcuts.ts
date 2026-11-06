/**
 * Keyboard shortcuts, verified.
 *
 * Every chord in this file comes from the operator-supplied published shortcut
 * reference, not from inference. Several were guesses before that reference
 * arrived and were wrong; the corrections are recorded below because a wrong
 * shortcut is worse than a missing one, since the user has muscle memory.
 *
 * Platform note: the reference writes most chords as `cmd/ctrl`. On Windows the
 * modifier is Ctrl. The turn-into chords are the exception -- they are
 * `cmd+option` on macOS but `ctrl+shift` on Windows and Linux -- so they are
 * spelled per platform rather than shared.
 *
 * Chord syntax is normalised by the registry: modifiers sort, the base key is
 * lowercased, so `Ctrl+Shift+P` and `ctrl+shift+p` are one binding.
 */

export interface KeyChord {
  /** Windows and Linux. */
  win: string;
  /** macOS, where Command replaces Ctrl for most chords. */
  mac: string;
}

/**
 * Turn-into chords.
 *
 * The digit mapping was guessed before the reference arrived and was wrong.
 * The correct mapping is positional and, usefully, self-describing:
 *
 *   0 text   1 H1   2 H2   3 H3   4 to-do
 *   5 bullet 6 num  7 toggle 8 code 9 page
 *
 * Note the consequence: digit 5 is a bulleted list, not a heading, and 9 is a
 * page. Anyone guessing "0-9 maps to text..H3 then the rest" would get three of
 * the ten wrong.
 */
export const TURN_INTO_CHORDS: Record<string, KeyChord> = {
  paragraph: { win: 'ctrl+shift+0', mac: 'cmd+option+0' },
  heading1: { win: 'ctrl+shift+1', mac: 'cmd+option+1' },
  heading2: { win: 'ctrl+shift+2', mac: 'cmd+option+2' },
  heading3: { win: 'ctrl+shift+3', mac: 'cmd+option+3' },
  todo: { win: 'ctrl+shift+4', mac: 'cmd+option+4' },
  bulletedListItem: { win: 'ctrl+shift+5', mac: 'cmd+option+5' },
  numberedListItem: { win: 'ctrl+shift+6', mac: 'cmd+option+6' },
  toggle: { win: 'ctrl+shift+7', mac: 'cmd+option+7' },
  code: { win: 'ctrl+shift+8', mac: 'cmd+option+8' },
  page: { win: 'ctrl+shift+9', mac: 'cmd+option+9' },
};

/**
 * Every shortcut we implement, in one table.
 *
 * Kept as data rather than inline literals on the commands so that the cheat
 * sheet, the conflict check and the commands themselves all read from the same
 * source. The registry still fails the build on a conflict, which is the point.
 */
export const SHORTCUTS = {
  // --- formatting -----------------------------------------------------------
  bold: { win: 'ctrl+b', mac: 'cmd+b' },
  italic: { win: 'ctrl+i', mac: 'cmd+i' },
  underline: { win: 'ctrl+u', mac: 'cmd+u' },
  strikethrough: { win: 'ctrl+shift+s', mac: 'cmd+shift+s' },
  inlineCode: { win: 'ctrl+e', mac: 'cmd+e' },
  link: { win: 'ctrl+k', mac: 'cmd+k' },
  comment: { win: 'ctrl+shift+m', mac: 'cmd+shift+m' },
  /** Re-apply the most recent text or background colour. */
  lastColor: { win: 'ctrl+shift+h', mac: 'cmd+shift+h' },

  // --- blocks ---------------------------------------------------------------
  /** Open the block menu: change type, colour, duplicate, move, delete. */
  blockMenu: { win: 'ctrl+/', mac: 'cmd+/' },
  duplicate: { win: 'ctrl+d', mac: 'cmd+d' },
  moveBlockUp: { win: 'ctrl+shift+up', mac: 'cmd+shift+up' },
  moveBlockDown: { win: 'ctrl+shift+down', mac: 'cmd+shift+down' },
  /** Modify the current block: open a page, tick a to-do, open a toggle. */
  modifyBlock: { win: 'ctrl+enter', mac: 'cmd+enter' },
  /** Expand or collapse every toggle in a toggle list. */
  toggleAllToggles: { win: 'ctrl+alt+t', mac: 'cmd+option+t' },
  /** Go up one level of the page hierarchy. */
  goUpLevel: { win: 'ctrl+shift+u', mac: 'cmd+shift+u' },
  indent: { win: 'tab', mac: 'tab' },
  outdent: { win: 'shift+tab', mac: 'shift+tab' },

  // --- navigation -----------------------------------------------------------
  /** Quick find. The reference also accepts ctrl+K here, which collides with
   *  "add link" -- so link wins in a text selection and search wins otherwise. */
  quickFind: { win: 'ctrl+p', mac: 'cmd+p' },
  quickFindAlt: { win: 'ctrl+k', mac: 'cmd+p' },
  /** Search within the open page. */
  findInPage: { win: 'ctrl+f', mac: 'cmd+f' },
  copyPageLink: { win: 'ctrl+l', mac: 'cmd+l' },
  back: { win: 'ctrl+[', mac: 'cmd+[' },
  forward: { win: 'ctrl+]', mac: 'cmd+]' },

  // --- history --------------------------------------------------------------
  undo: { win: 'ctrl+z', mac: 'cmd+z' },
  redo: { win: 'ctrl+shift+z', mac: 'cmd+shift+z' },

  // --- app ------------------------------------------------------------------
  newPage: { win: 'ctrl+n', mac: 'cmd+n' },
  newWindow: { win: 'ctrl+shift+n', mac: 'cmd+shift+n' },
  newTab: { win: 'ctrl+t', mac: 'cmd+t' },
  /** Toggle between dark and light. Not "sidebar toggle" -- see the ledger. */
  toggleTheme: { win: 'ctrl+shift+l', mac: 'cmd+shift+l' },
  zoomIn: { win: 'ctrl+=', mac: 'cmd+=' },
  zoomOut: { win: 'ctrl+-', mac: 'cmd+-' },
} as const satisfies Record<string, KeyChord>;

export type ShortcutName = keyof typeof SHORTCUTS;

/**
 * Corrections made when the published reference arrived.
 *
 * Recorded because "we guessed this and were wrong" is useful information: it
 * tells a future reader which parts of this table are load-bearing and which
 * were once plausible.
 */
export const CORRECTIONS = [
  {
    chord: 'ctrl+shift+0..9',
    was: 'assumed a positional text/heading sequence',
    now: '0 text, 1 H1, 2 H2, 3 H3, 4 to-do, 5 bullet, 6 num, 7 toggle, 8 code, 9 page',
    impact: 'Ten chords, all of them previously wrong.',
  },
  {
    chord: 'ctrl+shift+l',
    was: 'not bound',
    now: 'toggle between dark and light mode',
    impact: 'This is the theme switch, not anything block-related.',
  },
  {
    chord: 'ctrl+k',
    was: 'add link (unqualified)',
    now: 'add link with a selection; open quick find otherwise',
    impact:
      'The two meanings collide. A selection is the disambiguator, because that is ' +
      'the only state in which "wrap the selection in a link" is meaningful.',
  },
  {
    chord: 'markdown ">"',
    was: 'quote block',
    now: 'toggle list',
    impact: 'Quotes are created with a double quote instead.',
  },
  {
    chord: 'markdown "[]"',
    was: 'accepted both "[]" and "[ ]"',
    now: '"[]" only',
    impact: 'The spaced form swallowed text the user meant literally.',
  },
  {
    chord: 'markdown numbered list',
    was: '"1." only',
    now: '"1.", "a." and "i."',
    impact: 'Nested lists change numeral style without a separate command.',
  },
  {
    chord: 'ctrl+shift+m',
    was: 'guessed comment',
    now: 'confirmed comment',
    impact: 'One guess happened to be right.',
  },
  {
    chord: 'ctrl+/',
    was: 'guessed block menu',
    now: 'confirmed block menu',
    impact: 'One guess happened to be right.',
  },
] as const;