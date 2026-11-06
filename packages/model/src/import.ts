import { latexText } from './latex.js';
/**
 * Markdown and CSV import.
 *
 * Parsers are where a small subset beats a complete grammar. This reads the
 * subset Openfield itself writes, which means a page exported from Openfield
 * round-trips, and it reads most hand-written markdown for the same reason. It
 * deliberately does not try to be CommonMark: half-supporting tables and nested
 * emphasis produces output that looks right and is not.
 *
 * Anything unrecognised becomes a paragraph. A parser that drops a line is worse
 * than one that mis-types it, because the loss is invisible until someone notices
 * a sentence is missing.
 */

import type { Doc } from './doc.js';
import { createDoc, insert } from './doc.js';
import type { Content } from './rich-text.js';

/** A parsed block, before it becomes a model block. */
interface ParsedBlock {
  type: string;
  text: string;
  depth: number;
  checked?: boolean;
  /** The kind of a callout: note, tip, info, warning or caution. */
  kind?: string;
}

/**
 * Inline markdown to a Content.
 *
 * Supports **bold**, *italic*, ~~strike~~, `code`, `$equation$` and `#tag`.
 *
 * A wiki link is deliberately *not* handled here. This function is pure and
 * knows nothing about which pages exist, so `[[Title]]` is left as text and
 * `resolveWikiLinks` turns it into a link at the layer that can look a page
 * up.
 */
export function parseInline(text: string): Content {
  const runs: Content['runs'] = [];
  // Alternation order is what makes this work: `**` is tried before `*`, and
  // the backtick fence is tried before either.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)|(\$[^$\n]+\$)|(?<=^|\s)(#[A-Za-z][\w/-]*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at) });
    const token = match[0];
    if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), marks: ['code'] });
    else if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), marks: ['bold'] });
    else if (token.startsWith('~~')) runs.push({ text: token.slice(2, -2), marks: ['strikethrough'] });
    else if (token.startsWith('$')) {
      const latex = token.slice(1, -1);
      runs.push({ text: latex, inline: { kind: 'equation', latex } });
    } else if (token.startsWith('#')) {
      runs.push({ text: token, inline: { kind: 'tag', name: token.slice(1) } });
    } else runs.push({ text: token.slice(1, -1), marks: ['italic'] });
    last = at + token.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return { runs };
}

/**
 * The kinds of callout.
 *
 * The syntax is the one every other tool that writes Markdown with callouts
 * uses: a quote line that starts with a bracketed kind.
 */
export const CALLOUT_KINDS = ['note', 'tip', 'info', 'warning', 'caution'] as const;

const CALLOUT_PATTERN = /^\[!(note|tip|info|warning|caution)\]\s*(.*)$/;

const INDENT = '  ';

