/**
 * The block type registry.
 *
 * Every block type is one entry here. Adding a block means adding an entry plus
 * a renderer, not editing the core. This is what makes the slash menu, the
 * "turn into" menu, markdown shortcuts, keyboard behaviour and import/export
 * round trips all derive from a single description instead of being
 * hand-maintained lists that drift apart.
 *
 * `text` blocks are the leaves; `container` blocks (list items, toggles,
 * callouts, columns) hold children. `leafText` blocks accept only inline
 * content and never children.
 */

export type BlockKind = 'text' | 'leafText' | 'container';

export interface BlockDefinition {
  type: string;
  kind: BlockKind;
  /** Human label, also the primary slash-menu label. */
  label: string;
  /** Alternative words the slash menu should match. */
  aliases: string[];
  /** Slash-menu grouping key. */
  group: 'basic' | 'list' | 'media' | 'database' | 'advanced' | 'embed';
  /** Markdown trigger typed at the start of an empty block, trigger included. */
  markdown?: { pattern: RegExp; toType: string };
  /** Whether Enter splits into a sibling, and of what type. */
  enter?: 'split' | 'newline' | 'exit';
  /** Whether Backspace at offset 0 first unwraps the type into `unwrapsTo`. */
  unwrapsTo?: string;
  /** Whether this block may contain children. */
  canHaveChildren?: boolean;
  /** Blocks this one can be converted into, for "turn into". */
  turnInto?: string[];
  /** Whether Tab indents rather than moving focus. */
  indentable?: boolean;
  /** Whether the block renders a checkbox or a disclosure triangle. */
  toggleable?: boolean;
  /** Node or table nesting handled specially by the renderer. */
  special?: 'table' | 'database' | 'equation' | 'bookmark' | 'embed' | 'toc' | 'columns';
}

const d = (def: BlockDefinition): BlockDefinition => def;

const TEXT_LIKE = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'quote',
  'callout',
  'code',
];

/**
 * What a text-bearing block may be converted into.
 *
 * One shared list rather than a hand-written set per type. The earlier version
 * listed targets per block and the lists quietly diverged: a to-do could not
 * become a heading, which is exactly the kind of gap a user discovers only when
 * the "turn into" menu is missing the entry they want. Text-bearing blocks are
 * mutually convertible, so the rule is uniform by construction.
 */
const CONVERTIBLE = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletedListItem',
  'numberedListItem',
  'todo',
  'toggle',
  'quote',
  'callout',
  'code',
];

