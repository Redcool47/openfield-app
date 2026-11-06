/**
 * The command catalogue.
 *
 * Every user-visible action lives here exactly once. The editor, the sidebar,
 * the menus, the keyboard map, quick find, the palette, the CLI and the MCP
 * server all resolve through this list, so adding a feature means adding one
 * entry rather than wiring the same behaviour into five places.
 *
 * Commands are grouped by area so the generated catalogue reads as a manual.
 */

import type { Command, CommandContext } from './registry.js';
import { SHORTCUTS, TURN_INTO_CHORDS } from './shortcuts.js';
import { DB_COMMANDS } from './database-commands.js';
import { AI_COMMANDS } from './ai-commands.js';
import { newId } from '@ow/geom';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileMirror } from '@ow/storage';
import {
  blockSelection,
  caretAt,
  deletableIds,
  docToMarkdown,
  duplicateBlock,
  fullySelectedBlocks,
  get,
  indent,
  insert,
  isDescendant,
  insertLineBreak,
  csvToImport,
  markdownToDoc,
  latexText,
  diffText,
  resolveWikiLinks,
  spliceText,
  mergeBackward,
  moveBlock,
  moveSibling,
  moveToTrash,
  outdent,
  plain,
  purgeBlock,
  restore,
  rowsToCsv,
  setContent,
  setInline,
  setLink,
  setColor,
  setProps,
  toggleMark,
  textOf,
  toggleOpen,
  subtreeIds,
  turnInto,
  walk,
  type InlineNode,
  type ColorName,
  type Link,
  type Mark,
  acceptsText,
  BLOCK_DEFINITIONS,
  type Doc,
} from '@ow/model';

/**
 * Every block type a command may create, read from the registry.
 *
 * This replaces a hand-kept array that had drifted: `block.insert` rejected
 * `tableOfContents` -- a type that has been in the registry since the first
 * release and that the slash menu offers -- because its enum listed twelve
 * types out of date. A block type existing in the registry is not the same as it
 * being creatable.
 *
 * Types that hold no text are included too. `divider` and `tableOfContents` are
 * created exactly the same way as a paragraph, with the `text` argument left
 * empty; excluding them would make the two blocks with no text the only ones in
 * the app you cannot insert by id.
 */
const INSERTABLE_BLOCK_TYPES: string[] = BLOCK_DEFINITIONS.map((d) => d.type);

/** Types a block can be turned into: everything that holds text. */
const TURN_INTO_TYPES: string[] = BLOCK_DEFINITIONS.filter(
  (d) => acceptsText(d.type) && d.type !== 'divider',
).map((d) => d.type);

/**
 * The palette names a colour command may store.
 *
 * Listed here rather than inferred from the type, because a type is erased at
 * runtime and the check has to happen while the argument is still a string.
 */
const COLOR_NAMES: ColorName[] = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
];

type Ctx = CommandContext & { session: import('./session.js').Session };

function ctxOf(ctx: CommandContext): Ctx {
  return ctx as Ctx;
}

/** Turn a type string into a `block.turnInto.*` command id. */
function turnIntoId(type: string): string {
  return `block.turnInto.${type.replace(/([A-Z])/g, (m) => m).replace(/[^A-Za-z0-9]/g, '')}`;
}

/**
 * A stored property value is a tagged union, not a bare scalar, so an imported
 * cell has to be wrapped in the shape its type declares. Storing the raw string
 * for a number column makes the cell sort lexicographically forever after.
 */
function importedValue(type: string, raw: string): unknown {
  if (type === 'number') return { type: 'number', number: Number(raw.replace(/,/g, '')) };
  if (type === 'checkbox') return { type: 'checkbox', checked: /^(yes|true|x)$/i.test(raw) };
  if (type === 'date') return { type: 'date', date: raw };
  return { type: 'text', text: raw };
}

/**
 * Import CSV text into a database, inferring the column types.
 *
 * A function rather than a command body, because the folder import has to do
 * the same thing for every CSV in an export, and a command cannot call
 * another command.
 */
function importCsvText(
  repo: import('@ow/storage').Repository,
  text: string,
  collectionId: string | undefined,
  name: string,
): { collectionId: string; rows: number } {
  const parsed = csvToImport(text);
  if (parsed.properties.length === 0) throw new Error('the file has no header row');

  let id = collectionId;
  if (!id) {
    id = repo.databases.createCollection({ name });
  }

  // The first column becomes the row title, so a CSV whose first header is
  // "Name" does not produce a page whose title is empty and a redundant
  // Name property beside it.
  const [first, ...rest] = parsed.properties;
  for (const property of rest) {
    repo.databases.addProperty(id, {
      id: newId(),
      name: property.name,
      type: property.type,
    });
  }
  const byName = new Map(repo.databases.getCollection(id)!.schema.properties.map((p) => [p.name, p]));

  let count = 0;
  for (const record of parsed.rows) {
    const title = (record[first!.name] ?? '').trim();
    const pageId = repo.createPage({ title, parentPage: repo.databases.getCollection(id)!.parentPage });
    for (const property of rest) {
      const target = byName.get(property.name);
      const raw = (record[property.name] ?? '').trim();
      if (!target || raw === '') continue;
      repo.databases.setValue(pageId, target.id, importedValue(property.type, raw) as never);
    }
    count += 1;
  }
  return { collectionId: id, rows: count };
}

