/**
 * Undo and redo across the command registry.
 *
 * These exist because of a bug the end-to-end suite caught and could not
 * explain: after typing, Ctrl+Z left the text exactly as it was. Every layer
 * above the model was verified individually -- the shortcut fired, the command
 * ran, the editor re-rendered -- and the composition still did nothing.
 *
 * The likely mechanism is coalescing. block.setText is marked coalescible so
 * that a burst of typing becomes one history entry rather than one per
 * character, and a coalescing bug is precisely the kind that is invisible until
 * the history is walked back. If these fail, look there first.
 *
 * Driven entirely through command ids, so nothing here can mutate the model in a
 * way the product itself could not.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-undo-'));
  // A file path, not a directory: Repository.open takes the database file.
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'Test workspace');
  // autosaveMs 0 because these tests assert on in-memory state immediately after
  // a command; a pending timer would only add a way to be flaky.
  session = new Session(repo, { autosaveMs: 0 });
  registry = createRegistry();
  // createPage returns the id directly, not an object. Reading `.id` off it
  // yields undefined and surfaces much later as "cannot be bound to SQLite
  // parameter 1", which says nothing about the actual mistake.
  const pageId = repo.createPage({ title: 'Probe' });
  session.openPage(pageId);
});

afterEach(async () => {
  session.dispose();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

/** Run one command through the registry, the same door the renderer uses. */
async function run(id: string, args: Record<string, unknown> = {}) {
  return runCommand(id, args, { session, registry });
}

const textOf = () => session.outline()[0]?.text ?? '';

async function newBlock(): Promise<string> {
  const r = await run('block.insert', { type: 'paragraph', text: '' });
  return (r.value as { id: string }).id;
}

describe('undo and redo', () => {
  it('reverts a burst of typing as one step', async () => {
    const id = await newBlock();

    await run('block.setText', { id, text: 'o' });
    await run('block.setText', { id, text: 'on' });
    await run('block.setText', { id, text: 'one' });
    expect(textOf()).toBe('one');

    const undone = await run('history.undo');
    expect(undone.ok).toBe(true);
    expect(textOf()).toBe('');
  });

  it('restores the text on redo', async () => {
    const id = await newBlock();
    await run('block.setText', { id, text: 'one' });
    expect(textOf()).toBe('one');

    await run('history.undo');
    expect(textOf()).toBe('');

    const redone = await run('history.redo');
    expect(redone.ok).toBe(true);
    expect(textOf()).toBe('one');
  });

  it('reports failure when there is nothing to undo', async () => {
    // The history is not empty just because the session was opened -- opening a
    // page is itself an undoable step. So drain it first, otherwise this asserts
    // that undo works rather than that it fails honestly.
    for (let i = 0; i < 20; i += 1) {
      const drained = await runCommand('history.undo', {}, { session, registry, soft: true });
      if (!drained.ok) break;
    }

    const attempt = await runCommand('history.undo', {}, { session, registry, soft: true });
    expect(attempt.ok).toBe(false);
    expect(String(attempt.error ?? '')).toMatch(/nothing to undo/i);
  });

  it('reports failure when there is nothing to redo', async () => {
    const attempt = await runCommand('history.redo', {}, { session, registry, soft: true });
    expect(attempt.ok).toBe(false);
    expect(String(attempt.error ?? '')).toMatch(/nothing to redo/i);
  });

  it('undoes a block insert', async () => {
    await newBlock();
    await run('block.setText', { id: session.outline()[0]!.id, text: 'kept' });
    expect(session.outline()).toHaveLength(1);

    await run('history.undo'); // the text
    await run('history.undo'); // the insert
    expect(session.outline()).toHaveLength(0);
  });

  it('keeps separate bursts apart', async () => {
    const id = await newBlock();
    await run('block.setText', { id, text: 'first' });
    // A non-coalescible edit between them must break the run, otherwise undo
    // would swallow the type change along with the text.
    await run('block.turnInto.heading1', { id });
    await run('block.setText', { id, text: 'second' });

    await run('history.undo');
    expect(textOf()).toBe('first');
    expect(session.outline()[0]!.type).toBe('heading1');
  });
});
