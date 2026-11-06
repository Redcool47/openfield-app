import { Registry, CommandError, resolveArgs, type Command, type CommandContext } from './registry.js';
import type { Session } from './session.js';
import { builtinCommands } from './builtin.js';

export * from './registry.js';
export * from './session.js';
export * from './builtin.js';
export * from './shortcuts.js';

export interface RunOptions {
  /** Resolve ids through this before running. */
  session: Session;
  registry: Registry;
  /** Convert a thrown error into a rejected result instead of throwing. */
  soft?: boolean;
}

export interface RunResult {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Execute one command by id.
 *
 * Arguments are validated against the command's declared spec before `run` is
 * called, so a malformed `page.create={"parentage": 1}` fails with a message
 * naming the argument rather than silently doing nothing.
 */
export async function runCommand(
  id: string,
  args: Record<string, unknown>,
  options: RunOptions,
): Promise<RunResult> {
  try {
    // Resolution is inside the try so an unknown id becomes a soft failure
    // rather than an escaped throw. A caller that asked for `soft` expects a
    // result object either way, and a batch containing one bad id should report
    // which step failed rather than abandoning the rest at the call site.
    const command = options.registry.get(id);
    const resolved = resolveArgs(command, args ?? {});
    const ctx: CommandContext = {
      session: options.session,
      args: resolved,
      fail(message: string): never {
        throw new CommandError(id, message);
      },
      pageId(): string {
        const pageId = options.session.pageId;
        if (!pageId) throw new CommandError(id, 'no page is open');
        return pageId;
      },
    };
    const value = await command.run(ctx);
    options.session.flush();
    // Append to the sync log after the mutation has been flushed, so the log
    // never claims a change the database does not have.
    //
    // Only undoable commands. `page.open` and `history.undo` are not edits to
    // the document -- logging them would mean a future replay re-applied a
    // navigation, or re-applied an undo as though it were a change of mind.
    if (command.undoable && options.session.repo && options.session.pageId) {
      options.session.repo.appendOp(options.session.pageId, { command: id, args: resolved });
    }
    return { id, ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.soft) return { id, ok: false, error: message };
    throw error;
  }
}

export interface BatchStep {
  id: string;
  args?: Record<string, unknown>;
}

/**
 * Execute a sequence of commands as one logical unit.
 *
 * On failure the batch stops and reports which step failed and why, rather than
 * continuing and leaving the document half-changed. Callers that want
 * best-effort behaviour should use `continueOnError`.
 */
export async function runBatch(
  steps: readonly BatchStep[],
  options: RunOptions & { continueOnError?: boolean },
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const step of steps) {
    const result = await runCommand(step.id, step.args ?? {}, { ...options, soft: true });
    results.push(result);
    if (!result.ok && !options.continueOnError) break;
  }
  return results;
}

/** Build a registry populated with the built-in commands. */
export function createRegistry(extra: readonly Command[] = []): Registry {
  const registry = new Registry();
  registry.registerAll(builtinCommands());
  registry.registerAll(extra);
  return registry;
}export * from './database-commands.js';
export * from './ai.js';
export * from './ai-commands.js';
export * from './view-query.js';
