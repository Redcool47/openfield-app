/**
 * `ow` -- the agent interface.
 *
 * Every subcommand here is a thin wrapper over the command registry. Nothing in
 * the CLI reaches into the model or the repository directly, which is the point:
 * if the CLI can do something, an automated agent or the UI can do the same
 * thing through the same code path, so there is no capability that exists only
 * in the test harness.
 *
 * Two output modes, always available:
 *   --json    machine-readable, one JSON document on stdout
 *   (default) human-readable text
 *
 * Scripts and agents should use `--json`; humans should not.
 */

import { Repository } from '@ow/storage';
import { resolveWikiLinks, textOf, type Doc } from '@ow/model';
import {
  Session,
  createRegistry,
  runBatch,
  runCommand,
  type BatchStep,
} from '@ow/commands';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

interface Args {
  _: string[];
  /** Single-valued flags. Repeated flags keep the last value. */
  flags: Map<string, string | boolean>;
  /** Flags that accumulate, so `--cmd a --cmd b` yields both. */
  multi: Map<string, string[]>;
}

/**
 * Flags whose repeated occurrences must all be kept, not overwritten.
 *
 * The roots are repeatable because a single allowed directory is rarely the whole
 * story, and listing two of them has to work -- an allowlist that silently keeps
 * only the last entry is worse than one that does not exist, because it looks
 * like it is working.
 */
const REPEATABLE = new Set(['cmd', 'script', 'read-root', 'write-root']);

/** Flags that accept a single-dash short form, e.g. `-w dir`. */
const SHORT = new Map<string, string>([['w', 'workspace'], ['h', 'help']]);

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  const multi = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    // Short form: -w value, or -w=value. Only the documented letters are
    // treated as options; anything else starting with a single dash is a
    // positional, so a path or a command id containing "-" still works.
    if (/^-[A-Za-z]$/.test(token)) {
      const letter = token.slice(1);
      const key = SHORT.get(letter);
      if (key) {
        const eq = token.indexOf('=');
        if (eq >= 0) {
          flags.set(key, token.slice(eq + 1));
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('-')) {
            flags.set(key, next);
            i += 1;
          } else {
            flags.set(key, true);
          }
        }
        continue;
      }
    }

    if (!token.startsWith('--')) {
      _.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    let key: string;
    let value: string | boolean;
    if (eq >= 0) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    if (REPEATABLE.has(key)) {
      const list = multi.get(key) ?? [];
      if (typeof value === 'string') list.push(value);
      multi.set(key, list);
      continue;
    }
    flags.set(key, value);
  }
  return { _, flags, multi };
}

/**
 * Read a flag that must carry a string.
 *
 * A bare `--page` with nothing after it parses as boolean `true`. Passing that
 * straight through to a query produces "cannot bind parameter" from SQLite, a
 * message that says nothing about the actual mistake. Reporting it here names
 * the flag instead.
 */
function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

const HELP = `ow -- the command line for Openfield

Usage:
  ow init <dir> [--name <name>]     Create a workspace
  ow list-commands [--json]          List every registered command
  ow commands --filter <text>        Search commands by name
  ow run --workspace <dir> --cmd '<id>{"arg":1}' [--cmd ...] [--open <id>]
  ow inspect --workspace <dir> [--page <id>]
  ow search --workspace <dir> <query>
  ow pages --workspace <dir> [--trash|--favorites]
  ow check --workspace <dir>         Storage integrity self-test
  ow stats --workspace <dir>
  ow keys [--platform win|mac]        Print the keyboard map
  ow export --workspace <dir> [--page <id>] [--format json|md|tree]
  ow help

Confinement (recommended when an agent drives this):
  --read-root DIR      refuse to read any workspace outside DIR (repeatable)
  --write-root DIR     refuse to write any workspace outside DIR (repeatable)
  A --write-root implies --read-root for the same directory.

Global flags:
  --json     emit JSON instead of text
  --workspace, -w   workspace directory (default: ./.workspace)

Confinement, recommended whenever an agent drives this:
  --read-root DIR    refuse to read any workspace outside DIR (repeatable)
  --write-root DIR   refuse to write any workspace outside DIR (repeatable)

With no roots the CLI is unrestricted, which is right for a person running it by
hand and wrong for an automation. A --write-root implies --read-root for the
same directory, since refusing to read a directory you were told to write to is
never what anyone meant.

A --cmd argument is a command id optionally followed by a JSON object of
arguments. Example:
  ow run -w ./.workspace --cmd 'page.create{"title":"Notes"}'
`;

