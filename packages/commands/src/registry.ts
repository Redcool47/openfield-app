/**
 * The command registry.
 *
 * One id space drives every surface: the menus, the keyboard map, the slash
 * menu, quick find, the command palette, the CLI, the JSON control channel and
 * the MCP server. Nothing mutates the model except through `run`.
 *
 * Why this shape earns its cost
 * -----------------------------
 * Three things follow from "everything is a command", and each is worth the
 * indirection on its own:
 *
 *  - **The app is testable without a UI.** A scenario is a list of command ids
 *    plus assertions on `inspect_page`. That is far cheaper and far less flaky
 *    than driving a browser, and it is how an automated agent verifies work.
 *  - **The keyboard map cannot drift from the menus.** Both are generated from
 *    the same entries, so a shortcut for a command that no longer exists is a
 *    startup error rather than a dead key press discovered by a user.
 *  - **Undo becomes tractable.** Every command declares whether it is undoable,
 *    and every undoable command runs inside a transaction, so undo is a single
 *    mechanism instead of per-feature work.
 *
 * Identifiers are dot-separated lowerCamelCase with the area first
 * (`block.turnInto.heading1`), which sorts usefully and groups naturally in a
 * generated catalogue.
 */

export interface CommandContext {
  /** The active session: repository, open page, selection, history. */
  readonly session: unknown;
  readonly args: Record<string, unknown>;
  /** Abort the command; the message is shown to the user verbatim. */
  fail(message: string): never;
  /** Resolved absolute page id, or a clear failure. */
  pageId(name: string): string;
}

export interface Command<A = Record<string, unknown>> {
  readonly id: string;
  /** Short human title, shown in menus and search. */
  readonly title: string;
  /** Grouping for menus and the palette: Page, Block, Text, View, App. */
  readonly category: string;
  /** One-line description used by help output and the palette. */
  readonly description?: string;
  /** Alternate words the palette and slash menu should match. */
  readonly searchTerms?: readonly string[];
  /** Default keybinding, platform-specific. */
  readonly keys?: Partial<Record<'win' | 'mac', string>>;
  /** Whether this command participates in undo. */
  readonly undoable?: boolean;
  /** Whether the command needs a page to be open. */
  readonly needsPage?: boolean;
  /** JSON-schema-ish description of the arguments, printed by `list-commands`. */
  readonly args?: Readonly<Record<string, ArgSpec>>;
  /** Menu path, e.g. `Page > Move to trash`. */
  readonly menuPath?: string;
  readonly run: (ctx: CommandContext) => unknown | Promise<unknown>;
}

export interface ArgSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
  required?: boolean;
  description?: string;
  /** One of these values. */
  enum?: readonly string[];
  default?: unknown;
}

export type CommandMap = ReadonlyMap<string, Command>;

export class CommandError extends Error {
  readonly commandId: string;
  constructor(commandId: string, message: string) {
    super(`${commandId}: ${message}`);
    this.name = 'CommandError';
    this.commandId = commandId;
  }
}

export class Registry {
  private readonly commands = new Map<string, Command>();
  /**
   * Key chords indexed per platform: `"win:ctrl+d"` rather than `"ctrl+d"`.
   *
   * Platform matters because several commands deliberately bind the same chord
   * on both platforms (`Tab` indents on Windows and macOS alike). A single
   * combined table reported every one of those as a key conflict, which made
   * the conflict check useless: it was permanently red and everyone stopped
   * reading it.
   */
  private readonly keyIndex = new Map<string, string[]>();

  constructor(commands: readonly Command[] = []) {
    for (const c of commands) this.register(c);
  }

