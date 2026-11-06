/**
 * Pages as Markdown files on disk.
 *
 * The app stores its documents in SQLite because that is what makes the
 * editor fast and the transactions atomic. But a database is a bad
 * interchange format: another program cannot open it, and a file-sync tool
 * carrying a live SQLite file between two machines will eventually hand both
 * of them a corrupt one.
 *
 * So every page is also written as a Markdown file, and the file is the
 * thing that travels. The user points the notes folder at whatever they
 * already sync -- Syncthing, iCloud Drive, Dropbox, a home server over SMB or
 * NFS -- and the notes go with it. The database stays on the machine that
 * wrote it.
 *
 * The direction that matters is the one nobody thinks about: a file that
 * changed *outside* the app has to come back in. A page is re-read when the
 * hash of its file no longer matches the hash recorded when the app last
 * wrote it. Hashes rather than timestamps, because two clocks are not
 * comparable and a sync tool does not preserve them anyway.
 *
 * The format is deliberately plain: YAML-ish frontmatter, then Markdown, in
 * the shape every other editor already reads.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { docToMarkdown, markdownToDoc, resolveWikiLinks } from '@ow/model';
import type { Doc } from '@ow/model';
import type { Repository } from './repository.js';

export interface MirrorFile {
  /** Path relative to the notes root, with forward slashes. */
  path: string;
  id: string;
  title: string;
}

export interface MirrorStatus {
  root: string;
  /** Pages that have a file. */
  files: number;
  /** Files on disk whose content differs from what the app last wrote. */
  changed: string[];
  /** Pages whose file has disappeared from disk. */
  missing: string[];
  /** Files on disk that belong to no page. */
  unknown: string[];
}

/**
 * Turn a page title into something a filesystem will accept.
 *
 * Windows is the strict one: `< > : " / \ | ? *` are all reserved, a name
 * cannot end in a dot or a space, and there are reserved device names. The
 * same rules are applied everywhere so a notes folder can move between
 * machines without the paths changing under it.
 */
export function sanitiseFileName(title: string): string {
  let name = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot or space is dropped by Windows silently, which would
    // make the file we wrote and the file we look for different files.
    .replace(/[. ]+$/g, '')
    .trim();
  if (name.length > 120) name = name.slice(0, 120).trim();
  // The reserved device names, with or without an extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return name.length > 0 ? name : 'Untitled';
}

