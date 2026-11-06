/**
 * Markdown and CSV export.
 *
 * Export is where a lossy bug is invisible until someone opens the file
 * elsewhere, so these assert on the exact output rather than on "contains".
 */

import { describe, expect, it } from 'vitest';
import { createDoc, insert } from '@ow/model';
import { csvField, docToMarkdown, rowsToCsv, type ExportProperty, type ExportRow } from '@ow/model';

function page(...blocks: { type: string; text?: string; checked?: boolean }[]) {
  const doc = createDoc();
  for (const b of blocks) {
    insert(doc, {
      type: b.type,
      content: { runs: b.text ? [{ text: b.text }] : [] },
      props: b.checked ? { checked: true } : {},
    });
  }
  return doc;
}

describe('docToMarkdown', () => {
  it('puts the page title first as an H1', () => {
    expect(docToMarkdown(page({ type: 'paragraph', text: 'hi' }), 'My page')).toBe('# My page\n\nhi\n');
  });

  it('maps every heading level to its own hash count', () => {
    const md = docToMarkdown(
      page(
        { type: 'heading1', text: 'One' },
        { type: 'heading2', text: 'Two' },
        { type: 'heading3', text: 'Three' },
      ),
    );
    expect(md).toContain('# One');
    expect(md).toContain('## Two');
    expect(md).toContain('### Three');
  });

  it('exports a checkbox as a task list that round-trips', () => {
    const md = docToMarkdown(
      page({ type: 'todo', text: 'done', checked: true }, { type: 'todo', text: 'todo' }),
    );
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] todo');
  });

  it('keeps nested list items indented by two spaces per level', () => {
    const doc = createDoc();
    const parent = insert(doc, { type: 'bulletedListItem', content: { runs: [{ text: 'one' }] } }).id;
    insert(doc, { type: 'bulletedListItem', parentId: parent, content: { runs: [{ text: 'two' }] } });
    const md = docToMarkdown(doc);
    expect(md).toContain('- one');
    expect(md).toContain('  - two');
  });

  it('wraps inline marks', () => {
    const doc = createDoc();
    insert(doc, {
      type: 'paragraph',
      content: {
        runs: [
          { text: 'bold', marks: ['bold'] },
          { text: ' and ' },
          { text: 'code', marks: ['code'] },
        ],
      },
    });
    const md = docToMarkdown(doc);
    expect(md).toContain('**bold**');
    expect(md).toContain('`code`');
  });

  it('does not emit a space between runs that were never separated', () => {
    const doc = createDoc();
    insert(doc, {
      type: 'paragraph',
      content: { runs: [{ text: 'bo', marks: ['bold'] }, { text: 'ld', marks: ['bold'] }] },
    });
    expect(docToMarkdown(doc)).toContain('**bold**');
  });

  it('exports a divider and drops media that has no markdown syntax', () => {
    const doc = createDoc();
    insert(doc, { type: 'divider', content: { runs: [] } });
    insert(doc, { type: 'image', content: { runs: [{ text: 'ignored' }] } });
    const md = docToMarkdown(doc);
    expect(md).toContain('---');
    expect(md).not.toContain('ignored');
  });

  it('fences a code block rather than prefixing it', () => {
    const md = docToMarkdown(page({ type: 'code', text: 'const x = 1;' }));
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
  });

  it('produces an empty document rather than throwing on an empty page', () => {
    expect(typeof docToMarkdown(createDoc())).toBe('string');
    expect(docToMarkdown(createDoc())).toBe('\n');
  });
});

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(42)).toBe('42');
    expect(csvField(true)).toBe('true');
  });

  it('quotes only what would otherwise break the parser', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
  });

  it('treats null and undefined as empty rather than the words', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('rowsToCsv', () => {
  const props: ExportProperty[] = [
    { id: 'p1', name: 'Status', type: 'select' },
    { id: 'p2', name: 'Due', type: 'date' },
    { id: 'ptitle', name: 'Title', type: 'title' },
  ];
  const rows: ExportRow[] = [
    { title: 'Ship it', values: { p1: 'Done', p2: '2026-10-19' } },
    { title: 'Do it, now', values: { p1: 'Todo', p2: '' } },
  ];

  it('writes the title first and drops the title property column', () => {
    // Otherwise every export grows a second `Title` column that is always blank
    // next to the real one.
    expect(rowsToCsv(rows, props)).toContain('Name,Status,Due');
  });

  it('quotes a cell containing a comma and doubles the inner quotes', () => {
    const csv = rowsToCsv([{ title: 'Do it, now', values: {} }], []);
    expect(csv).toContain('"Do it, now"');
  });

  it('uses CRLF line endings, which is what RFC 4180 says', () => {
    expect(rowsToCsv(rows, props).split('\r\n')[0]).toBe('Name,Status,Due');
  });

  it('writes only the header for an empty collection', () => {
    expect(rowsToCsv([], props).trim()).toBe('Name,Status,Due');
  });
});