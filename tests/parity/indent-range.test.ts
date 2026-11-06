/**
 * Indenting a block selection, through the command registry.
 *
 * The failure this guards is structural, not cosmetic. Indent makes a block the
 * next sibling of its previous sibling. Doing that to a nested block whose parent
 * is *also* in the range detaches it from the old parent and re-attaches it to
 * whatever the parent just became -- so the range moves blocks the user never
 * selected and produces a tree nobody asked for. `outermost` exists for that.
 *
 * Command-level rather than e2e on purpose. The interesting part is the tree
 * shape, and asserting on the tree is deterministic; asserting it through a
 * browser means racing React for the privilege.
 */

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
  dir = await mkdtemp(join(tmpdir(), 'ow-indent-'));
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

/** Depth of each root, by id, so a shape change is a readable diff. */
function shape(): string[] {
  const out: string[] = [];
  const walk = (id: string, depth: number) => {
    const block = session.doc.blocks[id];
    if (!block) return;
    out.push(`${'  '.repeat(depth)}${id.slice(0, 4)}`);
    for (const child of block.children ?? []) walk(child, depth + 1);
  };
  for (const root of session.doc.roots) walk(root, 0);
  return out;
}

describe('block.indentRange', () => {
  it('indents a contiguous run and nests it under the block above', async () => {
    const pageId = (await run('page.create', { title: 'P' })).value as { id: string };
        await run('page.open', { id: pageId.id });
    const created = await run('block.insert', { type: 'paragraph', text: 'parent' });
    const parent = (created.value as { id: string }).id;
    await run('block.insert', { type: 'paragraph', text: 'child' });
    const child = session.findBlockByText('child')!.id;

    const before = shape();
    expect(before.length).toBeGreaterThanOrEqual(2);

    const result = await run('block.indentRange', { anchorId: child, focusId: child });
    expect(result.ok).toBe(true);

    // The child is now a child of the parent, not a sibling.
    const children = session.doc.blocks[parent]?.children ?? [];
    expect(children).toContain(child);
  });

  it('moves only the outermost blocks when a selection spans a nested block', async () => {
    const pageId = (await run('page.create', { title: 'P' })).value as { id: string };
        await run('page.open', { id: pageId.id });
    await run('block.insert', { type: 'paragraph', text: 'a' });
    const a = session.findBlockByText('a')!.id;
    // Build a, then a child of a, then a sibling c at the top level.
    await run('block.insert', { type: 'paragraph', text: 'nested', parentId: a });
    const nested = session.findBlockByText('nested')!.id;
    await run('block.insert', { type: 'paragraph', text: 'c' });
    const c = session.findBlockByText('c')!.id;

    const result = await run('block.indentRange', { anchorId: a, focusId: c });
    expect(result.ok).toBe(true);

    // Only the outermost of the range are reported as moved.
    const ids = (result.value as { ids: string[] }).ids;
    expect(ids).not.toContain(nested);
  });

  it('is one undo, not one per block', async () => {
    const pageId = (await run('page.create', { title: 'P' })).value as { id: string };
        await run('page.open', { id: pageId.id });
    await run('block.insert', { type: 'paragraph', text: 'a' });
    const a = session.findBlockByText('a')!.id;
    await run('block.insert', { type: 'paragraph', text: 'b' });
    const b = session.findBlockByText('b')!.id;

    const before = shape();
    await run('block.indentRange', { anchorId: a, focusId: b });
    expect(shape()).not.toEqual(before);

    const undone = await run('history.undo');
    expect(undone.ok).toBe(true);
    expect(shape()).toEqual(before);
  });

  it('refuses an id that is not in the document', async () => {
    const pageId = (await run('page.create', { title: 'P' })).value as { id: string };
        await run('page.open', { id: pageId.id });
    await run('block.insert', { type: 'paragraph', text: 'a' });
    const a = session.findBlockByText('a')!.id;
    const result = await run('block.indentRange', { anchorId: a, focusId: 'ghost' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('ghost');
  });
});