const PAGE_COMMANDS: Command[] = [
  {
    id: 'page.create',
    title: 'New page',
    category: 'Page',
    description: 'Create a page, optionally nested under another.',
    searchTerms: ['add page', 'new'],
    args: {
      title: { type: 'string', default: '' },
      parentPage: { type: 'string' },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = s.createPage({
        title: (ctx.args.title as string) ?? '',
        parentPage: (ctx.args.parentPage as string) ?? null,
      });
      return { id };
    },
  },
  {
    id: 'page.open',
    title: 'Open page',
    category: 'Page',
    needsPage: false,
    args: { id: { type: 'string', required: true } },
    run: (ctx) => ctxOf(ctx).session.openPage(ctx.args.id as string),
  },
  {
    id: 'page.rename',
    title: 'Rename page',
    category: 'Page',
    args: { title: { type: 'string', required: true }, id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      // The id is optional because the common case is the page being read, but a
      // caller acting on a row of a database is naming a page that is *not*
      // open. Ignoring the argument renamed the database page itself, so a row
      // typed in a table silently renamed the table.
      const id = (ctx.args.id as string) ?? s.pageId ?? '';
      if (!id) ctx.fail('no page is open');
      if (!s.repo.getPage(id)) ctx.fail(`page.rename: no such page: ${id}`);
      s.repo.renamePage(id, ctx.args.title as string);
      // The title is its own field, not the first block: the editor draws it as
      // a heading above the document and the page model stores it separately.
      // Copying it into block zero put the same words in the page twice, and
      // again in the title line of an exported Markdown file.
      return { id, title: ctx.args.title };
    },
  },
  {
    id: 'page.moveToTrash',
    title: 'Move to trash',
    category: 'Page',
    searchTerms: ['delete', 'remove', 'trash'],
    description:
      'Move a page and its children to the trash. Pass "id" to delete a page ' +
      'straight from the sidebar without opening it.',
    menuPath: 'Page > Move to trash',
    args: {
      id: {
        type: 'string',
        description: 'Page to trash. Defaults to the open page.',
      },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      // An explicit id is what makes "delete from the sidebar" possible: the
      // sidebar row menu must be able to trash a page that was never opened.
      const id = (ctx.args.id as string) ?? (s.pageId ?? '');
      if (!id) ctx.fail('no page id given and no page is open');
      if (!s.repo.getPage(id)) ctx.fail(`no such page: ${id}`);
      s.repo.trashPage(id);
      if (id === s.pageId) s.closePage();
      return { id, trashed: true };
    },
  },
  {
    id: 'page.restore',
    title: 'Restore page',
    category: 'Page',
    args: { id: { type: 'string', required: true } },
    run: (ctx) => {
      ctxOf(ctx).session.repo.restorePage(ctx.args.id as string);
      return { id: ctx.args.id, restored: true };
    },
  },
  {
    id: 'page.deleteForever',
    title: 'Delete permanently',
    category: 'Page',
    searchTerms: ['purge', 'destroy'],
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? (s.pageId ?? '');
      if (!id) ctx.fail('no page id given and no page is open');
      if (id === s.pageId) s.closePage();
      s.repo.purgePage(id);
      return { id, deleted: true };
    },
  },
  {
    id: 'page.favorite.toggle',
    title: 'Add to favorites',
    category: 'Page',
    searchTerms: ['star', 'pin'],
    args: { favorite: { type: 'boolean' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = s.pageId ?? '';
      if (!id) ctx.fail('no page is open');
      const current = s.repo.getPage(id)?.is_favorite === 1;
      const next = ctx.args.favorite === undefined ? !current : (ctx.args.favorite as boolean);
      s.repo.toggleFavorite(id, next);
      return { id, favorite: next };
    },
  },
  {
    id: 'page.move',
    title: 'Move page',
    category: 'Page',
    args: {
      id: { type: 'string', required: true },
      parentPage: { type: 'string' },
    },
    run: (ctx) => {
      const id = ctx.args.id as string;
      // An empty or blank parent means "top level", not "a page whose id is the
      // empty string".
      //
      // `?? null` does not catch this: `''` is not nullish, so it was written
      // straight into parent_page. The page then had a parent that does not
      // exist, which the tree walk never visits -- so the command reported
      // success and the page vanished from the sidebar with no way back. The
      // UI's own "Move to..." top-level entry passes exactly this value.
      const raw = ctx.args.parentPage as string | undefined;
      const parentPage = raw !== undefined && raw.trim() !== '' ? raw.trim() : null;
      ctxOf(ctx).session.repo.movePage(id, parentPage);
      return { id, parentPage };
    },
  },
  {
    id: 'page.lock',
    title: 'Lock or unlock a page',
    category: 'Page',
    args: { id: { type: 'string' }, locked: { type: 'boolean', default: true } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? s.pageId;
      if (!id) throw new Error('page.lock: no page is open');
      const locked = (ctx.args.locked as boolean) ?? true;
      s.repo.setPageLocked(id, locked);
      return { id, locked };
    },
  },
  {
    id: 'page.backlinks',
    title: 'List the pages that mention this one',
    category: 'Page',
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? s.pageId;
      if (!id) throw new Error('page.backlinks: no page is open');
      return { pageId: id, backlinks: s.repo.backlinks(id) };
    },
  },  {
    id: 'page.duplicate',
    title: 'Duplicate page',
    category: 'Page',
    args: { id: { type: 'string', required: true } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const source = repo.getPage(ctx.args.id as string);
      if (!source) throw new Error(`page.duplicate: no such page: ${ctx.args.id}`);

      const newPageId = repo.createPage({
        title: source.title ? source.title + ' (copy)' : 'Untitled',
        parentPage: source.parent_page,
        icon: source.icon,
      });

      const sourceDoc = repo.loadPage(source.id);
      const idMap = new Map<string, string>();
      for (const oldId of Object.keys(sourceDoc.blocks)) {
        idMap.set(oldId, crypto.randomUUID());
      }
      const newDoc = { blocks: {}, roots: [] } as Doc;
      for (const oldId of Object.keys(sourceDoc.blocks)) {
        const block = sourceDoc.blocks[oldId]!;
        const newId = idMap.get(oldId)!;
        newDoc.blocks[newId] = {
          ...block,
          id: newId,
          parentId: block.parentId ? (idMap.get(block.parentId) ?? null) : null,
          children: block.children.map((childId) => idMap.get(childId)!),
        };
      }
      newDoc.roots = sourceDoc.roots.map((rootId) => idMap.get(rootId)!);
      repo.savePage(newPageId, newDoc);

      return { id: newPageId };
    },
  },
  {
    id: 'page.reorder',
    title: 'Move a page one place up or down among its siblings',
    category: 'Page',
    args: { id: { type: 'string', required: true }, direction: { type: 'number' } },
    run: (ctx) => {
      const dir = (ctx.args.direction as number) === -1 ? -1 : 1;
      const id = ctx.args.id as string;
      const moved = ctxOf(ctx).session.repo.reorderPage(id, dir);
      return { id, direction: dir, moved };
    },
  },
  {
    id: 'import.markdown',
    title: 'Import markdown into the open page',
    category: 'Import',
    args: { text: { type: 'string', required: true } },
    run: (ctx) => {
      const session = ctxOf(ctx).session;
      if (!session.pageId) throw new Error('import.markdown: no page is open');
      const parsed = markdownToDoc(String(ctx.args.text));
      // The importer is pure and does not know which pages exist, so a wiki
      // link comes out of it as text. This is the layer that can look a page
      // up.
      for (const block of Object.values(parsed.blocks)) {
        const runs = block.content.runs;
        if (!runs || runs.length === 0) continue;
        block.content = {
          runs: resolveWikiLinks(runs, (title) => session.repo.findPageByTitle(title)?.id),
        };
      }
      // One transaction: a half-imported page is worse than a failed one,
      // because the user cannot tell which half landed.
      session.edit('import markdown', (tx) => {
        for (const id of [...session.doc.roots]) {
          tx.touch(id);
          purgeBlock(session.doc, tx, id);
        }
        const copy = (from: string, parentId: string | null) => {
          const block = parsed.blocks[from]!;
          const created = insert(session.doc, {
            type: block.type,
            parentId,
            content: block.content,
            props: block.props,
          });
          tx.touch(created.id);
          for (const child of block.children) copy(child, created.id);
        };
        for (const root of parsed.roots) copy(root, null);
      });
      return { blocks: Object.keys(parsed.blocks).length };
    },
  },
  {
    id: 'import.csv',
    title: 'Import CSV into a database, inferring column types',
    category: 'Import',
    args: { text: { type: 'string', required: true }, collectionId: { type: 'string' }, name: { type: 'string' } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      return importCsvText(
        repo,
        String(ctx.args.text),
        ctx.args.collectionId as string | undefined,
        (ctx.args.name as string) ?? 'Imported',
      );
    },  },
  {
    id: 'import.folder',
    title: 'Import a folder of Markdown and CSV files as pages and databases',
    category: 'Import',
    description:
      'A workspace export is a folder of Markdown files and a CSV per database. This brings both in.',
    args: { path: { type: 'string', required: true }, parentPage: { type: 'string' } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const root = String(ctx.args.path);
      const parentPage = (ctx.args.parentPage as string) ?? null;

      let entries: string[];
      try {
        entries = readdirSync(root, { recursive: true, encoding: 'utf8' });
      } catch {
        throw new Error('import.folder: cannot read "' + root + '"');
      }

      const pages: string[] = [];
      const databases: string[] = [];

      for (const entry of entries) {
        if (entry.includes('..') || entry.startsWith('.')) continue;
        const absolute = join(root, entry);
        if (entry.endsWith('.md')) {
          const body = readFileSync(absolute, 'utf8');
          // The title of an exported page is its first heading. A file with
          // no heading takes its name, which is better than an empty title.
          const heading = /^#\s+(.+)$/m.exec(body);
          const title = (heading?.[1] ?? entry.replace(/\.md$/, '')).trim();
          const pageId = repo.createPage({ title, parentPage, icon: null });
          repo.savePage(pageId, markdownToDoc(body.replace(/^#\s+.+$/m, '')));
          pages.push(title);
        } else if (entry.endsWith('.csv')) {
          const name = entry.replace(/\.csv$/, '');
          const result = importCsvText(repo, readFileSync(absolute, 'utf8'), undefined, name);
          databases.push(name + ' (' + result.rows + ' rows)');
        }
      }

      return { pages, databases, imported: pages.length + databases.length };
    },
  },
  {
    id: 'page.appearance.set',
    title: "Set a page's width, text size, font or cover",
    category: 'Page',
    args: {
      id: { type: 'string' },
      fullWidth: { type: 'boolean' },
      smallText: { type: 'boolean' },
      font: { type: 'string' },
      cover: { type: 'string' },
    },
    run: (ctx) => {
      const session = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? session.pageId;
      if (!id) throw new Error('page.appearance.set: no page is open');
      if (!session.repo.getPage(id)) throw new Error(`page.appearance.set: no such page: ${id}`);

      // The font is validated against a fixed list rather than written
      // through: it becomes a CSS font-family, and an arbitrary string there is
      // a way to put arbitrary declarations into a stylesheet.
      const FONTS = ['sans', 'serif', 'mono'];
      const font = ctx.args.font as string | undefined;
      if (font !== undefined && !FONTS.includes(font)) {
        throw new Error(`page.appearance.set: unknown font: ${font}`);
      }

      session.repo.setPageAppearance(id, {
        cover: ctx.args.cover === undefined ? undefined : ((ctx.args.cover as string) || null),
        fullWidth: ctx.args.fullWidth as boolean | undefined,
        smallText: ctx.args.smallText as boolean | undefined,
        font,
      });
      return { id };
    },
  },
  {
    id: 'inline.page.set',
    title: 'Turn a range of text into a link to a page, or remove the link',
    category: 'Text',
    undoable: true,
    args: {
      id: { type: 'string' },
      from: { type: 'number', default: 0 },
      to: { type: 'number', default: 0 },
      pageId: { type: 'string', default: '' },
      label: { type: 'string', default: '' },
    },
    run: (ctx: CommandContext) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const from = (ctx.args.from as number) ?? 0;
      const to = (ctx.args.to as number) ?? from;
      const pageId = ((ctx.args.pageId as string) ?? '').trim();
      const label = (ctx.args.label as string) ?? '';

      // An empty pageId removes the mention rather than failing. Typing over a
      // mention is a normal thing to do, and a command that errors on removal
      // cannot be used to undo one cleanly.
      let node: InlineNode | null = null;
      if (pageId !== '') {
        const target = s.repo.getPage(pageId);
        if (!target) throw new Error(`inline.page.set: no such page: ${pageId}`);
        if (target.trashed_at !== null) {
          throw new Error(`inline.page.set: page is in the trash: ${pageId}`);
        }
        node = { kind: 'page', pageId, label: label || target.title };
      }

      s.edit('set page link', (tx) => {
        tx.touch(id);
        const block = s.doc.blocks[id]!;
        block.content = { runs: setInline(block.content.runs, from, to, node, node ? label : '') };
      });
      return { id, from, to, pageId: pageId || null };
    },
  },
    {
    id: 'inline.equation.set',
    title: 'Turn a range of text into an equation, or remove it',
    category: 'Text',
    undoable: true,
    args: {
      id: { type: 'string' },
      from: { type: 'number', default: 0 },
      to: { type: 'number', default: 0 },
      latex: { type: 'string', default: '' },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const from = (ctx.args.from as number) ?? 0;
      const to = (ctx.args.to as number) ?? from;
      const latex = ((ctx.args.latex as string) ?? '').trim();
      // An empty latex removes the equation rather than failing. Typing over
      // an equation is a normal thing to do.
      const node: InlineNode | null = latex === '' ? null : { kind: 'equation', latex };
      // The text of the run is the text as it is *drawn*, not the LaTeX, so
      // that what is on the screen and what the model holds are the same
      // string. The editor compares them, and a difference between the two
      // would tear the equation apart on the next keystroke.
      const shown = latex === '' ? '' : latexText(latex);
      s.edit('set equation', (tx) => {
        tx.touch(id);
        const block = s.doc.blocks[id]!;
        block.content = { runs: setInline(block.content.runs, from, to, node, shown) };
      });
      return { id, from, to, latex: latex || null };
    },
  },
  {
    id: 'inline.tag.set',
    title: 'Turn a range of text into a tag, or remove it',
    category: 'Text',
    undoable: true,
    args: {
      id: { type: 'string' },
      from: { type: 'number', default: 0 },
      to: { type: 'number', default: 0 },
      name: { type: 'string', default: '' },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const from = (ctx.args.from as number) ?? 0;
      const to = (ctx.args.to as number) ?? from;
      const name = ((ctx.args.name as string) ?? '').trim().replace(/^#/, '');
      const node: InlineNode | null = name === '' ? null : { kind: 'tag', name };
      s.edit('set tag', (tx) => {
        tx.touch(id);
        const block = s.doc.blocks[id]!;
        block.content = { runs: setInline(block.content.runs, from, to, node, '#' + name) };
      });
      return { id, from, to, name: name || null };
    },
  },
  {
    id: 'inline.wiki.set',
    title: 'Turn a range of text into a link to another page, by name',
    category: 'Text',
    undoable: true,
    args: {
      id: { type: 'string' },
      from: { type: 'number', default: 0 },
      to: { type: 'number', default: 0 },
      title: { type: 'string', default: '' },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const from = (ctx.args.from as number) ?? 0;
      const to = (ctx.args.to as number) ?? from;
      const title = ((ctx.args.title as string) ?? '').trim();
      // A title that matches no page is an error rather than a silent link to
      // nothing: a link that goes nowhere is worse than a message.
      const page = title === '' ? undefined : s.repo.findPageByTitle(title);
      if (title !== '' && !page) {
        throw new Error('inline.wiki.set: no page called "' + title + '"');
      }
      const node: InlineNode | null = page ? { kind: 'page', pageId: page.id, label: page.title } : null;
      s.edit('set wiki link', (tx) => {
        tx.touch(id);
        const block = s.doc.blocks[id]!;
        block.content = { runs: setInline(block.content.runs, from, to, node, '') };
      });
      return { id, from, to, pageId: page?.id ?? null };
    },
  },
{
    id: 'export.markdown',
    title: 'Export a page as markdown',
    category: 'Export',
    args: { pageId: { type: 'string' } },
    run: (ctx) => {
      const session = ctxOf(ctx).session;
      // Falls back to the open page: exporting "the current page" is what almost
      // every caller means, and making them look it up first is a step with no
      // information in it.
      const pageId = (ctx.args.pageId as string) ?? session.pageId;
      if (!pageId) throw new Error('export.markdown: no page is open');
      const page = session.repo.getPage(pageId);
      if (!page) throw new Error(`export.markdown: no such page: ${pageId}`);
      const markdown = pageId === session.pageId ? docToMarkdown(session.doc, page.title) : docToMarkdown(session.repo.loadPage(pageId), page.title);
      return { pageId, markdown };
    },
  },
  {
    id: 'export.csv',
    title: 'Export database rows as CSV',
    category: 'Export',
    args: { collectionId: { type: 'string', required: true } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const collectionId = ctx.args.collectionId as string;
      const collection = repo.databases.getCollection(collectionId);
      if (!collection) throw new Error(`export.csv: no such collection: ${collectionId}`);
      const rows = repo.databases.rows(collectionId).map(({ page, values }) => ({
        title: page.title,
        values: Object.fromEntries(values),
      }));
      return { collectionId, csv: rowsToCsv(rows, collection.schema.properties) };
    },
  },
  {
    id: 'page.history.save',
    title: 'Save a named version',
    category: 'Page',
    args: { label: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const pageId = s.pageId ?? '';
      if (!pageId) ctx.fail('no page is open');
      return { id: s.repo.saveVersion(pageId, s.doc, (ctx.args.label as string) ?? null) };
    },
  },
  {
    id: 'page.history.list',
    title: 'List page versions',
    category: 'Page',
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const pageId = s.pageId ?? '';
      if (!pageId) ctx.fail('no page is open');
      return s.repo.listVersions(pageId);
    },
  },
  {
    id: 'page.history.restore',
    title: 'Restore a version',
    category: 'Page',
    args: { versionId: { type: 'string', required: true } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const found = s.repo.loadVersion(ctx.args.versionId as string);
      if (!found) return ctx.fail('no such version');
      const restored: import('@ow/model').Doc = found;
      s.doc = restored;
      s.selection = s.doc.roots[0] ? caretAt(s.doc.roots[0], 0) : null;
      s.history.clear();
      // Keep the old state reachable: restoring creates a new version rather
      // than destroying the one being replaced.
      if (s.pageId) s.repo.saveVersion(s.pageId, restored, 'before restore');
      s.flush();
      return { restored: ctx.args.versionId };
    },
  },
];

const BLOCK_COMMANDS: Command[] = [
  {
    id: 'block.insert',
    title: 'Insert block',
    category: 'Block',
    args: {
      type: { type: 'string', default: 'paragraph', enum: INSERTABLE_BLOCK_TYPES },
      text: { type: 'string', default: '' },
      parentId: { type: 'string' },
    },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const parentId = (ctx.args.parentId as string) ?? null;
      const text = (ctx.args.text as string) ?? '';
      let id = '';
      s.edit('insert block', (tx) => {
        const b = insert(s.doc, { type: (ctx.args.type as string) ?? 'paragraph', parentId, content: plain(text) });
        tx.touch(b.id);
        id = b.id;
      });
      return { id };
    },
  },
  {
    id: 'block.setText',
    title: 'Set block text',
    category: 'Block',
    args: {
      id: { type: 'string' },
      text: { type: 'string', default: '' },
    },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const text = (ctx.args.text as string) ?? '';
      // Storing the text as a single run rather than parsing it here is
      // deliberate. Markdown input rules and inline formatting are separate
      // commands that run at their own moments; if this one also interpreted
      // the string then typing "*bold*" would reformat on every keystroke and
      // the user could not type a literal asterisk.
      // touch() BEFORE mutating. This ordering is a hard requirement, not a
      // style preference: touch records a clone of the block as it is *now*, so
      // touching after the write records the new value as the "before" state and
      // undo becomes a no-op that looks like it worked. It is invisible until
      // someone presses Ctrl+Z and nothing happens, which is exactly how it was
      // found. tests/parity/undo.test.ts guards it.
      s.edit(
        'set block text',
        (tx) => {
          tx.touch(id);
          const block = s.doc.blocks[id]!;
          if (!text) {
            block.content = { runs: [] };
            return;
          }
          // The change is the smallest edit that turns the old text into the
          // new one.
          //
          // Replacing the whole content would delete every mention, equation
          // and tag in the block on the next keystroke, because the editor
          // sends the text it can see and the text of an inline node is not
          // the text the node holds. Working out the change and splicing it
          // leaves the nodes outside it alone.
          const edit = diffText(textOf(block.content), text);
          block.content = { runs: spliceText(block.content.runs, edit.from, edit.to, edit.value) };
        },
        // Coalescible, and that is load-bearing. Without it every keystroke
        // becomes its own history entry and undo walks back one character at a
        // time, which is worse than having no undo at all. The group is what
        // makes coalescing possible at all: two edits only merge when they name
        // the same group, so this scopes a typing burst to one block.
        { coalescible: true, group: `text:${id}` },
      );
      return { id };
    },
  },
  {
    id: 'block.setChecked',
    title: 'Set to-do state',
    category: 'Block',
    args: {
      id: { type: 'string' },
      checked: { type: 'boolean' },
    },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const checked = ctx.args.checked as boolean | undefined;
      // Toggle when the caller expresses no preference. A checkbox click is
      // "flip this" and should not have to know the current value; the CLI,
      // which does know it, can pass an explicit boolean and be idempotent.
      const next =
        typeof checked === 'boolean'
          ? checked
          : !Boolean(get(s.doc, id).props.checked);
      s.edit('set to-do state', (tx) => {
        tx.touch(id);
        setProps(s.doc, id, { checked: next });
      });
      return { id, checked: next };
    },
  },
  {
    id: 'block.delete',
    title: 'Delete block',
    category: 'Block',
    args: { id: { type: 'string' } },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('delete block', (tx) => purgeBlock(s.doc, tx, id));
      return { id };
    },
  },
  {
    id: 'block.deleteRange',
    title: 'Delete every block in a range as one undoable step',
    category: 'Block',
    args: { anchorId: { type: 'string' }, focusId: { type: 'string' } },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const anchorId = ctx.args.anchorId as string;
      const focusId = (ctx.args.focusId as string | undefined) ?? anchorId;

      for (const id of [anchorId, focusId]) {
        if (!s.doc.blocks[id]) throw new Error(`block.deleteRange: no such block: ${id}`);
      }

      // deletableIds already handles the part that is easy to get wrong:
      // deleting a block deletes its subtree, so a range naming both a container
      // and its own child has fewer blocks to remove than it has names. Writing
      // that filter again here is how two implementations end up disagreeing.
      const ids = deletableIds(s.doc, blockSelection(anchorId, focusId));
      if (ids.length === 0) throw new Error('block.deleteRange: range resolved to nothing');

      // One edit for the whole range. N separate edits would need N undos, and a
      // user deleting six paragraphs expects one Ctrl+Z to bring them all back.
      s.edit(`delete ${ids.length} block(s)`, (tx) => {
        for (const id of ids) purgeBlock(s.doc, tx, id);
      });

      return { ids };
    },
  },
  {
    id: 'block.indentRange',
    title: 'Indent or outdent every block in a selection as one undoable step',
    category: 'Block',
    args: {
      anchorId: { type: 'string' },
      focusId: { type: 'string' },
      outdent: { type: 'boolean', default: false },
    },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const anchorId = ctx.args.anchorId as string;
      const focusId = (ctx.args.focusId as string | undefined) ?? anchorId;
      // Not named `outdent`: that would shadow the imported command and the
      // second call would be calling itself.
      const goingOut = ctx.args.outdent === true;

      for (const id of [anchorId, focusId]) {
        if (!s.doc.blocks[id]) throw new Error(`block.indentRange: no such block: ${id}`);
      }

      // `fullySelectedBlocks` is the model's own answer to which blocks are in a
      // selection. An earlier version of this command re-derived it by hand and
      // disagreed with it; there is one implementation and this calls it.
      const ids = fullySelectedBlocks(s.doc, blockSelection(anchorId, focusId));
      if (ids.length === 0) throw new Error('block.indentRange: selection resolved to no blocks');

      // Only the outermost blocks of the range move. Indenting a nested block
      // whose parent is also moving would detach it and re-attach it to whatever
      // the parent just became, moving blocks the user did not select and leaving
      // a tree nobody asked for. Their subtrees come along untouched.
      const outermost = ids.filter(
        (id) => !ids.some((other) => other !== id && isDescendant(s.doc, other, id)),
      );

      // One edit. A range indent needing one undo per block is worse than none,
      // because nobody can predict where Ctrl+Z will stop.
      //
      // Document order, not reversed. Each block is made a child of its previous
      // sibling, so after the first move the block below still has an earlier
      // block as its previous sibling and also lands in the same new parent --
      // which is what "indent these two" means: siblings one level in, not one
      // nested inside the other. I tried running this backwards on the theory
      // that the moving target was the problem; it is not, and it turned two
      // siblings into a chain.
      s.edit(`${goingOut ? 'outdent' : 'indent'} ${outermost.length} block(s)`, (tx) => {
        // Touch every block before moving any of them. `touch` records the block's
        // index in its parent *at the moment it is called*, so touching lazily as
        // the loop goes records each block's position relative to the blocks
        // already moved: the second block of this range was snapshotted as being
        // at index 1 because the first had already left `roots`. Undo then re-seats
        // it there and silently swaps two blocks. Recorded up front, every snapshot
        // describes the tree the user was actually looking at.
        for (const id of outermost) tx.touch(id);

        for (const id of outermost) {
          if (goingOut) outdent(s.doc, tx, id);
          else indent(s.doc, tx, id);
        }
      });

      return { ids: outermost };
    },
  },
  {
    id: 'block.trash',
    title: 'Move block to trash',
    category: 'Block',
    args: { id: { type: 'string' } },
    undoable: true,
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('trash block', (tx) => moveToTrash(s.doc, tx, id));
      return { id };
    },
  },
  {
    id: 'block.restore',
    title: 'Restore block',
    category: 'Block',
    undoable: true,
    args: { id: { type: 'string', required: true } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      s.edit('restore block', (tx) => restore(s.doc, tx, ctx.args.id as string));
      return { id: ctx.args.id };
    },
  },
  {
    id: 'block.duplicate',
    title: 'Duplicate block',
    category: 'Block',
    keys: SHORTCUTS.duplicate,
    undoable: true,
    args: { id: { type: 'string' }, withChildren: { type: 'boolean', default: true } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      let copyId = '';
      s.edit('duplicate block', (tx) => {
        tx.mark(id);
        copyId = duplicateBlock(s.doc, id, (ctx.args.withChildren as boolean) ?? true);
      });
      return { id: copyId };
    },
  },
  {
    id: 'block.indent',
    title: 'Indent block',
    category: 'Block',
    keys: SHORTCUTS.indent,
    undoable: true,
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('indent', (tx) => indent(s.doc, tx, id));
      return { id };
    },
  },
  {
    id: 'block.outdent',
    title: 'Outdent block',
    category: 'Block',
    keys: SHORTCUTS.outdent,
    undoable: true,
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('outdent', (tx) => outdent(s.doc, tx, id));
      return { id };
    },
  },
  {
    id: 'block.moveTo',
    title: 'Move a block before or after another block',
    category: 'Block',
    undoable: true,
    args: {
      id: { type: 'string', required: true },
      targetId: { type: 'string', required: true },
      position: { type: 'string', default: 'before' },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = ctx.args.id as string;
      const targetId = ctx.args.targetId as string;
      const target = s.doc.blocks[targetId];
      if (!target) throw new Error(`block.moveTo: no such block: ${targetId}`);
      if (id === targetId) return { id, moved: false };

      // "After" is expressed as "before the target's next sibling", because
      // moveBlock only speaks before-id. With no next sibling, null appends to
      // the end of the parent, which is what the user meant.
      const siblings = target.parentId === null ? s.doc.roots : s.doc.blocks[target.parentId]!.children;
      const at = siblings.indexOf(targetId);
      const beforeId =
        ctx.args.position === 'after' ? (at + 1 < siblings.length ? siblings[at + 1]! : null) : targetId;

      // Snapshot before the move: afterwards the id's parent is the new one, so
      // touching afterwards records the wrong blocks for undo.
      const touched = [id, target.parentId ?? '', ...subtreeIds(s.doc, id)];

      // moveBlock refuses a move into the block's own subtree, which is the
      // check a drag needs: dropping a parent into its own child would detach
      // the whole tree from the page.
      moveBlock(s.doc, id, target.parentId, beforeId);
      s.edit('move block', (tx) => {
        for (const b of touched) tx.touch(b);
      });
      return { id, moved: true, parentId: target.parentId, beforeId };
    },
  },
  {
    id: 'block.move.up',
    title: 'Move block up',
    category: 'Block',
    keys: SHORTCUTS.moveBlockUp,
    undoable: true,
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('move block up', (tx) => moveSibling(s.doc, tx, id, -1));
      return { id };
    },
  },
  {
    id: 'block.move.down',
    title: 'Move block down',
    category: 'Block',
    keys: SHORTCUTS.moveBlockDown,
    undoable: true,
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('move block down', (tx) => moveSibling(s.doc, tx, id, 1));
      return { id };
    },
  },
  {
    id: 'block.toggleOpen',
    title: 'Toggle open',
    category: 'Block',
    keys: SHORTCUTS.modifyBlock,
    undoable: true,
    args: { id: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      s.edit('toggle', (tx) => toggleOpen(s.doc, tx, id));
      return { id };
    },
  },
  {
    id: 'block.enter',
    title: 'Insert a new block below',
    category: 'Block',
    description: 'Split the current block at the caret.',
    undoable: true,
    args: {
      id: { type: 'string' },
      offset: { type: 'number', default: 0 },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      let caret = { blockId: id, offset: (ctx.args.offset as number) ?? 0 };
      s.edit('enter', (tx) => {
        tx.touch(id);
        caret = insertLineBreak(s.doc, tx, caret).caret;
      });
      s.selection = caretAt(caret.blockId, caret.offset);
      return caret;
    },
  },
  {
    id: 'block.backspace',
    title: 'Delete backwards',
    category: 'Block',
    undoable: true,
    args: {
      id: { type: 'string' },
      offset: { type: 'number', default: 0 },
    },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      let caret = { blockId: id, offset: (ctx.args.offset as number) ?? 0 };
      s.edit('backspace', (tx) => {
        tx.touch(id);
        caret = mergeBackward(s.doc, tx, caret).caret;
      });
      s.selection = caretAt(caret.blockId, caret.offset);
      return caret;
    },
  },
];