/**
 * Directories this process is allowed to touch, when the caller confined it.
 *
 * Empty means unrestricted, which is the default so that a human running `ow` by
 * hand is not suddenly refused. An agent driving it should pass the roots
 * explicitly.
 */
let readRoots: string[] = [];
let writeRoots: string[] = [];

/**
 * Confine the process to specific directories.
 *
 * An agent handed this CLI can otherwise open any workspace on the machine:
 * `--workspace C:\Users\someone\Documents` works, and so does anything it can
 * guess. Naming the roots turns "run this command" into "run this command inside
 * the directory I meant", which is the difference between a useful automation
 * and one that has to be trusted wholesale.
 *
 * Roots are compared after resolution, so `..` cannot be used to climb out. The
 * one thing this does not defend against is a symlink inside an allowed root
 * pointing elsewhere; that needs realpath on both sides and is not done yet.
 */
function setRoots(args: Args): void {
  readRoots = (args.multi.get('read-root') ?? []).map((r) => resolve(process.cwd(), r));
  writeRoots = (args.multi.get('write-root') ?? []).map((r) => resolve(process.cwd(), r));
  if (writeRoots.length > 0 && readRoots.length === 0) {
    // A write root with no read root would refuse to read the very directory it
    // was told to write to, which is never what anyone means.
    readRoots = [...writeRoots];
  }
  if (readRoots.length > 0 && writeRoots.length === 0) {
    // And the other way round. Given only --read-root, the intent is plainly
    // "this process lives here", and treating it as read-only would confine
    // nothing at all: every command in this CLI writes, so a read-only root
    // would constrain the reads and leave every write unchecked. The help says
    // --read-root refuses to read outside DIR; it does not promise that writes
    // are still permitted elsewhere, and they should not be.
    writeRoots = [...readRoots];
  }
}

