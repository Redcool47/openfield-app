/**
 * Callouts.
 *
 * The syntax is the one every other tool that writes Markdown with callouts
 * uses: a quote line that starts with a bracketed kind. That matters more than
 * it looks -- a note written in one tool and opened in another should still be
 * a note, and a private syntax would make it a quote.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';
import { docToMarkdown, markdownToDoc, createDoc, insert } from '@ow/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-callout-'));
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

describe('callouts', () => {
  it('reads a callout out of markdown, with its kind', () => {
    const doc = markdownToDoc('> [!warning] Mind the gap\n');
    const block = doc.blocks[doc.roots[0]!]!;
    expect(block.type).toBe('callout');
    expect(block.props.calloutKind).toBe('warning');
    expect(block.content).toEqual({ runs: [{ text: 'Mind the gap' }] });
  });

  it('leaves a plain quote as a quote', () => {
    const doc = markdownToDoc('> Just a quote\n');
    const block = doc.blocks[doc.roots[0]!]!;
    expect(block.type).toBe('quote');
    expect(block.props.calloutKind).toBeUndefined();
  });

  it('writes the kind back out, so a callout survives the round trip', () => {
    const doc = createDoc();
    const block = insert(doc, {
      type: 'callout',
      content: { runs: [{ text: 'Mind the gap' }] },
      props: { calloutKind: 'warning' },
    });
    expect(block.type).toBe('callout');
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('> [!warning] Mind the gap');

    // And it reads back as the same thing.
    const back = markdownToDoc(markdown);
    expect(back.blocks[back.roots[0]!]!.type).toBe('callout');
    expect(back.blocks[back.roots[0]!]!.props.calloutKind).toBe('warning');
  });

  it('a callout imported into a page keeps its kind', async () => {
    const id = repo.createPage({ title: 'Note', parentPage: null, icon: null });
    const doc = createDoc();
    insert(doc, { type: 'paragraph', content: { runs: [{ text: 'x' }] } });
    repo.savePage(id, doc);
    session.openPage(id);

    const result = await run('import.markdown', { text: '> [!tip] Worth knowing\n' });
    expect(result.ok, result.error).toBe(true);

    const block = session.doc.blocks[session.doc.roots[0]!]!;
    expect(block.type).toBe('callout');
    expect(block.props.calloutKind).toBe('tip');
  });
});
