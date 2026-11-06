/**
 * Pages as Markdown files, and the way back.
 *
 * The point of this is the direction nobody thinks about. Exporting to
 * Markdown is easy; the hard part is a file that changed *outside* the app
 * coming back in. That is what makes a synced folder usable rather than
 * merely exportable: edit the note in another editor, and the app notices.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository, FileMirror, contentHash, parseFrontmatter, sanitiseFileName } from '@ow/storage';
import { createDoc, insert } from '@ow/model';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let dir: string;
let notes: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-files-'));
  notes = join(dir, 'notes');
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'W');
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const mirror = () => new FileMirror(repo, notes);

async function makePage(title: string, text: string): Promise<string> {
  const id = repo.createPage({ title, parentPage: null, icon: null });
  const doc = createDoc();
  insert(doc, { type: 'paragraph', content: { runs: [{ text }] } });
  repo.savePage(id, doc);
  return id;
}

describe('markdown files', () => {
  it('writes a page as a Markdown file with frontmatter', async () => {
    const id = await makePage('Shopping list', 'Milk');
    mirror().materialise();

    const path = join(notes, 'Shopping list.md');
    expect(existsSync(path)).toBe(true);
    const text = await readFile(path, 'utf8');

    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('title: Shopping list');
    expect(text).toContain(`id: ${id}`);
    expect(text).toContain('Milk');
  });

  it('puts a child page in a folder named after its parent', async () => {
    const parent = await makePage('Work', 'Parent');
    const child = repo.createPage({ title: 'Notes', parentPage: parent, icon: null });
    repo.savePage(child, repo.loadPage(child));
    mirror().materialise();

    expect(existsSync(join(notes, 'Work', 'Notes.md'))).toBe(true);
  });

  it('gives two pages with the same title different files', async () => {
    await makePage('Notes', 'One');
    await makePage('Notes', 'Two');
    mirror().materialise();

    expect(existsSync(join(notes, 'Notes.md'))).toBe(true);
    expect(existsSync(join(notes, 'Notes 2.md'))).toBe(true);
  });

  it('reads back a file that was edited outside the app', async () => {
    const id = await makePage('Journal', 'First entry');
    mirror().materialise();

    // The edit happens in another program, which is the whole point.
    const path = join(notes, 'Journal.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('First entry', 'Second entry'), 'utf8');

    const result = mirror().importChanged();
    expect(result.imported).toContain('Journal.md');
    expect(repo.loadPage(id).blocks[repo.loadPage(id).roots[0]!]!.content).toEqual({
      runs: [{ text: 'Second entry' }],
    });
  });

  it('does not import a file it wrote itself', async () => {
    await makePage('Journal', 'Entry');
    mirror().materialise();
    const result = mirror().importChanged();
    expect(result.imported).toEqual([]);
    expect(result.unchanged).toContain('Journal.md');
  });

  it('does not delete a page when its file has gone missing', async () => {
    const id = await makePage('Journal', 'Entry');
    mirror().materialise();
    // A sync tool that has not delivered the file yet is not a deletion.
    const { rmSync } = await import('node:fs');
    rmSync(join(notes, 'Journal.md'));
    const result = mirror().importChanged();
    expect(result.skipped).toContain('Journal.md');
    expect(repo.getPage(id)).toBeDefined();
  });

  it('reports a file that changed on disk as changed', async () => {
    await makePage('Journal', 'Entry');
    mirror().materialise();
    const path = join(notes, 'Journal.md');
    await writeFile(path, (await readFile(path, 'utf8')) + '\nchanged\n', 'utf8');
    const status = mirror().status();
    expect(status.changed).toContain('Journal.md');
  });

  it('lists a file that belongs to no page as unknown', async () => {
    await makePage('Journal', 'Entry');
    mirror().materialise();
    await mkdirSync(notes, { recursive: true });
    await writeFile(join(notes, 'Orphan.md'), '---\nid: nope\n---\n\nstray\n', 'utf8');
    const status = mirror().status();
    expect(status.unknown).toContain('Orphan.md');
  });

  it('takes the title from the frontmatter when a file is imported', async () => {
    const id = await makePage('Old name', 'Entry');
    mirror().materialise();
    const path = join(notes, 'Old name.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('title: Old name', 'title: New name'), 'utf8');
    mirror().importChanged();
    expect(repo.getPage(id)?.title).toBe('New name');
  });
});

describe('frontmatter', () => {
  it('reads scalars, lists and one level of nesting', () => {
    const { data, body } = parseFrontmatter(
      ['---', 'id: abc', 'title: "A: title"', 'tags: [one, two]', 'properties:', '  status: doing', '---', '', 'Body here'].join('\n'),
    );
    expect(data.id).toBe('abc');
    expect(data.title).toBe('A: title');
    expect(data.tags).toEqual(['one', 'two']);
    expect(data.properties).toEqual({ status: 'doing' });
    expect(body.trim()).toBe('Body here');
  });

  it('treats a file with no frontmatter as all body', () => {
    const { data, body } = parseFrontmatter('# Just a heading\n');
    expect(data).toEqual({});
    expect(body).toContain('# Just a heading');
  });
});

describe('file names', () => {
  it('replaces characters a filesystem will not accept', () => {
    expect(sanitiseFileName('a/b:c*d?e"f<g>h|i')).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('does not leave a trailing dot or space', () => {
    expect(sanitiseFileName('Name.')).toBe('Name');
    expect(sanitiseFileName('Name ')).toBe('Name');
  });

  it('escapes a reserved device name', () => {
    expect(sanitiseFileName('CON')).toBe('_CON');
  });

  it('never returns an empty name', () => {
    expect(sanitiseFileName('   ')).toBe('Untitled');
    expect(sanitiseFileName('')).toBe('Untitled');
  });
});

describe('hashes', () => {
  it('changes when the content changes and not otherwise', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
