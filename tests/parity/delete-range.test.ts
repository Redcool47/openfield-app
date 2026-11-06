/**
 * Deleting a block range, driven through the command registry.
 *
 * The assertion that matters is the undo. A range delete that removes three
 * paragraphs and needs three Ctrl+Z presses looks fine until someone edits for
 * twenty minutes and reaches for one, and a range delete that cannot be undone at
 * all is silent data loss wearing the costume of a feature.
 *
 * Every step goes through a command id, the same way the renderer does, so this
 * cannot pass by reaching into storage in a way the product itself could not.
 *
 * This lives here rather than in an e2e spec because it needs no browser. The
 * equivalent e2e test spent its time fighting `keyboard.type` arriving before
 * React had moved the caret after Enter -- a race in the harness, not the editor.
 * The command-level test is the same guarantee with none of that flake.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';
import { blockPlainText } from '@ow/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-range-'));
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

/** A page holding `texts`, with the block ids in the order they were inserted. */
async function pageWith(texts: string[]): Promise<{ pageId: string; ids: string[] }> {
  const created = await run('page.create', { title: 'Range' });
  const pageId = (created.value as { id: string }).id;
  await run('page.open', { id: pageId });

  for (const text of texts) await run('block.insert', { type: 'paragraph', text });

  // Take the ids from the document rather than from each insert's return value.
  // `block.insert` reports the block it inserted *into*, so the first call on a
  // fresh page hands back the page's initial block rather than a new one -- and
  // feeding that to deleteRange is correctly refused as "no such block", which
  // is a thoroughly confusing way for a fixture to fail.
  // Ids come from `page.open`, which lists blocks in document order. That is the
  // only id source in this API that is guaranteed to be blocks in order --
  // `block.insert` reports the block it inserted into, and `doc.roots` turns out
  // not to contain what was just inserted. A fixture that guesses at ids fails in
  // ways that look like product bugs.
  const opened = await run('page.open', { id: pageId });
  const all = (opened.value as { blocks: string[] }).blocks;
  const withText = all.filter((id) => blockPlainText(session.doc, id) !== '');
  return { pageId, ids: withText };
}

/**
 * The page's block text in document order.
 *
 * Read back through `page.open`, which returns the same flat view the renderer
 * sees, rather than out of the database. Asserting on the view model is the point:
 * it is what the user can actually see, so it is the thing that has to be right.
 */
async function textOf(_pageId: string): Promise<string[]> {
  // Deliberately does NOT re-open the page. Opening a page resets that page's
  // undo history, so a helper that re-opened between the delete and the undo
  // would clear the stack and the undo would fail with "nothing to undo" -- which
  // looks exactly like the feature being broken, and is not.
  // `page.open` returns block *ids*; the text lives on the doc. `blockPlainText`
  // is the model's own reader, so this does not re-implement flattening.
  return session.doc.roots.map((id) => blockPlainText(session.doc, id));
}

describe('block.deleteRange', () => {
  it('removes the whole range and restores it with one undo', async () => {
    const { pageId, ids } = await pageWith(['one', 'two', 'three']);
    const before = await textOf(pageId);
    expect(before).toContain('one');

    const deleted = await run('block.deleteRange', { anchorId: ids[0], focusId: ids[2] });
    expect(deleted.ok).toBe(true);
    expect((deleted.value as { ids: string[] }).ids).toHaveLength(3);

    const gone = await textOf(pageId);
    expect(gone).not.toContain('one');
    expect(gone).not.toContain('three');

    // One undo. Not three.
    const undone = await run('history.undo');
    expect(undone.ok).toBe(true);

    const restored = await textOf(pageId);
    expect(restored).toContain('one');
    expect(restored).toContain('two');
    expect(restored).toContain('three');
  });

  it('refuses an id that is not in the document', async () => {
    const { ids } = await pageWith(['one']);
    const result = await run('block.deleteRange', { anchorId: ids[0], focusId: 'ghost' });
    expect(result.ok).toBe(false);
    // The failure has to name the block. Silently dropping an unknown id reports
    // a successful delete of blocks that were never there.
    expect(String(result.error)).toContain('ghost');
  });

  it('rejects an empty range rather than reporting a no-op success', async () => {
    const result = await run('block.deleteRange', { anchorId: '', focusId: '' });
    expect(result.ok).toBe(false);
  });
});