const TURN_INTO_COMMANDS: Command[] = TURN_INTO_TYPES.map((type) => ({
  id: turnIntoId(type),
  keys: TURN_INTO_CHORDS[type],
  title: `Turn into ${type}`,
  category: 'Block',
  undoable: true,
  args: { id: { type: 'string' } },
  run: (ctx: CommandContext) => {
    const s = ctxOf(ctx).session;
    const id = (ctx.args.id as string) ?? currentBlockId(ctx);
    s.edit('turn into', (tx) => turnInto(s.doc, tx, id, type));
    return { id, type };
  },
}));

const TEXT_COMMANDS: Command[] = (
  [
    ['bold', 'Bold', SHORTCUTS.bold.win, SHORTCUTS.bold.mac],
    ['italic', 'Italic', SHORTCUTS.italic.win, SHORTCUTS.italic.mac],
    ['underline', 'Underline', SHORTCUTS.underline.win, SHORTCUTS.underline.mac],
    ['strikethrough', 'Strikethrough', SHORTCUTS.strikethrough.win, SHORTCUTS.strikethrough.mac],
    ['code', 'Inline code', SHORTCUTS.inlineCode.win, SHORTCUTS.inlineCode.mac],
  ] as const
).map(([mark, title, win, mac]) => ({
  id: `mark.${mark}.toggle`,
  title,
  category: 'Text',
  keys: { win, mac },
  undoable: true,
  args: {
    id: { type: 'string' },
    from: { type: 'number', default: 0 },
    to: { type: 'number', default: 0 },
  },
  run: (ctx: CommandContext) => {
    const s = ctxOf(ctx).session;
    const id = (ctx.args.id as string) ?? currentBlockId(ctx);
    const from = (ctx.args.from as number) ?? 0;
    const to = (ctx.args.to as number) ?? from;
    s.edit(`toggle ${mark}`, (tx) => {
      tx.touch(id);
      const block = s.doc.blocks[id]!;
      block.content = {
        runs: toggleMark(block.content.runs, from, to, mark as Mark),
      };
    });
    return { id, from, to };
  },
}));