function parseBlocks(markdown: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }

    // Fenced code first: its body must not be read as headings or lists.
    if (trimmed.startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence
      out.push({ type: 'code', text: body.join('\n'), depth: 0 });
      continue;
    }

    if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(trimmed)) {
      out.push({ type: 'divider', text: '', depth: 0 });
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      out.push({
        type: level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3',
        text: heading[2] ?? '',
        depth: 0,
      });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('> ')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('> ')) {
        body.push(lines[i]!.trim().slice(2));
        i += 1;
      }
      // A callout is a quote whose first line names the kind. The kind is
      // taken off the text and kept as a property, so the round trip through
      // Markdown does not turn it back into a quote.
      const joined = body.join('\n');
      const callout = CALLOUT_PATTERN.exec(joined);
      if (callout) {
        out.push({
          type: 'callout',
          text: callout[2] ?? '',
          depth: 0,
          kind: callout[1] ?? 'note',
        });
        continue;
      }
      out.push({ type: 'quote', text: joined, depth: 0 });
      continue;
    }

    // Indent is measured in the two-space units the exporter writes, so a page
    // that leaves and comes back keeps its nesting.
    const depth = Math.floor((line.length - line.trimStart().length) / INDENT.length);
    const body = trimmed;

    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(body);
    if (task) {
      out.push({
        type: 'todo',
        text: task[2] ?? '',
        depth,
        checked: (task[1] ?? ' ').toLowerCase() === 'x',
      });
      i += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(body)) {
      out.push({ type: 'bulletedListItem', text: body.replace(/^[-*+]\s+/, ''), depth });
      i += 1;
      continue;
    }

    if (/^\d+[.)]\s+/.test(body)) {
      out.push({ type: 'numberedListItem', text: body.replace(/^\d+[.)]\s+/, ''), depth });
      i += 1;
      continue;
    }

    // A bare line followed by another bare line is one paragraph, not two.
    const paragraph: string[] = [body];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!.trim();
      if (next === '') break;
      if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```)/.test(next)) break;
      paragraph.push(next);
      i += 1;
    }
    out.push({ type: 'paragraph', text: paragraph.join('\n'), depth: 0 });
  }

  return out;
}

/**
 * Markdown into a fresh document.
 *
 * Nested blocks are attached by depth to the nearest shallower block above them,
 * which is the only nesting rule that needs no lookahead: when the next block is
 * deeper, the previous one is the parent, and when it is not, nothing is.
 */
export function markdownToDoc(markdown: string): Doc {
  const doc = createDoc();
  const parents: string[] = [];
  for (const parsed of parseBlocks(markdown)) {
    // Climb to the shallowest open parent that can actually hold children;
    // a heading cannot, so `- item` under `## H` has to attach to its sibling.
    let parentId: string | null = null;
    for (let d = Math.min(parsed.depth, parents.length) - 1; d >= 0; d -= 1) {
      const candidate = parents[d];
      if (candidate !== undefined) {
        parentId = candidate;
        break;
      }
    }
    const created = insert(doc, {
      type: parsed.type,
      parentId,
      content: parseInline(parsed.text),
      props: {
      ...(parsed.checked === undefined ? {} : { checked: parsed.checked }),
      // A callout's kind is a property, so it survives the round trip and
      // the editor can draw the right icon.
      ...(parsed.kind === undefined ? {} : { calloutKind: parsed.kind }),
    },
    });
    parents[parsed.depth] = created.id;
    parents.length = parsed.depth + 1;
  }
  return doc;
}

// ------------------------------------------------------------------- CSV

export type InferredType = 'text' | 'number' | 'date' | 'checkbox';

/**
 * Guess a column's type from its values.
 *
 * Inference is over the *whole* column, not the first row. A column starting
 * "N/A" and then 1, 2, 3 is a number column, and typing it from row one would
 * make it text and never recover.
 *
 * `yes`/`no`/`true`/`false`/`x` are checkbox; an ISO date is a date; anything
 * that parses as a finite number is a number; otherwise text. A column with no
 * usable value is text, because a type inferred from nothing is a guess.
 */
export function inferColumnType(values: string[]): InferredType {
  const present = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (present.length === 0) return 'text';
  if (present.every((v) => /^(yes|no|true|false|x)$/i.test(v))) return 'checkbox';
  if (present.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)))) return 'date';
  if (present.every((v) => Number.isFinite(Number(v.replace(/,/g, ''))))) return 'number';
  return 'text';
}

/**
 * Split one CSV line, honouring quotes.
 *
 * Written by hand rather than pulled in as a dependency: the whole format is
 * about fifteen lines, and a CSV parser is the sort of thing that quietly becomes
 * the largest thing in a supply chain.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/** Split a whole CSV document into rows, keeping newlines inside quoted cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const push = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    push();
    // Skip rows that are entirely empty: a trailing newline is not a record, and
    // counting it produces a phantom row in every import.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') push();
    else if (ch === '\r') {
      // handled by the \n branch
    } else if (ch === '\n') endRow();
    else cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

export interface CsvImport {
  properties: { name: string; type: InferredType }[];
  rows: Record<string, string>[];
}

/** A CSV document into typed columns and row records, keyed by column name. */
export function csvToImport(text: string): CsvImport {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h, i) => (h.trim() === '' ? `Column ${i + 1}` : h.trim()));
  const body = table.slice(1);
  const properties = header.map((name, index) => ({
    name,
    type: inferColumnType(body.map((r) => r[index] ?? '')),
  }));
  const rows = body.map((r) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = r[index] ?? '';
    });
    return record;
  });
  return { properties, rows };
}