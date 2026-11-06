/**
 * The AI bubble and the chat it opens.
 *
 * The bubble is in the bottom-left corner, out of the way of the page, and it
 * is only there when it can do something: the user has turned AI on and
 * pasted in a key. An application with a permanent AI button in the corner is
 * an application that is asking to be used by a machine rather than by a
 * person.
 *
 * The debug mode is the exception. With it on, the bubble shows even when AI
 * is off, so the thing can be looked at, and the panel says plainly that AI
 * is off rather than pretending the button is broken.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@ow/ui-kit';

export interface AiView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
  providers: { id: string; label: string; note: string; needsKey: boolean }[];
}

export interface AiBubbleProps {
  run: (id: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  /** The debug mode, from the preferences. */
  debug: boolean;
  /** Opens the settings on the AI section, for the "turn it on" path. */
  onOpenAiSettings: () => void;
  /** Diagnostics for the debug readout. */
  diagnostics: { label: string; value: string }[];
}

interface Message {
  role: 'you' | 'ai';
  text: string;
}

export function AiBubble(props: AiBubbleProps): React.ReactElement | null {
  const [ai, setAi] = useState<AiView | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // The configuration is read once. It changes in the settings panel, and the
  // panel is where the user goes to change it; reading it on every render of
  // the bubble would mean a command call per keystroke elsewhere.
  useEffect(() => {
    let cancelled = false;
    void props.run('settings.ai.get').then((result) => {
      if (cancelled || !result.ok || !result.value) return;
      setAi(result.value as AiView);
    });
    return () => {
      cancelled = true;
    };
  }, [props.run]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const usable = Boolean(ai?.enabled && ai.hasKey);
  const visible = usable || props.debug;
  if (!visible) return null;

  const ask = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt('');
    setError('');
    setMessages((current) => [...current, { role: 'you', text }]);
    setBusy(true);
    const result = await props.run('ai.complete', { prompt: text });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'The request failed');
      return;
    }
    const value = result.value as { text?: string };
    setMessages((current) => [...current, { role: 'ai', text: value.text ?? '' }]);
  };

  return (
    <>
      {open && (
        <div className="ow-ai-panel" role="dialog" aria-label="Ask the AI">
          <header className="ow-ai-panel-head">
            <span className="ow-ai-panel-title">Ask</span>
            {ai && <span className="ow-ai-panel-model">{ai.model || ai.providers.find((p) => p.id === ai.provider)?.label}</span>}
            <button type="button" className="ow-icon-btn" aria-label="Close the AI panel" onClick={() => setOpen(false)}>
              <Icon name="close" />
            </button>
          </header>

          {!usable && (
            <div className="ow-ai-off">
              <p>
                AI is {ai?.enabled ? 'on but has no key' : 'off'}. Nothing is sent anywhere until you
                turn it on and paste in a key of your own.
              </p>
              <button type="button" className="ow-choice" onClick={props.onOpenAiSettings}>
                Open the AI settings
              </button>
            </div>
          )}

          <div className="ow-ai-log" ref={logRef}>
            {messages.length === 0 && usable && (
              <p className="ow-ai-hint">Ask about the page you are looking at.</p>
            )}
            {messages.map((message, index) => (
              <div key={index} className={`ow-ai-message ow-ai-message--${message.role}`}>
                {message.text}
              </div>
            ))}
            {busy && <div className="ow-ai-message ow-ai-message--ai ow-ai-pending">Thinking…</div>}
            {error && <div className="ow-ai-error">{error}</div>}
          </div>

          {props.debug && (
            <div className="ow-ai-debug">
              {props.diagnostics.map((row) => (
                <div key={row.label} className="ow-ai-debug-row">
                  <span>{row.label}</span>
                  <code>{row.value}</code>
                </div>
              ))}
            </div>
          )}

          <form
            className="ow-ai-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <input
              type="text"
              className="ow-ai-input"
              placeholder={usable ? 'Ask something' : 'AI is off'}
              aria-label="Ask the AI"
              value={prompt}
              disabled={!usable || busy}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button type="submit" className="ow-ai-send" aria-label="Send" disabled={!usable || busy}>
              <Icon name="chevronRight" />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        className={`ow-ai-bubble${open ? ' is-open' : ''}`}
        aria-label={open ? 'Close the AI panel' : 'Ask the AI'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="sparkle" />
      </button>
    </>
  );
}