  register(command: Command): this {
    if (this.commands.has(command.id)) {
      throw new Error(`duplicate command id: ${command.id}`);
    }
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(command.id)) {
      throw new Error(
        `command id must be dot-separated lowerCamelCase, got: ${command.id}`,
      );
    }
    this.commands.set(command.id, command);
    for (const platform of ['win', 'mac'] as const) {
      const key = command.keys?.[platform];
      if (!key) continue;
      const indexKey = `${platform}:${normaliseKey(key)}`;
      const list = this.keyIndex.get(indexKey) ?? [];
      list.push(command.id);
      this.keyIndex.set(indexKey, list);
    }
    return this;
  }

  registerAll(commands: readonly Command[]): this {
    for (const c of commands) this.register(c);
    return this;
  }

  get(id: string): Command {
    const command = this.commands.get(id);
    if (!command) throw new CommandError(id, 'no such command');
    return command;
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get size(): number {
    return this.commands.size;
  }

  all(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  byCategory(): Map<string, Command[]> {
    const out = new Map<string, Command[]>();
    for (const command of this.all()) {
      const list = out.get(command.category) ?? [];
      list.push(command);
      out.set(command.category, list);
    }
    return out;
  }

  /** Command ids bound to a chord on one platform. */
  commandsForKey(key: string, platform: 'win' | 'mac' = 'win'): string[] {
    return this.keyIndex.get(`${platform}:${normaliseKey(key)}`) ?? [];
  }

  /**
   * Keyboard conflicts on one platform.
   *
   * Reported rather than thrown: a future pair of commands may legitimately
   * share a chord, and the caller decides what to do about each one.
   */
  keyConflicts(platform: 'win' | 'mac' = 'win'): { key: string; ids: string[] }[] {
    const out: { key: string; ids: string[] }[] = [];
    for (const [indexKey, ids] of this.keyIndex) {
      if (!indexKey.startsWith(`${platform}:`)) continue;
      if (ids.length > 1) out.push({ key: indexKey.slice(platform.length + 1), ids });
    }
    return out;
  }

  /**
   * Fuzzy search over ids, titles, categories and search terms.
   *
   * Ranking, best first: exact id, id prefix, title prefix, title substring,
   * then a subsequence match, with shorter titles winning ties so that "new page"
   * beats "new page from template".
   */
  search(query: string, limit = 30): Command[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: { command: Command; score: number }[] = [];
    for (const command of this.commands.values()) {
      const score = scoreCommand(command, q);
      if (score > 0) scored.push({ command, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.command.title.length - b.command.title.length)
      .slice(0, limit)
      .map((s) => s.command);
  }

  /** Every distinct key chord, for the shortcuts cheat sheet. */
  keybindings(platform: 'win' | 'mac' = 'win'): { key: string; id: string; title: string }[] {
    const out: { key: string; id: string; title: string }[] = [];
    for (const command of this.all()) {
      const key = command.keys?.[platform];
      if (key) out.push({ key, id: command.id, title: command.title });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}

function scoreCommand(command: Command, q: string): number {
  const id = command.id.toLowerCase();
  const title = command.title.toLowerCase();
  if (id === q) return 1000;
  if (title === q) return 950;
  if (id.startsWith(q)) return 800;
  if (title.startsWith(q)) return 700;
  if (id.includes(q)) return 500;
  if (title.includes(q)) return 450;
  for (const term of command.searchTerms ?? []) {
    const t = term.toLowerCase();
    if (t === q) return 900;
    if (t.startsWith(q)) return 650;
    if (t.includes(q)) return 400;
  }
  // Subsequence match: every character of the query appears in order.
  let i = 0;
  for (const ch of title) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 200 - title.length * 0.01;
  }
  return 0;
}

/**
 * Normalise a key chord for lookup: upper-case the letter and keep modifier
 * order fixed, so "ctrl+shift+p" and "Ctrl+Shift+P" are one binding.
 */
export function normaliseKey(key: string): string {
  const parts = key
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  let base = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') mods.push('ctrl');
    else if (lower === 'shift') mods.push('shift');
    else if (lower === 'alt' || lower === 'option') mods.push('alt');
    else if (lower === 'meta' || lower === 'cmd' || lower === 'super') mods.push('meta');
    else base = lower;
  }
  mods.sort();
  return [...mods, base].join('+');
}

/** Arguments declared by a command, with defaults and required checks applied. */
export function resolveArgs(command: Command, provided: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...provided };
  for (const [key, spec] of Object.entries(command.args ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
    if (spec.required && out[key] === undefined) {
      throw new CommandError(command.id, `missing required argument "${key}"`);
    }
    if (out[key] !== undefined && spec.type !== 'any' && typeof out[key] !== spec.type) {
      // Arrays and objects need a looser check than typeof provides.
      const ok =
        (spec.type === 'array' && Array.isArray(out[key])) ||
        (spec.type === 'object' && typeof out[key] === 'object' && !Array.isArray(out[key]));
      if (!ok) {
        throw new CommandError(command.id, `argument "${key}" must be a ${spec.type}`);
      }
    }
    if (out[key] !== undefined && spec.enum && !spec.enum.includes(String(out[key]))) {
      throw new CommandError(
        command.id,
        `argument "${key}" must be one of: ${spec.enum.join(', ')}`,
      );
    }
  }
  return out;
}