/** True when `target` is `root` itself or somewhere beneath it. */
function within(target: string, root: string): boolean {
  const rel = relative(root, target);
  // `relative` returns something starting with ".." when target is outside, and
  // "" when they are the same path. Checking the separator as well stops
  // "/allowed-evil" from passing a prefix test against "/allowed".
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Refuse a path that is outside the roots this process was given. */
function confine(dir: string, writing: boolean): string {
  const allowed = writing ? writeRoots : readRoots;
  if (allowed.length === 0) return dir;
  if (allowed.some((root) => within(dir, root))) return dir;
  const verb = writing ? 'write' : 'read';
  throw new Error(
    `refusing to ${verb} ${dir}: outside the ${verb} roots [${allowed.join(', ')}]. ` +
      'Pass --read-root / --write-root to widen the area this process may touch.',
  );
}

function workspacePath(args: Args, positionalIndex = 1): string {
  const fromFlag = stringFlag(args.flags, 'workspace') ?? stringFlag(args.flags, 'w');
  const raw = fromFlag ?? args._[positionalIndex] ?? './.workspace';
  return confine(resolve(process.cwd(), raw), true);
}

function databaseFile(dir: string): string {
  return join(dir, 'openfield.sqlite');
}

async function openSession(dir: string, autosaveMs = 0): Promise<Session> {
  mkdirSync(dirname(databaseFile(dir)), { recursive: true });
  const repo = await Repository.open(databaseFile(dir));
  repo.ensureWorkspace('default', 'Workspace');
  return new Session(repo, { autosaveMs });
}

function out(value: unknown, json: boolean, text: () => string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    const rendered = text();
    if (rendered.length) process.stdout.write(`${rendered}\n`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  setRoots(args);
  const json = args.flags.get('json') === true;
  const command = args._[0];

  if (!command || command === 'help' || args.flags.get('help') === true) {
    process.stdout.write(HELP);
    return 0;
  }

  const registry = createRegistry();

  switch (command) {
    case 'init': {
      const dir = workspacePath(args);
      const name = stringFlag(args.flags, 'name') ?? 'My workspace';
      mkdirSync(dir, { recursive: true });
      const session = await openSession(dir);
      session.repo.ensureWorkspace('default', name);
      const check = session.repo.selfTest();
      const first = session.createPage({ title: 'Getting started' });
      session.openPage(first);
      session.edit('seed', (tx) => {
        tx.touch(session.doc.roots[0]!);
        const root = session.doc.roots[0]!;
        session.doc.blocks[root]!.content = { runs: [{ text: 'Getting started' }] };
      });
      session.flush();
      session.dispose();
      session.repo.close();
      out({ workspace: dir, name, page: first, check }, json, () => `created workspace at ${dir}`);
      return 0;
    }

    case 'list-commands': {
      const commands = registry.all().map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        description: c.description ?? '',
        keys: c.keys?.win ?? '',
        undoable: c.undoable === true,
        args: Object.keys(c.args ?? {}),
      }));
      out(commands, json, () =>
        commands
          .map((c) => `${c.id.padEnd(30)} ${c.keys ? `[${c.keys}]`.padEnd(16) : ' '.repeat(16)} ${c.title}`)
          .join('\n'),
      );
      return 0;
    }

    case 'commands': {
      const filter = stringFlag(args.flags, 'filter') ?? args._[1] ?? '';
      const found = registry.search(filter, 50);
      out(
        found.map((c) => ({ id: c.id, title: c.title, keys: c.keys?.win ?? '' })),
        json,
        () => found.map((c) => `${c.id.padEnd(30)} ${c.title}`).join('\n'),
      );
      return 0;
    }

    case 'keys': {
      const platform = (stringFlag(args.flags, 'platform') ?? 'win') === 'mac' ? 'mac' : 'win';
      const keys = registry.keybindings(platform);
      const conflicts = registry.keyConflicts();
      out({ keys, conflicts }, json, () =>
        [
          ...keys.map((k) => `${k.key.padEnd(20)} ${k.id}`),
          '',
          conflicts.length ? `CONFLICTS:\n${conflicts.map((c) => `  ${c.key}: ${c.ids.join(', ')}`).join('\n')}` : 'no key conflicts',
        ].join('\n'),
      );
      return 0;
    }

    case 'run': {
      const dir = workspacePath(args);
      // Commands may arrive as repeated --cmd flags or as a JSON script file.
      // The script form exists because Windows shells mangle embedded quotes in
      // argv, which turns `--cmd 'page.create{"title":"a b"}'` into invalid JSON
      // before the CLI ever sees it. A file sidesteps that entirely and is also
      // the natural thing for an agent to generate.
      const steps: BatchStep[] = [];
      for (const raw of args.multi.get('cmd') ?? []) steps.push(parseStep(raw));
      for (const file of args.multi.get('script') ?? []) steps.push(...loadScript(file));
      if (!steps.length) {
        process.stderr.write('ow run: at least one --cmd or --script is required\n');
        return 2;
      }
      const session = await openSession(dir);
      const openId = stringFlag(args.flags, 'open');
      if (openId) session.openPage(openId);
      const results = await runBatch(steps, { session, registry });
      session.dispose();
      session.repo.close();
      const failed = results.some((r) => !r.ok);
      out({ results }, json, () =>
        results
          .map((r) => (r.ok ? `ok   ${r.id}${r.value === undefined ? '' : ` -> ${formatValue(r.value)}`}` : `FAIL ${r.id}: ${r.error}`))
          .join('\n'),
      );
      return failed ? 1 : 0;
    }

    case 'inspect': {
      const dir = workspacePath(args);
      const session = await openSession(dir);
      const pageId = stringFlag(args.flags, 'page') ?? session.repo.allPages()[0]?.id;
      if (!pageId) {
        process.stderr.write('ow inspect: workspace has no pages\n');
        return 1;
      }
      const page = session.openPage(pageId);
      const snap = session.inspect();
      session.repo.close();
      out({ page, tree: snap.tree, blocks: snap.blocks }, json, () => snap.tree.join('\n'));
      return 0;
    }

    case 'search': {
      const dir = workspacePath(args);
      const query = args._[1] ?? stringFlag(args.flags, 'query') ?? '';
      const session = await openSession(dir);
      const hits = session.repo.search(query, 25);
      session.repo.close();
      out(hits, json, () =>
        hits.map((h) => `${h.title || '(untitled)'}\n  ${h.snippet.replace(/\s+/g, ' ').trim()}`).join('\n\n'),
      );
      return 0;
    }

    case 'pages': {
      const dir = workspacePath(args);
      const session = await openSession(dir);
      const which = args.flags.get('trash')
        ? session.repo.trashedPages()
        : args.flags.get('favorites')
          ? session.repo.favoritePages()
          : session.repo.allPages();
      session.repo.close();
      out(which, json, () =>
        which.map((p) => `${p.id}  ${p.title || '(untitled)'}`).join('\n'),
      );
      return 0;
    }

    case 'check': {
      const dir = workspacePath(args);
      const session = await openSession(dir);
      const result = session.repo.selfTest();
      session.repo.close();
      out(result, json, () =>
        [
          result.ok ? 'integrity check passed' : 'PROBLEMS FOUND',
          ...result.repaired.map((r) => `repaired: ${r}`),
          ...result.problems.map((p) => `problem: ${p}`),
        ].join('\n'),
      );
      return result.ok ? 0 : 1;
    }

    case 'stats': {
      const dir = workspacePath(args);
      const session = await openSession(dir);
      const stats = session.repo.stats();
      session.repo.close();
      out(stats, json, () =>
        Object.entries(stats).map(([k, v]) => `${k.padEnd(12)} ${v}`).join('\n'),
      );
      return 0;
    }

    case 'export': {
      const dir = workspacePath(args);
      const format = stringFlag(args.flags, 'format') ?? 'tree';
      const session = await openSession(dir);
      const pageId = stringFlag(args.flags, 'page') ?? session.repo.allPages()[0]?.id;
      if (!pageId) {
        process.stderr.write('ow export: nothing to export\n');
        return 1;
      }
      session.openPage(pageId);
      const snap = session.inspect();
      const payload: Record<string, unknown> =
        format === 'json'
          ? { page: snap.id, title: snap.title, doc: session.doc }
          : format === 'md'
            ? { page: snap.id, title: snap.title, markdown: toMarkdown(session.doc, snap.title) }
            : { page: snap.id, title: snap.title, tree: snap.tree };
      session.dispose();
      session.repo.close();
      out(payload, json, () =>
        format === 'json' ? JSON.stringify(payload, null, 2) : format === 'md' ? (payload.markdown as string) : snap.tree.join('\n'),
      );
      return 0;
    }

    default: {
      process.stderr.write(`ow: unknown command "${command}"\n\n${HELP}`);
      return 2;
    }
  }
}

