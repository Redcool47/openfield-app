/**
 * Talking to an AI provider, on the user's terms.
 *
 * Nothing here runs unless the user has turned it on and pasted in their own
 * key. There is no default provider, no default key, and no telemetry: the
 * request goes to the one host the user chose, with the one key they typed,
 * and nowhere else.
 *
 * Three request shapes cover the providers people actually use. Most of them
 * -- OpenRouter, OpenAI, Groq, DeepSeek, Ollama, and anything else that grew
 * out of the same idea -- speak the OpenAI chat-completions format.
 * Anthropic and Google each have their own, and each gets its own builder
 * and its own parser rather than being bent into the other shape.
 */

export interface AiProvider {
  id: string;
  label: string;
  /** Where the request goes, unless the user overrides it. */
  baseUrl: string;
  /** The model used when the user has not chosen one. */
  defaultModel: string;
  /** Models worth offering first, for the picker. */
  models: string[];
  /** Whether a key is needed at all. A local server does not have one. */
  needsKey: boolean;
  /** How the key is presented in the settings panel. */
  keyLabel: string;
  /** Short note about where the data goes. */
  note: string;
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    models: [
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4.1',
      'openai/gpt-4.1',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
    ],
    needsKey: true,
    keyLabel: 'OpenRouter API key',
    note: 'One key, many models. OpenRouter passes the prompt to whichever model you pick.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    needsKey: true,
    keyLabel: 'OpenAI API key',
    note: 'Your key is billed to your OpenAI account.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    needsKey: true,
    keyLabel: 'Anthropic API key',
    note: 'Your key is billed to your Anthropic account.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    needsKey: true,
    keyLabel: 'Google AI Studio API key',
    note: 'Your key is billed to your Google account.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    needsKey: true,
    keyLabel: 'Groq API key',
    note: 'Your key is billed to your Groq account.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    keyLabel: 'DeepSeek API key',
    note: 'Your key is billed to your DeepSeek account.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'qwen2.5', 'mistral', 'gemma2'],
    needsKey: false,
    keyLabel: 'No key needed',
    note: 'Runs on this machine. Nothing you write leaves it.',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    models: [],
    needsKey: true,
    keyLabel: 'API key',
    note: 'Any service that speaks the OpenAI chat-completions format.',
  },
];

export function findProvider(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

export interface AiConfig {
  /** Off until the user turns it on. There is no implicit AI in this app. */
  enabled: boolean;
  provider: string;
  apiKey: string;
  model: string;
  /** Overrides the provider's own host, for a proxy or a self-hosted gateway. */
  baseUrl: string;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: 'openrouter',
  apiKey: '',
  model: '',
  baseUrl: '',
};

/** The config as the settings panel sees it: the key is never handed out. */
export interface AiConfigView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  /** Whether a key is stored, without revealing it. */
  hasKey: boolean;
  /** The last four characters, which is enough to recognise a key. */
  keyHint: string;
}

export function configForView(config: AiConfig): AiConfigView {
  const key = config.apiKey.trim();
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasKey: key.length > 0,
    keyHint: key.length >= 4 ? `...${key.slice(-4)}` : '',
  };
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  messages: AiMessage[];
  /** How long to wait before giving up. */
  timeoutMs?: number;
}

/**
 * Ask the provider for a completion.
 *
 * The error message is the provider's own, because a wrong key and a wrong
 * model and a blocked network all look the same otherwise and the user needs
 * to know which one it was.
 */
export async function complete(request: AiRequest): Promise<{ text: string; model: string }> {
  const provider = findProvider(request.provider);
  if (!provider) throw new Error(`unknown AI provider: ${request.provider}`);
  if (!request.model.trim()) throw new Error('no model is chosen');
  if (provider.needsKey && !request.apiKey.trim()) throw new Error(`no API key for ${provider.label}`);

  const base = (request.baseUrl?.trim() || provider.baseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('no address to send the request to');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
  try {
    if (provider.id === 'anthropic') return await anthropicComplete(base, request);
    if (provider.id === 'google') return await googleComplete(base, request);
    return await openAiComplete(base, request);
  } finally {
    clearTimeout(timer);
  }
}

async function openAiComplete(
  base: string,
  request: AiRequest,
): Promise<{ text: string; model: string }> {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    }),
    signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
  });
  const body = await readJson(response);
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text === 'string' && text.length > 0) {
    return { text, model: body?.model ?? request.model };
  }
  throw new Error(providerMessage(body) ?? `the request failed (${response.status})`);
}

async function anthropicComplete(
  base: string,
  request: AiRequest,
): Promise<{ text: string; model: string }> {
  // Anthropic takes the system prompt out of band.
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const messages = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const response = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': request.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
  });
  const body = await readJson(response);
  const text = Array.isArray(body?.content)
    ? body.content
        .filter((part: { type?: string }) => part?.type === 'text')
        .map((part: { text?: string }) => part.text ?? '')
        .join('')
    : '';
  if (text.length > 0) return { text, model: body?.model ?? request.model };
  throw new Error(providerMessage(body) ?? `the request failed (${response.status})`);
}

async function googleComplete(
  base: string,
  request: AiRequest,
): Promise<{ text: string; model: string }> {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const response = await fetch(
    `${base}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
    },
  );
  const body = await readJson(response);
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? '')
    .join('');
  if (typeof text === 'string' && text.length > 0) {
    return { text, model: request.model };
  }
  throw new Error(providerMessage(body) ?? `the request failed (${response.status})`);
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

/** The provider's own error, so the user knows what went wrong. */
function providerMessage(body: any): string | undefined {
  const message = body?.error?.message ?? body?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
