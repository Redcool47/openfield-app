/**
 * Commands for the AI settings and for asking a provider something.
 *
 * The rules the rest of the app relies on:
 *
 * - The feature is off until the user turns it on. There is no implicit AI.
 * - The key is stored in the workspace database and is never sent anywhere
 *   except the provider the user chose.
 * - The key is never handed back to the renderer. The settings panel gets a
 *   hint and a flag, not the key, so it cannot be shown, logged or copied by
 *   accident.
 */

import type { Command, CommandContext } from './registry.js';
import { AI_PROVIDERS, DEFAULT_AI_CONFIG, complete, configForView, findProvider } from './ai.js';
import type { AiConfig, AiMessage } from './ai.js';

interface Ctx {
  session: {
    repo: {
      getSetting<T>(key: string, fallback: T): T;
      setSetting(key: string, value: unknown): void;
    };
    pageId: string | null;
    doc: { roots: string[]; blocks: Record<string, { content: unknown }> };
  };
}

/**
 * The session, as these commands need it.
 *
 * The commands layer is the only place that knows the session's shape, so
 * this is the one place that reaches into it.
 */
function ctxOf(ctx: CommandContext): { session: Ctx['session'] } {
  return ctx as unknown as { session: Ctx['session'] };
}

const SETTING_KEY = 'ai';

function readConfig(ctx: CommandContext): AiConfig {
  const stored = ctxOf(ctx).session.repo.getSetting<Partial<AiConfig>>(SETTING_KEY, {});
  return {
    enabled: stored.enabled === true,
    provider: typeof stored.provider === 'string' ? stored.provider : DEFAULT_AI_CONFIG.provider,
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    model: typeof stored.model === 'string' ? stored.model : '',
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
  };
}

function writeConfig(ctx: CommandContext, config: AiConfig): void {
  ctxOf(ctx).session.repo.setSetting(SETTING_KEY, config);
}

/** The page's plain text, so a prompt can be about the open page. */
function pageText(ctx: CommandContext): string {
  const session = ctxOf(ctx).session;
  const parts: string[] = [];
  for (const id of session.doc.roots) {
    const block = session.doc.blocks[id];
    if (!block) continue;
    const content = block.content as { runs?: { text?: string }[] } | undefined;
    parts.push((content?.runs ?? []).map((r) => r.text ?? '').join(''));
  }
  return parts.join('\n').trim();
}

export const AI_COMMANDS: Command[] = [
  {
    id: 'settings.ai.get',
    title: 'Show the AI settings',
    category: 'App',
    description: 'The provider, model and whether AI is turned on. The key is never returned.',
    run: (ctx) => {
      const config = readConfig(ctx);
      return {
        ...configForView(config),
        providers: AI_PROVIDERS.map((p) => ({
          id: p.id,
          label: p.label,
          defaultModel: p.defaultModel,
          models: p.models,
          needsKey: p.needsKey,
          keyLabel: p.keyLabel,
          note: p.note,
        })),
      };
    },
  },
  {
    id: 'settings.ai.set',
    title: 'Change the AI settings',
    category: 'App',
    args: {
      enabled: { type: 'boolean' },
      provider: { type: 'string' },
      model: { type: 'string' },
      baseUrl: { type: 'string' },
      apiKey: { type: 'string', description: 'Replaces the stored key. Omit to leave it alone.' },
    },
    run: (ctx) => {
      const config = readConfig(ctx);
      if (typeof ctx.args.enabled === 'boolean') config.enabled = ctx.args.enabled;
      if (typeof ctx.args.provider === 'string') {
        const provider = findProvider(ctx.args.provider);
        if (!provider) ctx.fail(`unknown AI provider: ${ctx.args.provider}`);
        config.provider = ctx.args.provider;
        // A new provider brings its own default model unless one was chosen.
        if (!config.model) config.model = provider?.defaultModel ?? '';
      }
      if (typeof ctx.args.model === 'string') config.model = ctx.args.model;
      if (typeof ctx.args.baseUrl === 'string') config.baseUrl = ctx.args.baseUrl;
      if (typeof ctx.args.apiKey === 'string' && ctx.args.apiKey.length > 0) {
        config.apiKey = ctx.args.apiKey.trim();
      }
      writeConfig(ctx, config);
      return configForView(config);
    },
  },
  {
    id: 'settings.ai.test',
    title: 'Check the AI connection',
    category: 'App',
    description: 'Send a one-word request so the user finds out before they need it.',
    run: async (ctx) => {
      const config = readConfig(ctx);
      if (!config.enabled) ctx.fail('AI is turned off');
      const provider = findProvider(config.provider);
      const model = config.model || provider?.defaultModel || '';
      try {
        const result = await complete({
          provider: config.provider,
          apiKey: config.apiKey,
          model,
          baseUrl: config.baseUrl,
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          timeoutMs: 20_000,
        });
        return { ok: true, provider: config.provider, model: result.model, reply: result.text.trim().slice(0, 80) };
      } catch (error) {
        // The message is shown to the user as-is: a wrong key, a wrong model and
        // a blocked network all look the same otherwise.
        return { ok: false, provider: config.provider, error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  {
    id: 'ai.complete',
    title: 'Ask the AI provider',
    category: 'App',
    description:
      'Send a prompt to the provider the user configured. Off by default, and it does nothing until AI is turned on.',
    args: {
      prompt: { type: 'string', required: true },
      system: { type: 'string' },
      includePage: { type: 'boolean', description: 'Send the open page as context.' },
    },
    run: async (ctx) => {
      const config = readConfig(ctx);
      if (!config.enabled) ctx.fail('AI is turned off. Turn it on in Settings, Advanced, AI.');
      const prompt = (ctx.args.prompt as string) ?? '';
      if (!prompt.trim()) ctx.fail('ai.complete: the prompt is empty');
      const messages: AiMessage[] = [];
      const system = ctx.args.system as string | undefined;
      if (system && system.trim()) messages.push({ role: 'system', content: system });
      if (ctx.args.includePage === true) {
        const text = pageText(ctx);
        if (text.length > 0) {
          messages.push({ role: 'user', content: `The open page:\n\n${text}\n\n---\n\n${prompt}` });
        } else {
          messages.push({ role: 'user', content: prompt });
        }
      } else {
        messages.push({ role: 'user', content: prompt });
      }
      const provider = findProvider(config.provider);
      const result = await complete({
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model || provider?.defaultModel || '',
        baseUrl: config.baseUrl,
        messages,
      });
      return { text: result.text, model: result.model, provider: config.provider };
    },
  },
];
