/**
 * Rich text: an array of runs carrying marks.
 *
 * Design rules, in priority order:
 *
 *  1. **Marks overlap.** A run is a single style, and inline styling is applied
 *     by splitting at mark boundaries. Nothing here assumes one mark per run.
 *  2. **Adjacent runs with identical marks are merged.** Without this,
 *     repeatedly toggling bold leaves a run list that grows without bound and
 *     that two structurally identical documents compare unequal.
 *  3. **Plain text is derived, never stored.** `textOf` is the single source of
 *     truth for "what does this block say", so search, formulas, export and the
 *     sidebar title can never disagree with the editor.
 *
 * Inline values (page mentions, dates, equations) are inline *nodes* inside a
 * run rather than marks, because they carry data and must stay in sync with
 * their target. `InlineNode` models all of them behind one tagged union.
 */

export type Mark =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'code'
  | 'commentRef';

/** A named palette entry for text and background colour. */
export type ColorName =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red';

export interface Link {
  href: string;
  /** Page id when the link points inside this workspace. */
  pageId?: string;
}

/**
 * A data-carrying inline value. Distinct from a mark because it has an identity
 * that must track a target: renaming a mentioned page has to update the pill.
 */
export type InlineNode =
  | { kind: 'page'; pageId: string; label?: string }
  | { kind: 'date'; iso: string; label?: string }
  | { kind: 'mention'; personId: string; label?: string }
  | { kind: 'equation'; latex: string }
  | { kind: 'tag'; name: string }
  | { kind: 'linkPreview'; href: string; label?: string };

export interface TextRun {
  text: string;
  marks?: Mark[];
  color?: ColorName;
  background?: ColorName;
  link?: Link;
  inline?: InlineNode;
}

export type InlineContent = TextRun[];

/** Everything needed to render one block's own text. */
export interface Content {
  runs: InlineContent;
}

export function emptyContent(): Content {
  return { runs: [] };
}

function marksOf(run: TextRun): Mark[] {
  return run.marks ? [...run.marks].sort() : [];
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  if (a.color !== b.color) return false;
  if (a.background !== b.background) return false;
  const la = a.link?.href ?? null;
  const lb = b.link?.href ?? null;
  if (la !== lb) return false;
  const pa = a.link?.pageId ?? null;
  const pb = b.link?.pageId ?? null;
  if (pa !== pb) return false;
  const ia = a.inline ? JSON.stringify(a.inline) : null;
  const ib = b.inline ? JSON.stringify(b.inline) : null;
  if (ia !== ib) return false;
  const ma = marksOf(a);
  const mb = marksOf(b);
  return ma.length === mb.length && ma.every((m, i) => m === mb[i]);
}

/**
 * Normalise a run list: drop empty text, merge adjacent runs with identical
 * styling. Every write path funnels through this, so two structurally identical
 * documents are always byte-identical after a round trip.
 */
export function normalizeRuns(runs: InlineContent): InlineContent {
  const out: InlineContent = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, run)) {
      prev.text += run.text;
      continue;
    }
    out.push({ ...run, ...(run.marks ? { marks: marksOf(run) } : {}) });
  }
  return out;
}

export function normalizeContent(content: Content | InlineContent): Content {
  const runs = Array.isArray(content) ? content : content.runs;
  return { runs: normalizeRuns(runs) };
}

/**
 * The plain text of a content value. Single source of truth for derived text.
 *
 * Accepts either a full `Content` or a bare runs array. The editing operations
 * work in runs while the storage and export layers work in `Content`, and
 * mixing them up yields `{ runs: undefined }` deep inside text extraction where
 * the cause is no longer visible -- so both spellings are accepted here instead.
 */
export function textOf(content: Content | InlineContent): string {
  const runs = Array.isArray(content) ? content : content.runs;
  let s = '';
  for (const run of runs) s += run.text;
  return s;
}

export function isBlank(content: Content | InlineContent): boolean {
  const runs = Array.isArray(content) ? content : content.runs;
  return textOf(runs).trim().length === 0 && !runs.some((r) => r.inline);
}

