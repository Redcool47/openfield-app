/**
 * The inline syntaxes: equations, tags and wiki links.
 *
 * Three things are being checked here, and each of them is a different kind
 * of promise:
 *
 * - The rules fire at the right moment. A rule that fires early turns half a
 *   token into something; a rule that fires late leaves the token as text.
 * - The model round-trips. An equation written in the editor comes out of the
 *   exporter as the same equation, because the Markdown files are the
 *   interchange format and a syntax the exporter does not write is a syntax
 *   that does not travel.
 * - A wiki link names a page that exists. A link to nothing is worse than
 *   text.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';
import { inlineRuleAt, resolveWikiLinks, docToMarkdown, parseInline, createDoc, insert } from '@ow/model';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-inline-'));
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

/**
 * A page with one paragraph holding `text`.
 *
 * Both ids come back because the commands work on a block and the tests
 * sometimes want the page as well.
 */
async function pageWith(text: string): Promise<{ pageId: string; blockId: string }> {
  const pageId = repo.createPage({ title: 'Note', parentPage: null, icon: null });
  const doc = createDoc();
  const block = insert(doc, { type: 'paragraph', content: { runs: [{ text }] } });
  repo.savePage(pageId, doc);
  session.openPage(pageId);
  return { pageId, blockId: block.id };
}

describe('the inline rules', () => {
  it('fires an equation on the closing dollar sign', () => {
    const match = inlineRuleAt('cost is $x^2$', 13);
    expect(match).not.toBeNull();
    expect(match!.id).toBe('equation');
    expect(match!.value).toBe('x^2');
    expect(match!.from).toBe(8);
  });

  it('does not fire in the middle of a token', () => {
    expect(inlineRuleAt('cost is $x^2', 10)).toBeNull();
  });

  it('fires a wiki link on the closing brackets', () => {
    const match = inlineRuleAt('see [[Plan]] now', 12);
    expect(match?.id).toBe('wiki');
    expect(match?.value).toBe('Plan');
  });

  it('only fires a tag at a word boundary', () => {
    // A tag needs a space before it, so `C#` is not a tag.
    expect(inlineRuleAt('C# is a language', 15)?.id).not.toBe('tag');
    expect(inlineRuleAt('ship it #urgent ', 16)?.id).toBe('tag');
  });

  it('does not fire a tag before the word is finished', () => {
    // The name is not finished until the space, so the rule waits.
    expect(inlineRuleAt('ship it #urg', 11)).toBeNull();
  });
});

describe('the inline commands', () => {
  it('turns a range into an equation', async () => {
    const { blockId } = await pageWith('x^2');
    const result = await run('inline.equation.set', { id: blockId, from: 0, to: 3, latex: 'x^2' });
    expect(result.ok, result.error).toBe(true);
    const doc = repo.loadPage(session.pageId!);
    expect(doc.blocks[doc.roots[0]!]!.content).toEqual({
      runs: [{ text: 'x2', inline: { kind: 'equation', latex: 'x^2' } }],
    });
  });

  it('turns a range into a tag', async () => {
    const { blockId } = await pageWith('#urgent');
    const result = await run('inline.tag.set', { id: blockId, from: 0, to: 7, name: 'urgent' });
    expect(result.ok, result.error).toBe(true);
    const doc = repo.loadPage(session.pageId!);
    expect(doc.blocks[doc.roots[0]!]!.content).toEqual({
      runs: [{ text: '#urgent', inline: { kind: 'tag', name: 'urgent' } }],
    });
  });

  it('turns a range into a link to a page by name', async () => {
    repo.createPage({ title: 'The Plan', parentPage: null, icon: null });
    const { blockId } = await pageWith('The Plan');
    const result = await run('inline.wiki.set', { id: blockId, from: 0, to: 8, title: 'The Plan' });
    expect(result.ok, result.error).toBe(true);
    const doc = repo.loadPage(session.pageId!);
    const runs = doc.blocks[doc.roots[0]!]!.content.runs as { inline?: { kind: string } }[];
    expect(runs[0]!.inline?.kind).toBe('page');
  });

  it('refuses a wiki link to a page that does not exist', async () => {
    const { blockId } = await pageWith('Nowhere');
    const result = await run('inline.wiki.set', { id: blockId, from: 0, to: 7, title: 'Nowhere' });
    expect(result.ok).toBe(false);
    // And the text is left as it was, rather than becoming a link to nothing.
    const doc = repo.loadPage(session.pageId!);
    expect(doc.blocks[doc.roots[0]!]!.content).toEqual({ runs: [{ text: 'Nowhere' }] });
  });

  it('finds a page by its title without regard to case', () => {
    repo.createPage({ title: 'The Plan', parentPage: null, icon: null });
    expect(repo.findPageByTitle('the plan')?.title).toBe('The Plan');
    expect(repo.findPageByTitle('nothing here')).toBeUndefined();
  });
});

describe('the markdown round trip', () => {
  it('exports an equation, a tag and a wiki link as their own syntax', async () => {
    await pageWith('x');
    const doc = repo.loadPage(session.pageId!);
    const root = doc.roots[0]!;
    doc.blocks[root]!.content = {
      runs: [
        { text: 'x^2', inline: { kind: 'equation', latex: 'x^2' } },
        { text: ' ' },
        { text: 'urgent', inline: { kind: 'tag', name: 'urgent' } },
        { text: ' ' },
        { text: 'The Plan', inline: { kind: 'page', pageId: 'p1', label: 'The Plan' } },
      ],
    };
    repo.savePage(session.pageId!, doc);

    const markdown = docToMarkdown(repo.loadPage(session.pageId!));
    expect(markdown).toContain('$x^2$');
    expect(markdown).toContain('#urgent');
    expect(markdown).toContain('[[The Plan]]');
  });

  it('reads an equation and a tag back out of markdown', () => {
    const content = parseInline('a $x^2$ b #urgent c');
    const runs = content.runs as { text: string; inline?: { kind: string } }[];
    expect(runs.find((r) => r.inline?.kind === 'equation')?.text).toBe('x^2');
    expect(runs.find((r) => r.inline?.kind === 'tag')?.text).toBe('#urgent');
  });

  it('resolves a wiki link to a page when one exists, and leaves it alone when one does not', () => {
    const lookup = (title: string) => (title === 'Plan' ? 'page-1' : undefined);
    const runs = resolveWikiLinks([{ text: 'see [[Plan]] and [[Nothing]]' }], lookup);
    const withLinks = runs as { text: string; inline?: { kind: string; pageId?: string } }[];
    expect(withLinks.find((r) => r.inline?.kind === 'page')?.inline?.pageId).toBe('page-1');
    // The one that names no page is still text.
    expect(withLinks.some((r) => r.text.includes('[[Nothing]]'))).toBe(true);
  });
});
