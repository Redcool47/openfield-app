/**
 * Importing a folder of Markdown and CSV files.
 *
 * This is the path a person takes when they move from another tool: export,
 * unzip, point the app at the folder. The shape of the export is a folder of
 * Markdown files and a CSV per database, and the test builds one of those.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-import-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'W');
  session = new Session(repo, { autosaveMs: 0 });
  registry = createRegistry();
});

afterEach(async () => {
  session.dispose();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (id: string, args: Record<string, unknown> = {}) =>
  runCommand(id, args, { session, registry, soft: true });

describe('importing a folder', () => {
  it('brings in a Markdown file as a page, titled from its heading', async () => {
    const exportDir = join(dir, 'export');
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, 'Getting started.md'), '# Getting started\n\nSome words.\n', 'utf8');

    const result = await run('import.folder', { path: exportDir });
    expect(result.ok, result.error).toBe(true);
    const value = result.value as { pages: string[]; imported: number };
    expect(value.pages).toEqual(['Getting started']);
    expect(value.imported).toBe(1);

    const page = repo.allPages().find((p) => p.title === 'Getting started');
    expect(page).toBeDefined();
    const doc = repo.loadPage(page!.id);
    const text = doc.blocks[doc.roots[0]!]!.content;
    expect(JSON.stringify(text)).toContain('Some words.');
  });

  it('brings in a CSV as a database with its rows', async () => {
    const exportDir = join(dir, 'export');
    await mkdir(exportDir, { recursive: true });
    await writeFile(
      join(exportDir, 'Tasks.csv'),
      'Name,Status,Done\nWrite the docs,Doing,no\nShip it,Done,yes\n',
      'utf8',
    );

    const result = await run('import.folder', { path: exportDir });
    expect(result.ok, result.error).toBe(true);
    const value = result.value as { databases: string[] };
    expect(value.databases).toHaveLength(1);
    expect(value.databases[0]).toContain('Tasks');
    expect(value.databases[0]).toContain('2 rows');

    const collections = repo.databases.listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe('Tasks');
  });

  it('says so when the folder cannot be read', async () => {
    const result = await run('import.folder', { path: join(dir, 'nothing-here') });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot read');
  });
});