export function contentEquals(a: Content, b: Content): boolean {
  const ra = normalizeRuns(a.runs);
  const rb = normalizeRuns(b.runs);
  if (ra.length !== rb.length) return false;
  return ra.every((run, i) => {
    const other = rb[i]!;
    return run.text === other.text && sameStyle(run, other);
  });
}

/** Build a single unstyled run. */
export function text(value: string): TextRun {
  return { text: value };
}

export function plain(value: string): Content {
  return value.length === 0 ? emptyContent() : { runs: [{ text: value }] };
}

/** Toggle a mark across a slice of runs, splitting where needed. */
export function toggleMark(runs: InlineContent, from: number, to: number, mark: Mark): InlineContent {
  // Decide by the first run that actually overlaps the selection, which is what
  // a user expects when a selection straddles a partly-bold word.
  let present = false;
  let seen = false;
  for (const run of runs) {
    if (!run.text.length) continue;
    const end = from + run.text.length;
    if (end > from && from < to) {
      seen = true;
      if (run.marks?.includes(mark)) {
        present = true;
        break;
      }
    }
  }
  return applyMark(runs, from, to, mark, seen && !present);
}

export function applyMark(
  runs: InlineContent,
  from: number,
  to: number,
  mark: Mark,
  on: boolean,
): InlineContent {
  if (to <= from) return normalizeRuns(runs);
  const out: InlineContent = [];
  let pos = 0;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    const overlaps = end > from && start < to;
    if (!overlaps) {
      out.push({ ...run });
      continue;
    }
    const cutLeft = Math.max(0, from - start);
    const cutRight = Math.min(run.text.length, to - start);
    if (cutLeft > 0) out.push({ ...run, text: run.text.slice(0, cutLeft) });
    const middle = run.text.slice(cutLeft, cutRight);
    if (middle.length) {
      const marks = new Set(run.marks ?? []);
      if (on) marks.add(mark);
      else marks.delete(mark);
      const next: TextRun = { ...run, text: middle };
      if (marks.size) next.marks = [...marks].sort();
      else delete next.marks;
      out.push(next);
    }
    if (cutRight < run.text.length) out.push({ ...run, text: run.text.slice(cutRight) });
  }
  return normalizeRuns(out);
}

/** Replace a slice with plain text, preserving marks on the untouched edges. */
export function spliceText(runs: InlineContent, from: number, to: number, value: string): InlineContent {
  const head = sliceText(runs, 0, from);
  const tail = sliceText(runs, to, lengthOf(runs));
  return normalizeRuns([...head, ...(value ? [{ text: value }] : []), ...tail]);
}

export function lengthOf(runs: InlineContent): number {
  let n = 0;
  for (const run of runs) n += run.text.length;
  return n;
}

/** Substring with marks preserved: the slice may split a run. */
export function sliceText(runs: InlineContent, from: number, to: number): InlineContent {
  const out: InlineContent = [];
  let pos = 0;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    if (end <= from || start >= to) continue;
    const a = Math.max(0, from - start);
    const b = Math.min(run.text.length, to - start);
    out.push({ ...run, text: run.text.slice(a, b) });
  }
  return out.filter((r) => r.text.length > 0);
}

/** Every mark present anywhere in the content, for toolbar state. */
/**
 * Apply or clear a link across a slice of runs.
 *
 * Separate from `toggleMark` because a link is not a mark: it carries a target,
 * so "toggle" is ambiguous when a selection spans two different links. Setting is
 * explicit and clearing is explicit, which is why this takes a `Link | null`
 * rather than a boolean.
 *
 * Runs are split at the boundaries first, for the same reason toggling a mark
 * splits: marking half of a run would otherwise leave the other half marked.
 */
export function setLink(
  runs: InlineContent,
  from: number,
  to: number,
  link: Link | null,
): InlineContent {
  if (to <= from) return runs;
  const head = sliceText(runs, 0, from);
  const middle = sliceText(runs, from, to);
  const tail = sliceText(runs, to, lengthOf(runs));
  return normalizeRuns([
    ...head,
    // Only the linked slice gets the target. Spreading the whole run keeps the
    // text and its marks; dropping `link` when null clears a link that was
    // already there rather than setting one to undefined in place.
    ...middle.map((run) => (link ? { ...run, link } : { ...run, link: undefined })),
    ...tail,
  ]);
}