/** The hash used to decide whether a file changed underneath us. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

interface Frontmatter {
  [key: string]: string | string[] | Record<string, string>;
}

/**
 * Parse the frontmatter block.
 *
 * A small YAML subset, on purpose: a dependency that parses YAML properly is
 * a dependency that brings a parser with a history of surprising people. What
 * a note needs is scalars, one level of nesting, and lists.
 */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Frontmatter = {};
  let nestedKey: string | null = null;

  for (const raw of match[1]!.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();
    if (line.startsWith('- ')) {
      if (!nestedKey) continue;
      const value = line.slice(2).trim().replace(/^["']|["']$/g, '');
      const existing = data[nestedKey];
      if (Array.isArray(existing)) existing.push(value);
      else data[nestedKey] = [value];
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (indented && nestedKey) {
      const outer = data[nestedKey];
      if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
        (outer as Record<string, string>)[key] = stripQuotes(value);
      }
      continue;
    }
    if (value.length === 0) {
      // A key with no value opens either a list or a nested map.
      nestedKey = key;
      data[key] = {};
      continue;
    }
    nestedKey = null;
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => stripQuotes(v.trim()))
        .filter((v) => v.length > 0);
      continue;
    }
    data[key] = stripQuotes(value);
  }
  // A key that opened a list but never got one is an empty map; make it a list.
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      data[key] = [];
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Render the frontmatter block. */
export function renderFrontmatter(data: Frontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: [${value.map((v) => quoteIfNeeded(v)).join(', ')}]`);
      continue;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) continue;
      lines.push(`${key}:`);
      for (const [k, v] of entries) lines.push(`  ${k}: ${quoteIfNeeded(v)}`);
      continue;
    }
    lines.push(`${key}: ${quoteIfNeeded(String(value))}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  if (value.length === 0) return '""';
  if (/^[\s]|[\s]$|[:#\[\]{},&*!|>'"%@`]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Keeps the notes folder in step with the database.
 */
export class FileMirror {
  /**
   * Written out rather than as constructor parameter properties, because the
   * CLI runs this TypeScript source directly and Node's type stripping does
   * not support parameter properties.
   */
  private readonly repo: Repository;
  private readonly root: string;

  constructor(repo: Repository, root: string) {
    this.repo = repo;
    this.root = root;
  }

  /**
   * The file path for every page, mirroring the page tree.
   *
   * A child page lives in a folder named after its parent, so the folder
   * tree in any file browser is the page tree. That is what makes the folder
   * navigable without this app.
   */
  plan(): MirrorFile[] {
    const pages = this.repo.allPages().filter((p) => p.trashedAt === null);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const used = new Set<string>();
    const out: MirrorFile[] = [];

    // Parents before children, so a folder name is known before it is needed.
    const ordered = [...pages].sort((a, b) => a.position.localeCompare(b.position));

    for (const page of ordered) {
      const segments: string[] = [];
      let parent = page.parentPage;
      let guard = 0;
      while (parent && guard++ < 64) {
        const parentPage = byId.get(parent);
        if (!parentPage) break;
        segments.unshift(sanitiseFileName(parentPage.title));
        parent = parentPage.parentPage;
      }
      let name = sanitiseFileName(page.title);
      let path = [...segments, `${name}.md`].join('/');
      // Two pages can legitimately have the same title. The second one gets a
      // numbered suffix rather than overwriting the first.
      let counter = 2;
      while (used.has(path.toLowerCase())) {
        path = [...segments, `${name} ${counter}.md`].join('/');
        counter++;
      }
      used.add(path.toLowerCase());
      out.push({ path, id: page.id, title: page.title });
    }
    return out;
  }

  /** The file content for a page: frontmatter, then Markdown. */
  render(pageId: string): string {
    const page = this.repo.getPage(pageId);
    if (!page) return '';
    const doc = this.repo.loadPage(pageId);
    let properties: Record<string, string> = {};
    try {
      const parsed = JSON.parse(page.properties_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        properties = parsed as Record<string, string>;
      }
    } catch {
      // A page whose properties will not parse still exports; it just has
      // none in the file.
    }
    const tags = properties.tags ? String(properties.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
    const data: Frontmatter = {
      id: page.id,
      title: page.title,
      created: new Date(page.created_at).toISOString(),
      updated: new Date(page.updated_at).toISOString(),
    };
    if (page.icon) data.icon = page.icon;
    if (tags.length > 0) data.tags = tags;
    const rest = { ...properties };
    delete rest.tags;
    if (Object.keys(rest).length > 0) data.properties = rest;
    return `${renderFrontmatter(data)}${docToMarkdown(doc)}`;
  }

  /**
   * Write every page to disk.
   *
   * Returns the pages written and the ones that were already correct, so the
   * caller can say "12 updated, 140 unchanged" rather than "done".
   */
  materialise(): { written: string[]; unchanged: string[] } {
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const file of this.plan()) {
      const text = this.render(file.id);
      const absolute = join(this.root, ...file.path.split('/'));
      const hash = contentHash(text);
      let current = '';
      try {
        current = readFileSync(absolute, 'utf8');
      } catch {
        current = '';
      }
      if (current === text) {
        unchanged.push(file.path);
        continue;
      }
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, 'utf8');
      this.repo.setPageFile(file.id, file.path, hash);
      written.push(file.path);
    }
    return { written, unchanged };
  }

  /** The Markdown files on disk that belong to no page. */
  unknownFiles(): string[] {
    const known = new Set(this.plan().map((f) => f.path.toLowerCase()));
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const absolute = join(dir, entry);
        let isDir = false;
        try {
          isDir = statSync(absolute).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          walk(absolute, `${prefix}${entry}/`);
          continue;
        }
        if (!entry.endsWith('.md')) continue;
        const relative = `${prefix}${entry}`;
        if (!known.has(relative.toLowerCase())) out.push(relative);
      }
    };
    walk(this.root, '');
    return out;
  }

  /**
   * Read the pages whose files changed outside the app and bring them in.
   *
   * A file the app wrote and did not touch is left alone. A file that is
   * gone is not treated as a deletion: the page stays, because the sync tool
   * may simply not have delivered it yet.
   */
  importChanged(): { imported: string[]; unchanged: string[]; skipped: string[] } {
    const imported: string[] = [];
    const unchanged: string[] = [];
    const skipped: string[] = [];

    for (const file of this.plan()) {
      const absolute = join(this.root, ...file.path.split('/'));
      let text: string;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        skipped.push(file.path);
        continue;
      }
      const hash = contentHash(text);
      const stored = this.repo.getPageFileHash(file.id);
      if (stored === hash) {
        unchanged.push(file.path);
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const doc = markdownToDoc(body);
      // The importer is pure and does not know which pages exist, so a wiki
      // link comes out of it as text. This is the layer that can look a page
      // up, so this is where the link is made.
      this.resolveWikiLinks(doc);
      this.repo.savePage(file.id, doc);
      // The title lives in the frontmatter, and it is the one field the body
      // cannot carry.
      const title = typeof data.title === 'string' ? data.title : file.title;
      if (title !== file.title) this.repo.renamePage(file.id, title);
      this.repo.setPageFile(file.id, file.path, hash);
      imported.push(file.path);
    }
    return { imported, unchanged, skipped };
  }

  /**
   * Turn the wiki syntax in a document into links to pages.
   *
   * A title that matches no page is left as text. A link that goes nowhere is
   * worse than text.
   */
  private resolveWikiLinks(doc: Doc): void {
    for (const block of Object.values(doc.blocks)) {
      const runs = block.content.runs;
      if (!runs || runs.length === 0) continue;
      block.content = {
        runs: resolveWikiLinks(runs, (title) => this.repo.findPageByTitle(title)?.id),
      };
    }
  }

  /** What the settings panel shows. */
  status(): MirrorStatus {
    const plan = this.plan();
    const changed: string[] = [];
    const missing: string[] = [];
    for (const file of plan) {
      const absolute = join(this.root, ...file.path.split('/'));
      let text = '';
      let exists = true;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        exists = false;
      }
      if (!exists) {
        missing.push(file.path);
        continue;
      }
      const stored = this.repo.getPageFileHash(file.id);
      if (stored !== contentHash(text)) changed.push(file.path);
    }
    return {
      root: this.root,
      files: plan.length,
      changed,
      missing,
      unknown: this.unknownFiles(),
    };
  }

  /** Delete a page's file. Used when a page is deleted for good. */
  remove(pageId: string): void {
    const path = this.repo.getPageFilePath(pageId);
    if (!path) return;
    try {
      unlinkSync(join(this.root, ...path.split('/')));
    } catch {
      // A file that is already gone is the outcome we wanted.
    }
  }
}
