/**
 * Per-page appearance.
 *
 * The storage columns (`full_width`, `small_text`, `font`, `cover`) existed from
 * the first migration and nothing ever wrote to them, so these settings were
 * write-only: the columns were there and the UI was not. The test drives the
 * repository and the command rather than the menu, because what is easy to get
 * wrong is the round trip through storage, not the click.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-appear-'));
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

const appearance = (id: string) => {
  const row = repo.getPage(id);
  return { fullWidth: row?.full_width === 1, smallText: row?.small_text === 1, font: row?.font, cover: row?.cover };
};

describe('page.appearance.set', () => {
  it('persists width, text size and font', async () => {
    const page = (await run('page.create', { title: 'P' })).value as { id: string };
    expect((await run('page.appearance.set', { id: page.id, fullWidth: true })).ok).toBe(true);
    expect((await run('page.appearance.set', { id: page.id, smallText: true })).ok).toBe(true);
    expect((await run('page.appearance.set', { id: page.id, font: 'serif' })).ok).toBe(true);
    expect(appearance(page.id)).toEqual({ fullWidth: true, smallText: true, font: 'serif', cover: null });
  });

  it('leaves untouched fields alone rather than resetting them', async () => {
    const page = (await run('page.create', { title: 'P' })).value as { id: string };
    await run('page.appearance.set', { id: page.id, fullWidth: true, font: 'mono' });
    await run('page.appearance.set', { id: page.id, smallText: true });
    // The second call sent no width and no font. Writing defaults there would
    // mean toggling one setting silently undoes another.
    expect(appearance(page.id)).toMatchObject({ fullWidth: true, smallText: true, font: 'mono' });
  });

  it('survives a reopen, because the columns are in the database', async () => {
    const page = (await run('page.create', { title: 'P' })).value as { id: string };
    await run('page.appearance.set', { id: page.id, font: 'serif', fullWidth: true });

    const path = join(dir, 'w.sqlite');
    repo.close();
    repo = await Repository.open(path);
    expect(appearance(page.id)).toMatchObject({ font: 'serif', fullWidth: true });
  });

  it('clears a cover with an empty string', async () => {
    const page = (await run('page.create', { title: 'P' })).value as { id: string };
    await run('page.appearance.set', { id: page.id, cover: 'gradient-1' });
    expect(appearance(page.id).cover).toBe('gradient-1');
    await run('page.appearance.set', { id: page.id, cover: '' });
    expect(appearance(page.id).cover).toBeNull();
  });

  it('refuses a font that is not one of the three', async () => {
    // The font becomes a CSS font-family, so an arbitrary string is a way to
    // put arbitrary declarations into a stylesheet.
    const page = (await run('page.create', { title: 'P' })).value as { id: string };
    const bad = await run('page.appearance.set', { id: page.id, font: 'serif; background: url(x)' });
    expect(bad.ok).toBe(false);
    // Untouched, so the page keeps whatever the schema defaulted it to rather
    // than gaining the rejected string.
    expect(appearance(page.id).font).toBe('sans');
  });

  it('refuses a page that does not exist', async () => {
    const bad = await run('page.appearance.set', { id: 'ghost', fullWidth: true });
    expect(bad.ok).toBe(false);
  });
});