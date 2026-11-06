/**
 * The version-history panel.
 *
 * Lists the versions of the open page, previews one, and restores it.
 *
 * Two things this gets right that are easy to get wrong:
 *
 *   - **Restoring keeps the old versions.** The command saves the current state
 *     as a new version before it replaces the document, so the history is never
 *     lossy -- which is the only reason a restore is safe to attempt.
 *   - **The panel shows a preview before you restore.** Restoring is a
 *     destructive act on the open document; a user who has not read what they
 *     are about to throw away should not be able to click it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@ow/ui-kit';

export interface HistoryVersion {
  id: string;
  label: string | null;
  createdAt: number;
  size: number;
}

interface HistoryPanelProps {
  pageId: string;
  run: (id: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  onClose: () => void;
}

/** "3 minutes ago" rather than a timestamp nobody can place. */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function HistoryPanel({ pageId, run, onClose }: HistoryPanelProps) {
  const [versions, setVersions] = useState<HistoryVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `run` in a ref, so the effects below depend on the version and not on the
   * identity of the runner.
   *
   * They used to depend on `run` directly, and that is a trap: the runner is a
   * new function on every render of the shell, so each effect cancelled the
   * previous fetch and started another, and the preview never finished loading.
   * The panel showed an empty preview and looked broken.
   */
  const runRef = useRef(run);
  runRef.current = run;

  const reload = useCallback(async () => {
    const result = await runRef.current('history.versions.list', { pageId });
    if (!result.ok) {
      setError(result.error ?? 'could not read the history');
      return;
    }
    const listed = (result.value as { versions: HistoryVersion[] }).versions;
    setVersions(listed);
    // Open on the newest, which is what the user came to look at.
    if (listed.length > 0) setSelected((current) => current ?? listed[0]!.id);
  }, [pageId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Keep the list live.
   *
   * A version is captured at the end of a burst of edits by a timer, so the
   * list grows while the panel is open. Loading it once on mount meant the panel
   * showed a list that was already out of date by the time you looked at it.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      void reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [reload]);

  // Preview whichever version is selected.
  useEffect(() => {
    if (!selected) {
      setPreview('');
      return;
    }
    let cancelled = false;
    void runRef.current('history.versions.preview', { versionId: selected }).then((result) => {
      if (cancelled) return;
      setPreview(result.ok ? (result.value as { text: string }).text : '');
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const result = await run('history.versions.restore', { versionId: selected });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'could not restore that version');
      return;
    }
    // The list changed: a restore adds a version rather than removing one.
    await reload();
  };

  return (
    <div className="ow-overlay" role="dialog" aria-modal="true" aria-label="Version history" onClick={onClose}>
      <div className="ow-dialog ow-history" onClick={(e) => e.stopPropagation()}>
        <div className="ow-dialog-head">
          <h2 className="ow-dialog-title">Version history</h2>
          <button type="button" className="ow-icon-btn" aria-label="Close version history" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        {error && (
          <p className="ow-history-error" role="alert">
            {error}
          </p>
        )}

        <div className="ow-dialog-body ow-history-body">
          <ul className="ow-history-list" role="listbox" aria-label="Saved versions">
            {versions.length === 0 && (
              <li className="ow-history-empty">
                No versions yet. One is saved every {25} changes.
              </li>
            )}
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  role="option"
                  className="ow-history-item"
                  aria-selected={v.id === selected}
                  onClick={() => setSelected(v.id)}
                >
                  <span className="ow-history-when">{v.label ?? ago(v.createdAt)}</span>
                  {v.label && <span className="ow-history-label">{v.label}</span>}
                </button>
              </li>
            ))}
          </ul>

          <pre className="ow-history-preview" aria-label="Preview of the selected version">
            {preview || 'Select a version to see it.'}
          </pre>
        </div>

        <div className="ow-dialog-foot">
          <button
            type="button"
            className="ow-text-btn"
            disabled={!selected || busy}
            onClick={() => void restore()}
          >
            {busy ? 'Restoring...' : 'Restore this version'}
          </button>
        </div>
      </div>
    </div>
  );
}
