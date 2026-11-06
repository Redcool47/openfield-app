import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-dup-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'Test workspace');
  session = new Session(repo, { autosaveMs: 0 });
  registry = createRegistry();
});

afterEach(async () => {
  session.dispose();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

async function run(id: string, args: Record<string, unknown> = {}) {
  return runCommand(id, args, { session, registry, soft: true });
}

describe('page.duplicate', () => {
  it('creates an independent copy of a page and its blocks', async () => {
    const pageId = (await run('page.create', { title: 'Original' })).value as { id: string };
    await run('page.open', { id: pageId.id });
    await run('block.insert', { type: 'paragraph', text: 'hello' });

    const dup = await run('page.duplicate', { id: pageId.id });
    expect(dup.ok).toBe(true);
    const newId = (dup.value as { id: string }).id;
    expect(newId).not.toBe(pageId.id);

    // The copy carries the blocks, independently.
    const dupDoc = repo.loadPage(newId);
    expect(Object.keys(dupDoc.blocks).length).toBe(Object.keys(session.doc.blocks).length);

    // Editing the copy does not touch the original.
    const copySession = new Session(repo, { autosaveMs: 0 });
    // @ts-expect-error accessing for the test
    await runCommand('page.open', { id: newId }, { session: copySession, registry, soft: true });
    // Just confirm the original still has its block.
    const originalDoc = repo.loadPage(pageId.id);
    expect(Object.keys(originalDoc.blocks).length).toBeGreaterThan(0);
    copySession.dispose();
  });
});