const APP_COMMANDS: Command[] = [
  {
    id: 'mark.link.set',
    title: 'Link or unlink the selection',
    category: 'Text',
    keys: { win: 'Ctrl+K', mac: 'Cmd+K' },
    undoable: true,
    args: {
      id: { type: 'string' },
      from: { type: 'number', default: 0 },
      to: { type: 'number', default: 0 },
      href: { type: 'string' },
    },
    run: (ctx: CommandContext) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const from = (ctx.args.from as number) ?? 0;
      const to = (ctx.args.to as number) ?? from;
      const href = (ctx.args.href as string | undefined) ?? '';

      // Only schemes a browser will actually navigate. `javascript:` in a
      // contenteditable is script execution with a click, and the block is
      // rendered as an anchor.
      let link: Link | null = null;
      if (href.trim().length > 0) {
        const value = href.trim();
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
        if (scheme && !['http', 'https', 'mailto', 'openfield'].includes(scheme)) {
          throw new Error(`mark.link.set: refusing ${scheme}: link`);
        }
        link = { href: value };
      }

      s.edit('set link', (tx) => {
        tx.touch(id);
        const block = s.doc.blocks[id]!;
        block.content = { runs: setLink(block.content.runs, from, to, link) };
      });
      return { id, from, to, href: link?.href ?? null };
    },
  },
  {
    id: 'mark.color.set',
    title: 'Set the text or background colour of the selection',
    category: 'Text',
    undoable: true,
    args: {
      id: { type: 'string' },
      from: { type: 'number', default: 0 },
      to: { type: 'number', default: 0 },
      color: { type: 'string' },
      background: { type: 'string' },
    },
    run: (ctx: CommandContext) => {
      const s = ctxOf(ctx).session;
      const id = (ctx.args.id as string) ?? currentBlockId(ctx);
      const from = (ctx.args.from as number) ?? 0;
      const to = (ctx.args.to as number) ?? from;
      const read = (name: 'color' | 'background'): ColorName | undefined => {
        const raw = ctx.args[name] as string | undefined;
        if (raw === undefined) return undefined;
        // Validated rather than written through: the name becomes a CSS
        // attribute selector, and an arbitrary string there selects nothing and
        // silently stores a colour the palette can never render.
        if (!COLOR_NAMES.includes(raw as ColorName)) {
          throw new Error(`mark.color.set: unknown ${name}: ${raw}`);
        }
        return raw as ColorName;
      };
      const color = read('color');
      const background = read('background');

      s.edit('set colour', (tx) => {
        // Before the mutation: touch clones the block as it is at call time, so
        // calling it after would record the new value as the "before" state.
        tx.touch(id);
        const block = s.doc.blocks[id]!;
        block.content = { runs: setColor(block.content.runs, from, to, color, background) };
      });
      return { id, from, to, color: color ?? null, background: background ?? null };
    },
  },
  {
    id: 'history.versions.list',
    title: 'List the saved versions of a page',
    category: 'History',
    args: { pageId: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const pageId = (ctx.args.pageId as string) ?? s.pageId;
      if (!pageId) throw new Error('history.versions.list: no page is open');
      if (!s.repo.getPage(pageId)) throw new Error(`history.versions.list: no such page: ${pageId}`);
      return { pageId, versions: s.repo.listVersions(pageId) };
    },
  },
  {
    id: 'history.versions.preview',
    title: 'Read one saved version of a page',
    category: 'History',
    args: { versionId: { type: 'string', required: true } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const versionId = ctx.args.versionId as string;
      const doc = s.repo.loadVersion(versionId);
      if (!doc) throw new Error(`history.versions.preview: no such version: ${versionId}`);
      // As markdown, because that is what the preview shows and what a caller
      // wants to read. A caller that wanted the structure loads the version.
      return { versionId, text: docToMarkdown(doc) };
    },
  },
  {
    id: 'history.versions.restore',
    title: 'Restore a saved version of a page',
    category: 'History',
    undoable: true,
    args: { versionId: { type: 'string', required: true } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const versionId = ctx.args.versionId as string;
      if (!s.pageId) throw new Error('history.versions.restore: no page is open');
      if (!s.restoreVersion(versionId)) {
        throw new Error(`history.versions.restore: no such version: ${versionId}`);
      }
      return { pageId: s.pageId, versionId, restored: true };
    },
  },
  {
    id: 'history.undo',
    title: 'Undo',
    category: 'App',
    keys: SHORTCUTS.undo,
    run: (ctx) => {
      const undone = ctxOf(ctx).session.undo();
      // Report honestly. Returning a truthy object when nothing was reversed
      // makes the command look wired up to anything driving it -- an agent
      // running a script, or a UI that wants to say "nothing to undo".
      if (!undone) throw new Error('nothing to undo');
      return { undone: true };
    },
  },
  {
    id: 'history.redo',
    title: 'Redo',
    category: 'App',
    keys: SHORTCUTS.redo,
    run: (ctx) => {
      const redone = ctxOf(ctx).session.redo();
      if (!redone) throw new Error('nothing to redo');
      return { redone: true };
    },
  },
  {
    id: 'page.inspect',
    title: 'Inspect the open page',
    category: 'App',
    description: 'Return the page structure as indented lines. Primary agent check.',
    run: (ctx) => ctxOf(ctx).session.inspect(),
  },
  {
    id: 'search.quickFind',
    title: 'Search pages',
    category: 'App',
    keys: SHORTCUTS.quickFind,
    args: { query: { type: 'string', default: '' } },
    run: (ctx) => ctxOf(ctx).session.repo.search((ctx.args.query as string) ?? '', 20),
  },
  {
    id: 'db.page.list',
    title: 'List pages',
    category: 'Database',
    run: (ctx) => ctxOf(ctx).session.repo.allPages(),
  },
  {
    id: 'db.page.trashList',
    title: 'List trashed pages',
    category: 'Database',
    run: (ctx) => ctxOf(ctx).session.repo.trashedPages(),
  },
  {
    id: 'db.favoriteList',
    title: 'List favorite pages',
    category: 'Database',
    run: (ctx) => ctxOf(ctx).session.repo.favoritePages(),
  },
  {
    id: 'db.selfTest',
    title: 'Run the storage integrity check',
    category: 'Database',
    description: 'Report and repair structural problems in the workspace.',
    run: (ctx) => ctxOf(ctx).session.repo.selfTest(),
  },
  {
    id: 'db.stats',
    title: 'Show workspace statistics',
    category: 'Database',
    run: (ctx) => ctxOf(ctx).session.repo.stats(),
  },
];

