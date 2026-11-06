/**
 * The settings dialog.
 *
 * A dialog with a navigation rail rather than a long scroll. The old one was
 * six labelled groups stacked in a sheet, which read as a settings panel with
 * a page list wedged in the middle of it, and which meant the thing you
 * wanted was always somewhere below the fold.
 *
 * The sections are the ones people actually arrive with:
 *
 *   General      who you are, where the workspace is
 *   Appearance   theme, type size, width, accent, zoom
 *   Editor       shortcuts and the things about typing
 *   Files & Sync the notes folder, and what to point it at
 *   Advanced     AI, and the settings that need explaining
 *
 * AI sits under Advanced on purpose. It is off by default, it needs a key
 * the user typed, and there is no reason to put it two clicks from the
 * top of the list.
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@ow/ui-kit';
import { ACCENTS } from './preferences.js';
import type { Preferences, ThemePreference } from './preferences.js';

export type SettingsSection = 'general' | 'appearance' | 'editor' | 'files' | 'import' | 'advanced' | 'ai';

const SECTIONS: { id: SettingsSection; label: string; hint: string }[] = [
  { id: 'general', label: 'General', hint: 'Your name and this workspace' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme, type size, colour' },
  { id: 'editor', label: 'Editor', hint: 'Shortcuts and typing' },
  { id: 'files', label: 'Files & Sync', hint: 'Where the notes live on disk' },
  { id: 'import', label: 'Import', hint: 'Bring your notes in from elsewhere' },
  { id: 'advanced', label: 'Advanced', hint: 'AI and everything else' },
];

interface AiProviderView {
  id: string;
  label: string;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  keyLabel: string;
  note: string;
}

interface AiView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
  providers: AiProviderView[];
}

interface FilesView {
  root: string;
  files: number;
  changed: string[];
  missing: string[];
  unknown: string[];
}

export interface SettingsDialogProps {
  prefs: Preferences;
  setPrefs: (patch: Partial<Preferences>) => void;
  onThemeChange: (theme: ThemePreference) => void;
  run: (id: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  onShowShortcuts: () => void;
  onClose: () => void;
  /** Shown in General: where the workspace database is. */
  workspacePath: string;
  /** Shown in General: the version of the application. */
  version: string;
  /** Which section is open. Held by the caller so the AI bubble can ask for
   *  a particular one rather than dropping the user at the top. */
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
}

