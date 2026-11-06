/**
 * Markdown and CSV export.
 *
 * Pure functions over the model, with no storage and no filesystem, so the
 * interesting part -- what each block type becomes -- is testable without a
 * database or a workspace. The command layer wraps them; it does not re-implement
 * them.
 *
 * Two decisions worth stating, because both are lossy and a reader will notice:
 *
 * - Colour and comments are dropped. Markdown has no syntax for either, and
 *   inventing one (`<span style=...>`) produces a file that reads as broken in
 *   every other renderer. Inline code, bold, italic, strike and links survive.
 * - A checkbox item exports as a GitHub task list, which round-trips through
 *   the importer. `[]` / `[x]` is the one checkbox syntax with real support
 *   elsewhere.
 */

import type { Block, Doc } from './doc.js';
import type { Content, TextRun } from './rich-text.js';

/** One database row, as far as export cares. Declared here rather than imported
 * from the desktop view model: the model layer sits below the app, so importing
 * upward would invert the dependency and fail the layering gate. */
export interface ExportRow {
  title: string;
  values: Record<string, unknown>;
}

export interface ExportProperty {
  id: string;
  name: string;
  type: string;
}

/** Block types that hold no text, so an empty markdown file is still correct. */
const NO_TEXT = new Set(['divider', 'image', 'video', 'audio', 'file', 'pdf', 'bookmark', 'embed']);

function textOf(content: Content): string {
  return content.runs
    .map((run) => (typeof run === 'string' ? run : (run as TextRun).text))
    .join('');
}

/**
 * Render inline runs as markdown, merging adjacent runs that agree.
 *
 * Merging matters for correctness, not tidiness: two adjacent bold runs must
 * produce one `**...**`, because `**a****b**` is valid markdown but ugly, and
 * a mark boundary in the middle of a word (`bo` bold + `ld`) would otherwise
 * emit `**bo**ld`, which is what the original formatting said anyway.
 */
function inline(content: Content): string {
  const merged: { text: string; marks: Set<string>; link?: string }[] = [];
  for (const run of content.runs) {
    const r: TextRun = typeof run === 'string' ? { text: run } : run;
    // An inline node is its own thing and is never merged with its
    // neighbours: merging would lose the boundary that makes it a link.
    if (r.inline) {
      merged.push({ text: inlineNodeText(r), marks: new Set<string>(), link: undefined });
      continue;
    }
    const marks = new Set((r.marks ?? []).map((m) => String(m)));
    const link = r.link?.href;
    const last = merged[merged.length - 1];
    if (last && last.link === link && sameSet(last.marks, marks)) {
      last.text += r.text;
    } else {
      merged.push({ text: r.text, marks, link });
    }
  }

  return merged
    .map(({ text, marks, link }) => {
      let out = text;
      // Code goes innermost: bold inside `code` is not a thing in markdown, and
      // wrapping the other way round produces asterisks the user sees.
      if (marks.has('code')) out = `\`${out}\``;
      if (marks.has('bold')) out = `**${out}**`;
      if (marks.has('italic')) out = `*${out}*`;
      if (marks.has('strikethrough')) out = `~~${out}~~`;
      if (link) out = `[${out}](${link})`;
      return out;
    })
    .join('');
}

/**
 * The markdown for an inline node.
 *
 * The same syntaxes the importer reads, so a page written in the editor and a
 * page read from a file are the same page.
 */
function inlineNodeText(run: TextRun): string {
  const node = run.inline;
  if (!node) return run.text;
  switch (node.kind) {
    case 'equation':
      return `$${node.latex}$`;
    case 'tag':
      return `#${node.name}`;
    case 'page':
      return `[[${node.label ?? ''}]]`;
    default:
      return run.text;
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function blockLine(block: Block, depth: number): string[] {
  const text = inline(block.content);
  const indent = '  '.repeat(Math.max(0, depth));
  switch (block.type) {
    case 'heading1':
      return [`# ${text}`];
    case 'heading2':
      return [`## ${text}`];
    case 'heading3':
      return [`### ${text}`];
    case 'bulletedListItem':
      return [`${indent}- ${text}`];
    case 'numberedListItem':
      return [`${indent}1. ${text}`];
    case 'todo':
      return [`${indent}- [${block.props?.checked ? 'x' : ' '}] ${text}`];
    case 'toggle':
      return [`${indent}- ${text}`];
    case 'quote':
      return text
        .split('\n')
        .map((line) => `> ${line}`);
    case 'code':
      return ['```', text, '```'];
    case 'divider':
      return ['---'];
    case 'callout': {
      // The kind is written back, so a callout survives a round trip through
      // Markdown as a callout and not as a quote.
      const kind = block.props?.calloutKind;
      const body = kind ? `[!${kind}] ${text}` : text;
      return [`> ${body}`];
    }
    default:
      // Anything unrecognised still exports its text rather than vanishing. A
      // block type that silently disappears from an export is worse than one
      // that comes out as a paragraph.
      return text.length > 0 ? [text] : [];
  }
}

/** Flatten in document order, recording depth so nested lists keep their indent. */
function flatten(doc: Doc): { block: Block; depth: number }[] {
  const out: { block: Block; depth: number }[] = [];
  const visit = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = doc.blocks[id];
      if (!block || block.trashedAt !== null) continue;
      out.push({ block, depth });
      visit(block.children, depth + 1);
    }
  };
  visit(doc.roots, 0);
  return out;
}

/** The whole page as a markdown document, title as an H1 unless a block is also H1. */
export function docToMarkdown(doc: Doc, title?: string): string {
  const out: string[] = [];
  if (title && title.trim().length > 0) out.push(`# ${title.trim()}`, '');
  for (const { block, depth } of flatten(doc)) {
    if (NO_TEXT.has(block.type) && block.type !== 'divider') continue;
    out.push(...blockLine(block, depth));
    out.push('');
  }
  // Collapse the trailing blank lines into a single newline so the file ends
  // once, not with a run of them.
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------- CSV

/**
 * Quote a CSV field only when it needs it.
 *
 * Always quoting is the usual shortcut and it makes every file ugly; never
 * quoting is a data-corrupting bug. This quotes on the three conditions that
 * actually break a parser: a delimiter, a quote, or a line break.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Database rows as CSV, one line per row, header from the property names.
 *
 * Property ids are the key; names are the label. Anything named after the title
 * property would silently produce a `title` column as well, so it is excluded.
 */
export function rowsToCsv(rows: ExportRow[], properties: ExportProperty[]): string {
  const columns = properties.filter((p) => p.type !== 'title');
  const header = ['Name', ...columns.map((p) => p.name)];
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) {
    // The title goes through the same quoting as every other cell. Joining it
    // raw is how a row called "Do it, now" becomes two columns.
    const cells = [csvField(row.title), ...columns.map((p) => csvField(row.values[p.id]))];
    lines.push(cells.join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}