/**
 * Commands that put the pages on disk as Markdown.
 *
 * The notes folder is the thing a person points at whatever they already
 * sync: a Syncthing folder, iCloud Drive, Dropbox, a home server over SMB or
 * NFS. The database stays where it is, because a live SQLite file travelling
 * between two machines is how you get two corrupt copies instead of one good
 * one.
 */
const FILES_COMMANDS: Command[] = [
  {
    id: 'files.root',
    title: 'Get or set the folder the notes are written to',
    category: 'Files',
    description:
      'The folder every page is written to as a Markdown file. Point it at a synced folder and the notes travel.',
    args: { path: { type: 'string' } },
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const path = ctx.args.path as string | undefined;
      if (typeof path === 'string' && path.trim().length > 0) {
        s.repo.setSetting('files.root', path.trim());
      }
      return { root: s.repo.getSetting<string>('files.root', s.repo.defaultNotesRoot) };
    },
  },
  {
    id: 'files.status',
    title: 'Show what the notes folder holds',
    category: 'Files',
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const root = s.repo.getSetting<string>('files.root', s.repo.defaultNotesRoot);
      return new FileMirror(s.repo, root).status();
    },
  },
  {
    id: 'files.sync',
    title: 'Write the pages to the notes folder and read back what changed',
    category: 'Files',
    description:
      'Imports files that changed outside the app first, then writes every page. Importing before writing is the order that matters: writing first would overwrite the edit that was waiting to be read.',
    run: (ctx) => {
      const s = ctxOf(ctx).session;
      const root = s.repo.getSetting<string>('files.root', s.repo.defaultNotesRoot);
      const mirror = new FileMirror(s.repo, root);
      const imported = mirror.importChanged();
      const written = mirror.materialise();
      return {
        root,
        imported: imported.imported,
        written: written.written,
        unchanged: written.unchanged.length,
        missing: imported.skipped,
      };
    },
  },
];

function currentBlockId(ctx: CommandContext): string {
  const s = ctxOf(ctx).session;
  if (s.selection && s.selection.level === 'text') return s.selection.blockId;
  const first = s.doc.roots[0];
  if (first) return first;
  throw new Error('no block to act on');
}

export function builtinCommands(): Command[] {
  return [
    ...PAGE_COMMANDS,
    ...BLOCK_COMMANDS,
    ...TURN_INTO_COMMANDS,
    ...TEXT_COMMANDS,
    ...APP_COMMANDS,
    ...DB_COMMANDS,
    ...FILES_COMMANDS,
    ...AI_COMMANDS,
  ];
}

/** Commands that operate on the open page's blocks, for the ledger generator. */
export function editorCommands(): Command[] {
  return [...BLOCK_COMMANDS, ...TURN_INTO_COMMANDS, ...TEXT_COMMANDS];
}

export function pageTreeCommands(): Command[] {
  return PAGE_COMMANDS;
}

export function appCommands(): Command[] {
  return APP_COMMANDS;
}

void walk;