/**
 * Parse `page.create{"title":"Notes"}` into a step.
 *
 * The brace is found by scanning for the first `{` after the id, so a command
 * id containing no braces works and a JSON payload may contain anything.
 */
function parseStep(raw: string): BatchStep {
  const brace = raw.indexOf('{');
  if (brace < 0) return { id: raw.trim(), args: {} };
  const id = raw.slice(0, brace).trim();
  const json = raw.slice(brace);
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(json) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`could not parse arguments for "${id}": ${String(error)}`);
  }
  return { id, args };
}

/**
 * Load a batch of commands from a JSON file.
 *
 * Accepts either an array of `{ id, args }` objects or an array of the compact
 * `"id{json}"` strings, so a script can be written either way.
 *
 * A leading byte-order mark is stripped before parsing. PowerShell writes one by
 * default -- `Set-Content ... -Encoding UTF8` on Windows PowerShell 5.1 emits
 * U+FEFF -- and `JSON.parse` rejects it with "Unexpected token", so every script
 * written from the most obvious shell command on the platform fails. Since this
 * file is the interface an agent is expected to drive, a file the platform's own
 * tooling produces has to be accepted.
 */
function loadScript(file: string): BatchStep[] {
  const raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`could not parse script ${file}: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`script ${file} must contain a JSON array`);
  }
  return parsed.map((entry) => {
    if (typeof entry === 'string') return parseStep(entry);
    const obj = entry as { id?: unknown; args?: unknown };
    if (typeof obj.id !== 'string') {
      throw new Error(`script ${file} has an entry without a string "id"`);
    }
    return { id: obj.id, args: (obj.args as Record<string, unknown>) ?? {} };
  });
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.tree === 'object') return `${(v.tree as string[]).length} line(s)`;
    return Object.keys(v).slice(0, 3).join(', ') || 'ok';
  }
  return String(value);
}

/**
 * This walks the real block tree and switches on the block type. An earlier
 * version derived Markdown from the indented `tree` dump and emitted every
 * top-level block as an `#` heading, because in that dump depth carries nesting
 * but not type. Exporting structure an exporter cannot see is worse than not
 * exporting it, so the exporter reads the model directly.
 *
 * A fuller implementation with round-trip guarantees belongs in `@ow/formats`;
 * this one exists so the CLI's Markdown output is truthful today.
 */
function toMarkdown(doc: Doc, title: string): string {
  const out: string[] = [];
  if (title) out.push(`# ${title}`, '');

  const render = (ids: string[], depth: number) => {
    // Track the run of siblings of the same type so consecutive bullets become
    // one list rather than a series of one-item lists.
    let runType = '';
    let counter = 0;
    const flushRun = () => {
      if (runType === 'numberedListItem') counter = 0;
      runType = '';
    };

    for (const id of ids) {
      const block = doc.blocks[id];
      if (!block) continue;
      const text = textOf(block.content);
      const indent = '  '.repeat(depth);

      if (block.type !== runType) {
        flushRun();
        runType = block.type;
      }

      switch (block.type) {
        case 'heading1':
          out.push(`${indent}# ${text}`, '');
          break;
        case 'heading2':
          out.push(`${indent}## ${text}`, '');
          break;
        case 'heading3':
          out.push(`${indent}### ${text}`, '');
          break;
        case 'bulletedListItem':
          out.push(`${indent}- ${text}`);
          break;
        case 'numberedListItem':
          counter += 1;
          out.push(`${indent}${counter}. ${text}`);
          break;
        case 'todo':
          out.push(`${indent}- [${block.props.checked ? 'x' : ' '}] ${text}`);
          break;
        case 'toggle':
          out.push(`${indent}- ${text}`);
          break;
        case 'quote':
          out.push(`${indent}> ${text}`, '');
          break;
        case 'callout':
          out.push(`${indent}> ${block.props.calloutIcon ?? '💡'} ${text}`, '');
          break;
        case 'code':
          out.push(`${indent}\`\`\`${block.props.language ?? ''}`, text, `${indent}\`\`\``, '');
          break;
        case 'divider':
          out.push(`${indent}---`, '');
          break;
        case 'equation':
          out.push(`${indent}$${text}$$`, '');
          break;
        default:
          if (text) out.push(`${indent}${text}`);
          break;
      }

      if (block.children.length) render(block.children, depth + 1);
    }
    flushRun();
  };

  render(doc.roots, 0);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// This module exports `main` and does not self-invoke. The executable entry
// point is `bin/ow.mjs`, which imports `main` and sets the exit code. An earlier
// version also self-invoked here when `process.argv[1]` looked like this file,
// which meant the bin entry ran the whole command list twice.

export { runCommand };