export function SettingsDialog(props: SettingsDialogProps): React.ReactElement {
  const { section } = props;
  const setSection = props.onSection;
  const [ai, setAi] = useState<AiView | null>(null);
  const [files, setFiles] = useState<FilesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // Load the two panels that talk to the workspace, and only when they are
  // opened. Loading them up front would mean two round trips for every
  // settings visit, including the ones that never look at them.
  useEffect(() => {
    if (section === 'ai' && !ai) {
      void props.run('settings.ai.get').then((result) => {
        if (result.ok && result.value) setAi(result.value as AiView);
      });
    }
    if (section === 'files' && !files) {
      void props.run('files.status').then((result) => {
        if (result.ok && result.value) setFiles(result.value as FilesView);
      });
    }
  }, [section, ai, files, props.run]);

  const provider = useMemo(
    () => ai?.providers.find((p) => p.id === ai.provider) ?? null,
    [ai],
  );

  const setAiField = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setMessage('');
    const result = await props.run('settings.ai.set', patch);
    setBusy(false);
    if (result.ok) {
      const fresh = await props.run('settings.ai.get');
      if (fresh.ok && fresh.value) setAi(fresh.value as AiView);
    } else {
      setMessage(result.error ?? 'That did not work');
    }
  };

  const testAi = async () => {
    setBusy(true);
    setMessage('');
    const result = await props.run('settings.ai.test');
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? 'The test failed');
      return;
    }
    const value = result.value as { ok: boolean; reply?: string; error?: string };
    setMessage(value.ok ? `Connected. It replied: ${value.reply ?? ''}` : (value.error ?? 'The test failed'));
  };

  const importFolder = async (path: string) => {
    setBusy(true);
    setMessage('');
    const result = await props.run('import.folder', { path });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? 'That folder could not be imported');
      return;
    }
    const value = result.value as { pages: string[]; databases: string[] };
    const parts: string[] = [];
    if (value.pages.length > 0) parts.push(`${value.pages.length} page${value.pages.length === 1 ? '' : 's'}`);
    if (value.databases.length > 0) parts.push(`${value.databases.length} database${value.databases.length === 1 ? '' : 's'}`);
    setMessage(parts.length > 0 ? `Imported ${parts.join(' and ')}.` : 'Nothing to import in that folder.');
  };

  const syncFiles = async () => {
    setBusy(true);
    setMessage('');
    const result = await props.run('files.sync');
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? 'The sync failed');
      return;
    }
    const value = result.value as { written: string[]; imported: string[] };
    setMessage(
      `${value.written.length} file${value.written.length === 1 ? '' : 's'} written, ${value.imported.length} read back.`,
    );
    const status = await props.run('files.status');
    if (status.ok && status.value) setFiles(status.value as FilesView);
  };

  return (
    <div className="ow-overlay ow-overlay--settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="ow-dialog ow-settings-card">
        <div className="ow-settings-nav" role="tablist" aria-label="Settings sections">
          <div className="ow-settings-nav-head">
            <h2 className="ow-dialog-title">Settings</h2>
            <button
              type="button"
              className="ow-icon-btn"
              aria-label="Close settings"
              onClick={props.onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-label={item.label}
              aria-selected={section === item.id}
              className={`ow-settings-tab${section === item.id ? ' is-active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              <span className="ow-settings-tab-label">{item.label}</span>
              <span className="ow-settings-tab-hint">{item.hint}</span>
            </button>
          ))}
          {/* AI lives under Advanced rather than beside it: it is off by
              default and it needs the user to paste in a key. */}
          {(section === 'advanced' || section === 'ai') && (
            <button
              type="button"
              role="tab"
              aria-label="AI"
              aria-selected={section === 'ai'}
              className={`ow-settings-tab ow-settings-tab--nested${section === 'ai' ? ' is-active' : ''}`}
              onClick={() => setSection('ai')}
            >
              <span className="ow-settings-tab-label">AI</span>
              <span className="ow-settings-tab-hint">Use a model of your own</span>
            </button>
          )}
        </div>

        <div className="ow-settings-pane" role="tabpanel">
          {section === 'general' && <GeneralPane {...props} />}
          {section === 'appearance' && <AppearancePane {...props} />}
          {section === 'editor' && <EditorPane {...props} />}
          {section === 'import' && (
            <ImportPane busy={busy} message={message} onImport={importFolder} />
          )}
          {section === 'files' && (
            <FilesPane
              files={files}
              busy={busy}
              message={message}
              onSync={syncFiles}
              onRefresh={() => {
                void props.run('files.status').then((result) => {
                  if (result.ok && result.value) setFiles(result.value as FilesView);
                });
              }}
              onSetRoot={(path) => {
                setBusy(true);
                setMessage('');
                void props.run('files.root', { path }).then((result) => {
                  setBusy(false);
                  if (!result.ok) {
                    setMessage(result.error ?? 'That folder could not be used');
                    return;
                  }
                  const status = props.run('files.status');
                  void status.then((s) => {
                    if (s.ok && s.value) setFiles(s.value as FilesView);
                  });
                  setMessage(`Notes will be written to ${path}.`);
                });
              }}
            />
          )}
          {section === 'advanced' && (
            <AdvancedPane
              ai={ai}
              provider={provider}
              busy={busy}
              prefs={props.prefs}
              setPrefs={props.setPrefs}
              onOpenAi={() => setSection('ai')}
            />
          )}
          {section === 'ai' && (
            <AiPane
              ai={ai}
              provider={provider}
              busy={busy}
              message={message}
              onChange={setAiField}
              onTest={testAi}
              onBack={() => setSection('advanced')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The import panel.
 *
 * A workspace export is a folder of Markdown files and a CSV per database, so
 * the panel takes a folder and brings both in. The path is typed rather than
 * chosen with a file dialog: the application has no dialog yet, and a path
 * that can be pasted is the one that works on every platform.
 */
function ImportPane({
  busy,
  message,
  onImport,
}: {
  busy: boolean;
  message: string;
  onImport: (path: string) => void;
}): React.ReactElement {
  const [path, setPath] = useState('');
  return (
    <>
      <h3 className="ow-settings-title">Import</h3>
      <p className="ow-settings-lede">
        Export your pages from the other tool, unzip the export, and point this at the folder.
        Every Markdown file becomes a page and every CSV becomes a database. Nothing is read
        from anywhere else, and nothing leaves this machine.
      </p>

      <div className="ow-field">
        <label className="ow-field-label" htmlFor="ow-import-path">
          Folder
        </label>
        <div className="ow-key-row">
          <input
            id="ow-import-path"
            type="text"
            className="ow-field-input"
            spellCheck={false}
            placeholder="C:\\Users\\you\\Downloads\\Export"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button
            type="button"
            className="ow-choice"
            disabled={busy || path.trim().length === 0}
            onClick={() => onImport(path.trim())}
          >
            Import
          </button>
        </div>
        {message && <p className="ow-field-note">{message}</p>}
      </div>
    </>
  );
}

function GeneralPane(props: SettingsDialogProps): React.ReactElement {
  return (
    <>
      <h3 className="ow-settings-title">General</h3>
      <p className="ow-settings-lede">
        There are no accounts here. The name below is what &ldquo;last edited by&rdquo; shows on a
        page, and it is empty unless you type one.
      </p>

      <label className="ow-field">
        <span className="ow-field-label">Your name</span>
        <input
          type="text"
          className="ow-field-input"
          aria-label="Your name"
          placeholder="Optional"
          maxLength={64}
          value={props.prefs.profileName}
          onChange={(e) => props.setPrefs({ profileName: e.target.value })}
        />
      </label>

      <div className="ow-field">
        <span className="ow-field-label">Workspace</span>
        <code className="ow-field-code">{props.workspacePath}</code>
        <p className="ow-field-note">
          The database lives here. The Markdown files your notes are written to can live anywhere
          else &mdash; see <strong>Files &amp; Sync</strong>.
        </p>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Version</span>
        <code className="ow-field-code">{props.version}</code>
      </div>
    </>
  );
}

function AppearancePane(props: SettingsDialogProps): React.ReactElement {
  return (
    <>
      <h3 className="ow-settings-title">Appearance</h3>
      <p className="ow-settings-lede">
        Light is the default. Following the machine is available, but it means a first run on a
        dark computer opens dark, and the first thing a new user sees looks like a different
        product from the one they installed.
      </p>

      <div className="ow-field">
        <span className="ow-field-label">Theme</span>
        <div className="ow-choices" role="group" aria-label="Theme">
          {(['light', 'system', 'dark'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className="ow-choice"
              aria-pressed={props.prefs.theme === choice}
              onClick={() => props.onThemeChange(choice)}
            >
              {choice === 'light' ? 'Light' : choice === 'dark' ? 'Dark' : 'System'}
            </button>
          ))}
        </div>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Text size</span>
        <div className="ow-choices" role="group" aria-label="Text size">
          {(['small', 'medium', 'large'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className="ow-choice"
              aria-pressed={props.prefs.textSize === choice}
              onClick={() => props.setPrefs({ textSize: choice })}
            >
              {choice[0]!.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Content width</span>
        <div className="ow-choices" role="group" aria-label="Content width">
          {(['narrow', 'medium', 'wide', 'full'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className="ow-choice"
              aria-pressed={props.prefs.contentWidth === choice}
              onClick={() => props.setPrefs({ contentWidth: choice })}
            >
              {choice[0]!.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Accent</span>
        <div className="ow-accents" role="group" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.value}
              type="button"
              className="ow-accent"
              style={{ background: `#${a.value}` }}
              aria-label={a.label}
              aria-pressed={props.prefs.accent === a.value}
              onClick={() => props.setPrefs({ accent: a.value })}
            />
          ))}
        </div>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Zoom</span>
        <div className="ow-zoom">
          <button
            type="button"
            className="ow-choice"
            aria-label="Zoom out"
            onClick={() => props.setPrefs({ zoom: Math.max(50, props.prefs.zoom - 10) })}
          >
            &minus;
          </button>
          <span className="ow-zoom-value">{props.prefs.zoom}%</span>
          <button
            type="button"
            className="ow-choice"
            aria-label="Zoom in"
            onClick={() => props.setPrefs({ zoom: Math.min(200, props.prefs.zoom + 10) })}
          >
            +
          </button>
          <button
            type="button"
            className="ow-choice"
            onClick={() => props.setPrefs({ zoom: 100 })}
          >
            Reset
          </button>
        </div>
      </div>
    </>
  );
}

