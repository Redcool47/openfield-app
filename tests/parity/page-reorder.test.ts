/**
 * Reordering a page among its siblings.
 *
 * The risky part is not the swap, it is the renumbering. `position` is the only
 * thing that orders siblings, so two pages sharing one leaves the order up to
 * the database. And the failure is invisible: the sidebar re-renders, the rows
 * are all still there, just not where they were left.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-reorder-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'W');
});

afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const titles = (parent: string | null) =>
  repo.childPages(parent).map((p) => p.title);

describe('Repository.reorderPage', () => {
  it('moves a page down one place and leaves the rest in order', () => {
    const a = repo.createPage({ title: 'A' });
    repo.createPage({ title: 'B' });
    repo.createPage({ title: 'C' });

    expect(repo.reorderPage(a, 1)).toBe(true);
    expect(titles(null)).toEqual(['B', 'A', 'C']);
  });

  it('moves a page up one place', () => {
    repo.createPage({ title: 'A' });
    repo.createPage({ title: 'B' });
    const c = repo.createPage({ title: 'C' });

    expect(repo.reorderPage(c, -1)).toBe(true);
    expect(titles(null)).toEqual(['A', 'C', 'B']);
  });

  it('does nothing at the ends rather than throwing', () => {
    const a = repo.createPage({ title: 'A' });
    const b = repo.createPage({ title: 'B' });
    // Holding Alt+Down on the last row should stop, the way a selection stops.
    expect(repo.reorderPage(a, -1)).toBe(false);
    expect(repo.reorderPage(b, 1)).toBe(false);
    expect(titles(null)).toEqual(['A', 'B']);
  });

  it('reorders only within one parent', () => {
    const group = repo.createPage({ title: 'Group' });
    const x = repo.createPage({ title: 'X', parentPage: group });
    repo.createPage({ title: 'Y', parentPage: group });
    repo.createPage({ title: 'Top1' });
    repo.createPage({ title: 'Top2' });

    expect(repo.reorderPage(x, 1)).toBe(true);
    expect(titles(group)).toEqual(['Y', 'X']);
    expect(titles(null)).toEqual(['Group', 'Top1', 'Top2']);
  });

  it('gives every sibling a distinct position, so the order cannot drift', () => {
    const ids = ['A', 'B', 'C', 'D'].map((t) => repo.createPage({ title: t }));
    repo.reorderPage(ids[0]!, 1);
    repo.reorderPage(ids[3]!, -1);
    repo.reorderPage(ids[1]!, 1);

    const positions = ids.map((id) => (repo.getPage(id)?.position ?? ''));
    expect(new Set(positions).size).toBe(positions.length);
    // Traced, not guessed: A,B,C,D -> down A -> B,A,C,D -> up D -> B,A,D,C
    // -> down B -> A,B,D,C. Writing the expectation down first is what caught
    // that the implementation was right and the assertion was wrong.
    expect(titles(null)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('sorts correctly after a reopen, which is the only real proof of the order', async () => {
    const a = repo.createPage({ title: 'A' });
    repo.createPage({ title: 'B' });
    repo.createPage({ title: 'C' });
    repo.reorderPage(a, 1);

    const path = join(dir, 'w.sqlite');
    repo.close();
    // Re-open rather than trusting the in-memory view. The stored `position`
    // column is the only thing that survives a restart, so an order that only
    // holds in memory is not an order.
    repo = await Repository.open(path);

    expect(repo.childPages(null).map((p) => p.title)).toEqual(['B', 'A', 'C']);
  });
});