/**
 * Paint a slice of runs with a text colour, a background colour, or both.
 *
 * Same shape as `setLink` and for the same reason: colour carries a value, so
 * there is nothing to toggle against. `default` and an omitted field both mean
 * "no colour", which is what lets one command both paint and clear.
 *
 * Only the name is stored. The palette itself lives in the design tokens, so
 * renaming a hue does not need a migration and a page written today renders in
 * tomorrow's palette.
 */
export function setColor(
  runs: InlineContent,
  from: number,
  to: number,
  color: ColorName | undefined,
  background: ColorName | undefined,
): InlineContent {
  if (to <= from) return runs;
  const head = sliceText(runs, 0, from);
  const middle = sliceText(runs, from, to);
  const tail = sliceText(runs, to, lengthOf(runs));
  // Normalising the default to "absent" here rather than at every call site:
  // `data-color='default'` and no attribute at all should not be two states.
  const text = color === 'default' ? undefined : color;
  const back = background === 'default' ? undefined : background;
  return normalizeRuns([
    ...head,
    ...middle.map((run) => ({ ...run, color: text, background: back })),
    ...tail,
  ]);
}

/**
 * Replace a slice of text with an inline node, or remove one.
 *
 * An inline node occupies characters like any other text, so this is a replace
 * rather than an annotation: the slice becomes a run whose text is the label and
 * which carries the node. Keeping the label as real text rather than as
 * something the renderer invents means `textOf` still returns what the user
 * sees, so search, export and word count all agree with the screen.
 *
 * Passing null removes the node but keeps the characters -- deleting a mention
 * should not silently delete the words around it.
 */
export function setInline(
  runs: InlineContent,
  from: number,
  to: number,
  node: InlineNode | null,
  label = '',
): InlineContent {
  if (to < from) return runs;
  const head = sliceText(runs, 0, from);
  const tail = sliceText(runs, to, lengthOf(runs));

  if (node === null) {
    // Clearing keeps the existing characters and drops the node from them.
    const middle = sliceText(runs, from, to).map((run) => ({ ...run, inline: undefined }));
    return normalizeRuns([...head, ...middle, ...tail]);
  }

  const text = label || ('label' in node ? node.label ?? '' : '');
  if (text.length === 0) return runs;
  return normalizeRuns([...head, { text, inline: node }, ...tail]);
}

/**
 * The inline node covering a character offset, if any.
 *
 * Offsets are matched by run position, so a caller needs to know that offset 3
 * is inside a mention before it tries to replace text that overlaps one.
 */
export function inlineAt(runs: InlineContent, offset: number): InlineNode | null {
  let seen = 0;
  for (const run of runs) {
    const len = run.text.length;
    if (offset >= seen && offset < seen + len) return run.inline ?? null;
    seen += len;
  }
  return null;
}

export function activeMarks(runs: InlineContent): Set<Mark> {
  const out = new Set<Mark>();
  for (const run of runs) for (const m of run.marks ?? []) out.add(m);
  return out;
}

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * The offset of the start of the grapheme cluster ending at `offset`.
 *
 * Backspace must delete a whole user-perceived character, not a UTF-16 code
 * unit. Deleting one code unit of an emoji leaves half a surrogate pair, which
 * renders as a replacement character. Emoji sequences made of several code
 * points joined by zero-width joiners must also go in one keystroke, which is
 * why this uses grapheme segmentation rather than a surrogate-pair check.
 */
export function graphemeStartBefore(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (segmenter) {
    let start = 0;
    for (const seg of segmenter.segment(text)) {
      if (seg.index >= offset) break;
      start = seg.index;
    }
    return start;
  }
  // Fallback: step back over a low surrogate, then over any trailing combining
  // marks, zero-width joiners and variation selectors.
  let i = offset - 1;
  while (i > 0 && /[\u0300-\u036F\u200D\uFE0F\u20E3]/.test(text[i - 1] ?? '')) i -= 1;
  if (i > 0) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) i -= 1;
  }
  return i;
}