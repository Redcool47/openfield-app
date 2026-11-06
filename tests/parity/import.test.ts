/**
 * Markdown and CSV import.
 *
 * The property worth testing is the round trip: a page Openfield exported should
 * come back with the same block types and nesting. Import that only works on
 * hand-written input passes a hundred parser tests and still loses the user's
 * data when they press Import on their own export.
 */

import { describe, expect, it } from 'vitest';
import { csvToImport, docToMarkdown, inferColumnType, markdownToDoc, parseCsv, parseInline } from '@ow/model';

const types = (markdown: string) =>
  markdownToDoc(markdown)
    .roots.map((id) => markdownToDoc(markdown).blocks[id]!.type);

describe('markdownToDoc', () => {
  it('reads headings at all three levels', () => {
    const doc = markdownToDoc('# One\n\n## Two\n\n### Three\n');
    expect(doc.roots.map((id) => doc.blocks[id]!.type)).toEqual([
      'heading1',
      'heading2',
      'heading3',
    ]);
  });

  it('reads bullets, numbers and task lists', () => {
    const doc = markdownToDoc('- a\n- b\n\n1. one\n\n- [x] done\n- [ ] todo\n');
    expect(doc.roots.map((id) => doc.blocks[id]!.type)).toEqual([
      'bulletedListItem',
      'bulletedListItem',
      'numberedListItem',
      'todo',
      'todo',
    ]);
    expect(doc.blocks[doc.roots[3]!]!.props?.checked).toBe(true);
    expect(doc.blocks[doc.roots[4]!]!.props?.checked).toBe(false);
  });

  it('nests by two-space indent', () => {
    const doc = markdownToDoc('- one\n  - two\n    - three\n');
    const one = doc.roots[0]!;
    const two = doc.blocks[one]!.children[0]!;
    expect(doc.blocks[two]!.children).toHaveLength(1);
    expect(doc.blocks[doc.blocks[two]!.children[0]!]!.type).toBe('bulletedListItem');
  });

  it('keeps a fenced code block whole rather than reading it as markup', () => {
    const doc = markdownToDoc('```\n# not a heading\n- not a list\n```\n');
    expect(doc.roots).toHaveLength(1);
    const block = doc.blocks[doc.roots[0]!]!;
    expect(block.type).toBe('code');
    // The `#` and `-` must survive as text, not become structure.
    expect(block.content.runs.map((r) => (typeof r === 'string' ? r : r.text)).join('')).toContain('# not a heading');
  });

  it('joins consecutive plain lines into one paragraph', () => {
    const doc = markdownToDoc('first line\nsecond line\n\nanother\n');
    expect(doc.roots).toHaveLength(2);
    const text = doc.blocks[doc.roots[0]!]!.content.runs.map((r) => (typeof r === 'string' ? r : r.text)).join('');
    expect(text).toBe('first line\nsecond line');
  });

  it('reads a block quote', () => {
    const doc = markdownToDoc('> quoted\n');
    expect(doc.blocks[doc.roots[0]!]!.type).toBe('quote');
  });

  it('does not lose a line it does not understand', () => {
    // The failure mode to avoid: a parser that silently drops input looks
    // exactly like a clean import until someone notices a sentence is missing.
    const doc = markdownToDoc('| a | b |\n| - | - |\n| 1 | 2 |\n');
    const all = Object.values(doc.blocks)
      .map((b) => b.content.runs.map((r) => (typeof r === 'string' ? r : r.text)).join(''))
      .join(' ');
    expect(all).toContain('a');
    expect(doc.roots.length).toBeGreaterThan(0);
  });

  it('round-trips a page through export and import', () => {
    const source = ['## Heading', '', 'A paragraph with **bold** text.', '', '- [x] done', '- [ ] todo', '', '- one', '  - two'].join('\n');
    const md = docToMarkdown(markdownToDoc(source), undefined);
    const doc = markdownToDoc(md);
    expect(doc.roots.map((id) => doc.blocks[id]!.type)).toEqual([
      'heading2',
      'paragraph',
      'todo',
      'todo',
      'bulletedListItem',
    ]);
    const bold = doc.blocks[doc.roots[1]!]!.content.runs.find(
      (r) => typeof r !== 'string' && r.marks?.includes('bold'),
    );
    expect(bold).toBeTruthy();
    const listItem = doc.blocks[doc.roots[4]!]!;
    expect(listItem.children).toHaveLength(1);
  });
});

describe('parseInline', () => {
  it('marks bold, italic, strike and code', () => {
    const runs = parseInline('a **b** c *d* ~~e~~ `f`').runs;
    const marksOf = (text: string) => runs.find((r) => typeof r !== 'string' && r.text === text);
    expect(marksOf('b')?.marks).toContain('bold');
    expect(marksOf('d')?.marks).toContain('italic');
    expect(marksOf('e')?.marks).toContain('strikethrough');
    expect(marksOf('f')?.marks).toContain('code');
  });

  it('does not read a bold marker as two italics', () => {
    const runs = parseInline('**bold**').runs;
    expect(runs.filter((r) => typeof r !== 'string' && r.marks?.includes('italic'))).toHaveLength(0);
  });
});

describe('inferColumnType', () => {
  it('reads a number column', () => {
    expect(inferColumnType(['1', '2', '30'])).toBe('number');
    expect(inferColumnType(['1,200', '3'])).toBe('number');
  });

  it('reads a date column', () => {
    expect(inferColumnType(['2026-10-19', '2026-01-01'])).toBe('date');
  });

  it('reads a checkbox column', () => {
    expect(inferColumnType(['yes', 'no', 'YES'])).toBe('checkbox');
  });

  it('falls back to text rather than guessing', () => {
    expect(inferColumnType(['a', '1'])).toBe('text');
    expect(inferColumnType([])).toBe('text');
    expect(inferColumnType(['', ''])).toBe('text');
  });

  it('decides on the whole column, so a leading N/A does not type it as text', () => {
    // Row-one inference would make this text permanently, and the column would
    // never recover.
    expect(inferColumnType(['N/A', '1', '2'])).toBe('text');
    expect(inferColumnType(['1', 'N/A', '2'])).toBe('text');
  });
});

describe('parseCsv', () => {
  it('splits on commas and keeps quoted cells whole', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a,"b,c"')).toEqual([['a', 'b,c']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('keeps a newline inside a quoted cell', () => {
    expect(parseCsv('"two\nlines",b')).toEqual([['two\nlines', 'b']]);
  });

  it('does not invent a trailing row for a trailing newline', () => {
    expect(parseCsv('a,b\n')).toHaveLength(1);
  });
});

describe('csvToImport', () => {
  it('names the columns and infers each type', () => {
    const out = csvToImport('Name,Count,Due,Done\nShip,3,2026-10-19,yes\nBuild,4,2026-10-20,no\n');
    expect(out.properties.map((p) => p.name)).toEqual(['Name', 'Count', 'Due', 'Done']);
    expect(out.properties.map((p) => p.type)).toEqual(['text', 'number', 'date', 'checkbox']);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!['Count']).toBe('3');
  });

  it('gives an unnamed column a readable name', () => {
    const out = csvToImport('a,,c\n1,2,3\n');
    expect(out.properties[1]!.name).toBe('Column 2');
  });

  it('returns nothing rather than throwing on an empty file', () => {
    const out = csvToImport('');
    expect(out.properties).toHaveLength(0);
    expect(out.rows).toHaveLength(0);
  });
});