function EditorPane(props: SettingsDialogProps): React.ReactElement {
  return (
    <>
      <h3 className="ow-settings-title">Editor</h3>
      <p className="ow-settings-lede">
        Every action has an id and every id has a shortcut. The list is generated from the command
        registry, so it says what the commands actually do rather than what a hand-kept table
        claims.
      </p>

      <div className="ow-field">
        <span className="ow-field-label">Keyboard</span>
        <button type="button" className="ow-choice ow-choice--wide" onClick={props.onShowShortcuts}>
          Show all shortcuts
        </button>
        <p className="ow-field-note">
          Remapping them is not built yet. It is on the list, and the list is the honest one.
        </p>
      </div>
    </>
  );
}

interface FilesPaneProps {
  files: FilesView | null;
  busy: boolean;
  message: string;
  onSync: () => void;
  onRefresh: () => void;
  onSetRoot: (path: string) => void;
}

function FilesPane({
  files,
  busy,
  message,
  onSync,
  onRefresh,
  onSetRoot,
}: FilesPaneProps): React.ReactElement {
  const [path, setPath] = useState('');

  // The folder the app is using is the one to edit, so the field starts from
  // it rather than from nothing.
  useEffect(() => {
    if (files?.root && path.length === 0) setPath(files.root);
  }, [files?.root, path]);

  return (
    <>
      <h3 className="ow-settings-title">Files &amp; Sync</h3>
      <p className="ow-settings-lede">
        Every page is also written as a Markdown file. The file is the thing you can open in
        another editor, and the thing a sync tool can carry between machines. The database stays
        where it is, because a live database file travelling between two computers is how you get
        two broken copies instead of one good one.
      </p>

      <div className="ow-field">
        <label className="ow-field-label" htmlFor="ow-notes-root">
          Notes folder
        </label>
        <div className="ow-key-row">
          <input
            id="ow-notes-root"
            type="text"
            className="ow-field-input"
            spellCheck={false}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button
            type="button"
            className="ow-choice"
            disabled={busy || path.trim().length === 0}
            onClick={() => onSetRoot(path.trim())}
          >
            Use this folder
          </button>
        </div>
        <p className="ow-field-note">
          Point this at whatever you already sync. A folder that Syncthing watches, your iCloud
          Drive, your Dropbox folder, or a home server mounted over SMB or NFS &mdash; all of them
          carry plain files, and plain files is what this is.
        </p>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Sync</span>
        <div className="ow-choices">
          <button type="button" className="ow-choice ow-choice--wide" onClick={onSync} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
          <button type="button" className="ow-choice" onClick={onRefresh}>
            Refresh
          </button>
        </div>
        {message && <p className="ow-field-note ow-field-note--good">{message}</p>}
      </div>

      {files && (
        <div className="ow-field">
          <span className="ow-field-label">Status</span>
          <ul className="ow-status">
            <li>
              <span>Pages written</span>
              <strong>{files.files}</strong>
            </li>
            <li>
              <span>Changed outside the app</span>
              <strong>{files.changed.length}</strong>
            </li>
            <li>
              <span>Not on disk yet</span>
              <strong>{files.missing.length}</strong>
            </li>
            <li>
              <span>Files that belong to no page</span>
              <strong>{files.unknown.length}</strong>
            </li>
          </ul>
          {files.changed.length > 0 && (
            <p className="ow-field-note">
              {files.changed.slice(0, 3).join(', ')}
              {files.changed.length > 3 ? ` and ${files.changed.length - 3} more` : ''} changed since
              the app last wrote them. Sync now brings them in.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function AdvancedPane({
  ai,
  provider,
  busy,
  prefs,
  setPrefs,
  onOpenAi,
}: {
  ai: AiView | null;
  provider: AiProviderView | null;
  busy: boolean;
  prefs: Preferences;
  setPrefs: (patch: Partial<Preferences>) => void;
  onOpenAi: () => void;
}): React.ReactElement {
  return (
    <>
      <h3 className="ow-settings-title">Advanced</h3>
      <p className="ow-settings-lede">
        The settings that need explaining before they are useful.
      </p>

      <button type="button" className="ow-advanced-card" onClick={onOpenAi}>
        <span className="ow-advanced-title">AI</span>
        <span className="ow-advanced-note">
          {ai?.enabled
            ? `On. Using ${provider?.label ?? ai.provider}${ai.model ? ` with ${ai.model}` : ''}.`
            : 'Off. Nothing is sent anywhere until you turn it on and paste in your own key.'}
        </span>
        <span className="ow-advanced-more">{busy ? '' : 'Open'}</span>
      </button>

      <div className="ow-field" style={{ marginTop: 'var(--ow-space-5)' }}>
        <label className="ow-toggle">
          <input
            type="checkbox"
            checked={prefs.debug}
            onChange={(e) => setPrefs({ debug: e.target.checked })}
          />
          <span className="ow-toggle-text">
            <strong>Debug mode</strong>
            <span>
              Shows the things that are normally hidden: the AI bubble even when AI is off, a
              diagnostics readout, and the last few commands with how long each took. Nothing is
              sent anywhere by turning it on.
            </span>
          </span>
        </label>
      </div>
    </>
  );
}

function AiPane({
  ai,
  provider,
  busy,
  message,
  onChange,
  onTest,
  onBack,
}: {
  ai: AiView | null;
  provider: AiProviderView | null;
  busy: boolean;
  message: string;
  onChange: (patch: Record<string, unknown>) => void;
  onTest: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [key, setKey] = useState('');

  if (!ai) return <p className="ow-settings-lede">Loading…</p>;

  return (
    <>
      <button type="button" className="ow-back" onClick={onBack}>
        &larr; Advanced
      </button>
      <h3 className="ow-settings-title">AI</h3>
      <p className="ow-settings-lede">
        Openfield does not have an AI feature switched on. It has a way for you to switch one on,
        with a key you type in and a provider you choose. Your key is stored in this workspace and
        is sent to that provider and nowhere else.
      </p>

      <div className="ow-field">
        <label className="ow-toggle">
          <input
            type="checkbox"
            checked={ai.enabled}
            onChange={(e) => void onChange({ enabled: e.target.checked })}
          />
          <span className="ow-toggle-text">
            <strong>Use AI</strong>
            <span>Off by default. Nothing is sent anywhere until this is on.</span>
          </span>
        </label>
      </div>

      <div className="ow-field">
        <span className="ow-field-label">Provider</span>
        <div className="ow-choices ow-choices--wrap" role="group" aria-label="AI provider">
          {ai.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ow-choice"
              aria-pressed={ai.provider === p.id}
              onClick={() => void onChange({ provider: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        {provider && <p className="ow-field-note">{provider.note}</p>}
      </div>

      {provider?.needsKey && (
        <div className="ow-field">
          <label className="ow-field-label" htmlFor="ow-ai-key">
            {provider.keyLabel}
          </label>
          <div className="ow-key-row">
            <input
              id="ow-ai-key"
              type="password"
              className="ow-field-input"
              placeholder={ai.hasKey ? `Saved (${ai.keyHint})` : 'Paste your key'}
              value={key}
              autoComplete="off"
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              type="button"
              className="ow-choice"
              disabled={busy || key.trim().length === 0}
              onClick={() => {
                void onChange({ apiKey: key.trim() });
                setKey('');
              }}
            >
              Save key
            </button>
          </div>
          <p className="ow-field-note">
            The key is never shown again after it is saved, and it is never sent anywhere except
            the provider above.
          </p>
        </div>
      )}

      <div className="ow-field">
        <label className="ow-field-label" htmlFor="ow-ai-model">
          Model
        </label>
        <input
          id="ow-ai-model"
          type="text"
          className="ow-field-input"
          list="ow-ai-models"
          placeholder={provider?.defaultModel ?? 'model name'}
          value={ai.model}
          onChange={(e) => void onChange({ model: e.target.value })}
        />
        <datalist id="ow-ai-models">
          {(provider?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {provider?.id === 'custom' && (
        <div className="ow-field">
          <label className="ow-field-label" htmlFor="ow-ai-base">
            Address
          </label>
          <input
            id="ow-ai-base"
            type="text"
            className="ow-field-input"
            placeholder="https://your-gateway.example/v1"
            value={ai.baseUrl}
            onChange={(e) => void onChange({ baseUrl: e.target.value })}
          />
        </div>
      )}

      <div className="ow-field">
        <button type="button" className="ow-choice ow-choice--wide" onClick={onTest} disabled={busy || !ai.enabled}>
          {busy ? 'Testing…' : 'Test the connection'}
        </button>
        {message && <p className="ow-field-note">{message}</p>}
      </div>
    </>
  );
}