export const BLOCK_DEFINITIONS: BlockDefinition[] = [
  d({
    type: 'paragraph',
    kind: 'text',
    label: 'Text',
    aliases: ['plain', 'body', 'text'],
    group: 'basic',
    enter: 'split',
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'heading1',
    kind: 'text',
    label: 'Heading 1',
    aliases: ['h1', 'title', 'largest'],
    group: 'basic',
    markdown: { pattern: /^# $/, toType: 'heading1' },
    enter: 'split',
    unwrapsTo: 'paragraph',
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'heading2',
    kind: 'text',
    label: 'Heading 2',
    aliases: ['h2', 'subtitle'],
    group: 'basic',
    markdown: { pattern: /^## $/, toType: 'heading2' },
    enter: 'split',
    unwrapsTo: 'paragraph',
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'heading3',
    kind: 'text',
    label: 'Heading 3',
    aliases: ['h3'],
    group: 'basic',
    markdown: { pattern: /^### $/, toType: 'heading3' },
    enter: 'split',
    unwrapsTo: 'paragraph',
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'bulletedListItem',
    kind: 'container',
    label: 'Bulleted list',
    aliases: ['bullet', 'unordered', 'ul', 'li', 'bulleted list'],
    group: 'list',
    markdown: { pattern: /^[-*+] $/, toType: 'bulletedListItem' },
    enter: 'exit',
    unwrapsTo: 'paragraph',
    canHaveChildren: true,
    indentable: true,
    toggleable: true,
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'numberedListItem',
    kind: 'container',
    label: 'Numbered list',
    aliases: ['ordered', 'ol', 'number', 'num', 'numbered list'],
    group: 'list',
    // Three accepted markers, not one. The reference accepts "1.", "a." and "i."
    // on the same trigger, which is what lets a nested list change numeral style
    // without needing a separate command.
    markdown: { pattern: /^(?:1|a|i)\. $/, toType: 'numberedListItem' },
    enter: 'exit',
    unwrapsTo: 'paragraph',
    canHaveChildren: true,
    indentable: true,
    toggleable: true,
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'todo',
    kind: 'container',
    label: 'To-do list',
    // "todo" is what people type. The label's hyphen means the plain word is not
    // a substring of it, so without this alias the most obvious query for a
    // checkbox found nothing at all and Enter typed a newline instead.
    aliases: ['todo', 'task', 'checkbox', 'checklist'],
    group: 'list',
    // The reference trigger is "[]" with nothing between the brackets, not "[ ]".
    // Accepting a spaced form as well silently swallows text the user typed
    // intending as literal checkbox characters.
    markdown: { pattern: /^\[\] $/, toType: 'todo' },
    enter: 'exit',
    unwrapsTo: 'paragraph',
    canHaveChildren: true,
    indentable: true,
    toggleable: true,
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'toggle',
    kind: 'container',
    label: 'Toggle list',
    aliases: ['collapsible', 'disclosure', 'caret'],
    group: 'list',
    // ">" opens a TOGGLE list. This is the opposite of the intuitive
    // assignment, and the opposite of what an earlier version of this file had,
    // which bound ">" to a quote and left a toggle with no trigger at all.
    // Verified against the published shortcut reference.
    markdown: { pattern: /^> $/, toType: 'toggle' },
    enter: 'exit',
    unwrapsTo: 'paragraph',
    canHaveChildren: true,
    indentable: true,
    toggleable: true,
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'quote',
    kind: 'text',
    label: 'Quote',
    aliases: ['blockquote', 'citation'],
    group: 'basic',
    // A double quote opens a quote block, not a greater-than sign. See the note
    // on the toggle entry for why this reads backwards from intuition.
    markdown: { pattern: /^" $/, toType: 'quote' },
    enter: 'split',
    unwrapsTo: 'paragraph',
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'callout',
    kind: 'container',
    label: 'Callout',
    aliases: ['notice', 'aside', 'highlight'],
    group: 'basic',
    canHaveChildren: true,
    indentable: true,
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'code',
    kind: 'leafText',
    label: 'Code',
    aliases: ['snippet', 'preformatted', 'monospace'],
    group: 'basic',
    markdown: { pattern: /^```$/, toType: 'code' },
    enter: 'newline',
    unwrapsTo: 'paragraph',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'divider',
    kind: 'leafText',
    label: 'Divider',
    aliases: ['rule', 'separator', 'hr', 'div'],
    group: 'basic',
    enter: 'split',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'page',
    kind: 'leafText',
    label: 'Page',
    aliases: ['subpage', 'page link'],
    group: 'basic',
    enter: 'split',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'image',
    kind: 'leafText',
    label: 'Image',
    aliases: ['photo', 'picture', 'upload'],
    group: 'media',
    enter: 'split',
    turnInto: ['paragraph', 'video', 'file', 'pdf', 'bookmark'],
  }),
  d({
    type: 'video',
    kind: 'leafText',
    label: 'Video',
    aliases: ['movie', 'clip'],
    group: 'media',
    enter: 'split',
    turnInto: ['paragraph', 'image', 'file'],
  }),
  d({
    type: 'audio',
    kind: 'leafText',
    label: 'Audio',
    aliases: ['sound', 'recording'],
    group: 'media',
    enter: 'split',
    turnInto: ['paragraph', 'image', 'video', 'file'],
  }),
  d({
    type: 'file',
    kind: 'leafText',
    label: 'File',
    aliases: ['attachment', 'document', 'download'],
    group: 'media',
    enter: 'split',
    turnInto: ['paragraph', 'image', 'pdf'],
  }),
  d({
    type: 'pdf',
    kind: 'leafText',
    label: 'PDF',
    aliases: ['document', 'viewer'],
    group: 'media',
    enter: 'split',
    turnInto: ['paragraph', 'file'],
  }),
  d({
    type: 'bookmark',
    kind: 'leafText',
    label: 'Web bookmark',
    aliases: ['link', 'url', 'website'],
    group: 'media',
    enter: 'split',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'equation',
    kind: 'leafText',
    label: 'Block equation',
    aliases: ['math', 'formula', 'latex', 'katex'],
    group: 'advanced',
    enter: 'split',
    turnInto: ['paragraph', 'code'],
  }),
  d({
    type: 'tableOfContents',
    kind: 'leafText',
    label: 'Table of contents',
    aliases: ['toc', 'outline', 'contents'],
    group: 'advanced',
    enter: 'split',
    special: 'toc',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'breadcrumb',
    kind: 'leafText',
    label: 'Breadcrumb',
    aliases: ['path', 'trail'],
    group: 'advanced',
    enter: 'split',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'columns',
    kind: 'container',
    label: 'Columns',
    aliases: ['layout', 'side by side'],
    group: 'advanced',
    canHaveChildren: true,
    special: 'columns',
    turnInto: ['paragraph'],
  }),
  d({
    type: 'column',
    kind: 'container',
    label: 'Column',
    aliases: [],
    group: 'advanced',
    canHaveChildren: true,
    turnInto: CONVERTIBLE,
  }),
  d({
    type: 'table',
    kind: 'container',
    label: 'Table',
    aliases: ['grid'],
    group: 'basic',
    special: 'table',
    canHaveChildren: true,
    turnInto: ['paragraph', 'code'],
  }),
  d({
    type: 'tableRow',
    kind: 'container',
    label: 'Table row',
    aliases: [],
    group: 'basic',
    canHaveChildren: true,
  }),
  d({
    type: 'syncedBlock',
    kind: 'container',
    label: 'Synced block',
    aliases: ['sync', 'shared block'],
    group: 'advanced',
    canHaveChildren: true,
    turnInto: ['paragraph'],
  }),
  d({
    type: 'database',
    kind: 'leafText',
    label: 'Database',
    aliases: ['collection', 'table view', 'board view'],
    group: 'database',
    special: 'database',
    enter: 'split',
    turnInto: ['paragraph'],
  }),
];

const BY_TYPE = new Map<string, BlockDefinition>(BLOCK_DEFINITIONS.map((x) => [x.type, x]));

export function blockDef(type: string): BlockDefinition {
  const def = BY_TYPE.get(type);
  if (!def) throw new Error(`unknown block type: ${type}`);
  return def;
}

export function isKnownBlock(type: string): boolean {
  return BY_TYPE.has(type);
}

/**
 * Whether a block of this type may hold children.
 *
 * The rule is by kind rather than per-entry: a `leafText` block (code, divider,
 * image, table of contents) holds inline content only, while `text` and
 * `container` blocks may nest. That is what makes Tab work uniformly on ordinary
 * paragraphs and headings instead of only inside lists -- indenting a line of
 * prose is a thing users expect to be able to do.
 *
 * A per-entry `canHaveChildren: false` override is still honoured for the rare
 * case where a nesting block should not accept children.
 */
export function canHaveChildren(type: string): boolean {
  const def = BY_TYPE.get(type);
  if (!def) return false;
  if (def.canHaveChildren === false) return false;
  return def.kind !== 'leafText';
}

export function acceptsText(type: string): boolean {
  const kind = BY_TYPE.get(type)?.kind;
  return kind === 'text' || kind === 'container' || kind === 'leafText';
}

/** Blocks the slash menu should offer, grouped, in display order. */
export function slashEntries(): BlockDefinition[] {
  const order: Record<string, number> = {
    basic: 0,
    list: 1,
    media: 2,
    database: 3,
    advanced: 4,
    embed: 5,
  };
  return [...BLOCK_DEFINITIONS]
    .filter((x) => !['column', 'tableRow'].includes(x.type))
    .sort((a, b) => (order[a.group]! - order[b.group]!) || a.label.localeCompare(b.label));
}

/**
 * Every markdown shortcut that produces `type`, used to test the input rule
 * table without duplicating it in the editor layer.
 */
export function markdownTriggerFor(type: string): RegExp | undefined {
  return BY_TYPE.get(type)?.markdown?.pattern;
}

/**
 * Match a line of text against every markdown input trigger at once.
 *
 * The editor calls this when the user types a space, which is the moment a
 * trigger fires. Two details matter and both are easy to get wrong:
 *
 * - Patterns are anchored with `$`, so they only ever match at the end of the
 *   string. That is what stops "a * b " turning the whole line into a list.
 * - More than one definition can claim the same character, so the first match
 *   in declaration order wins. Declaration order is the order in this file, and
 *   it is deliberate: the specific triggers are declared before the general
 *   ones, so "1. " is claimed by the numbered list rather than by anything that
 *   also ends in a full stop.
 *
 * Returns null when nothing matches, which is the common case and costs one
 * pass over the definitions.
 */
export function markdownTriggerMatch(text: string): string | null {
  for (const def of BLOCK_DEFINITIONS) {
    const pattern = def.markdown?.pattern;
    if (pattern?.test(text)) return def.type;
  }
  return null;
}