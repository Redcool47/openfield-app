/**
 * Quick find.
 *
 * `search.quickFind` already exists as a command, so this is only the missing
 * half: a place to type and something to show. The command does the searching,
 * so the same code path serves this, the CLI and any future agent.
 *
 * Two details taken from studying an Apache-2.0 implementation of the same idea:
 *
 *   - Focus is restored to whatever had it before the palette opened. Without
 *     that, closing the palette drops the user at the top of the document with
 *     the caret gone -- on a keyboard, the difference between continuing and
 *     starting again.
 *   - It is a real modal: `role="dialog"` with `aria-modal`, so assistive
 *     technology treats the rest of the window as inert.
 *
 * Debounced rather than searching per keystroke. The search is cheap but it is a
 * round trip through the main process, and a request per character makes results
 * flicker backwards as responses arrive out of order.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface FindResult {
  id: string;
  title: string;
  /** The matched text with ‹› around it, straight from FTS5. Optional. */
  snippet: string;
}

export interface QuickFindProps {
  open: boolean;
  onClose: () => void;
  onOpenPage: (id: string) => void;
  search: (query: string) => Promise<FindResult[]>;
}

/** Wait after the last keystroke before searching. */
const DEBOUNCE_MS = 120;

export function QuickFind({ open, onClose, onOpenPage, search }: QuickFindProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FindResult[]>([]);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Whatever had focus before the palette opened, so it can be handed back.
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setResults([]);
    setActive(0);
    inputRef.current?.focus();
    return () => {
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  // Start from the top when the query changes, which is the only moment that is
  // right: the user is searching for something new, not adjusting a previous
  // choice.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const text = query.trim();
    // An empty query is not a search. Listing every page is technically an answer
    // and practically noise.
    if (text === '') {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void search(text).then((found) => {
        if (cancelled) return;
        setResults(found);
        // The highlight is NOT reset here.
        //
        // Results land on a debounce, which is after the user has usually
        // already pressed a key. Resetting to 0 at that point threw away an
        // arrow press made in the meantime: the user arrowed to the second
        // result, waited for the list, and the highlight silently jumped back to
        // the first -- so Enter opened a row they had moved away from. This was
        // showing up as an intermittent test failure and it is a real
        // misbehaviour, not a test artefact.
        //
        // Clamping happens in the effect below, and the reset happens when the
        // query changes, which is the only moment "start from the top" is right.
        setActive((i) => (found.length === 0 ? 0 : Math.min(i, found.length - 1)));
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, search]);

  const choose = useCallback(
    (result: FindResult) => {
      onOpenPage(result.id);
      onClose();
    },
    [onOpenPage, onClose],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const result = results[active];
        if (result) choose(result);
      }
    },
    [results, active, choose, onClose],
  );

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const summary =
    query.trim() === ''
      ? 'Type to search'
      : results.length === 0
        ? 'No pages match'
        : `${results.length} page${results.length === 1 ? '' : 's'}`;

  return (
    <div className="ow-modal-scrim" onMouseDown={onClose}>
      {/* stopPropagation: a click inside must not close the palette. */}
      <div
        className="ow-find"
        role="dialog"
        aria-modal="true"
        aria-label="Search pages"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="ow-find-input"
          value={query}
          placeholder="Search pages"
          aria-label="Search pages"
          aria-controls="ow-find-results"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />

        <ul ref={listRef} id="ow-find-results" className="ow-find-results" role="listbox">
          {results.map((result, index) => (
            <li
              key={result.id}
              role="option"
              aria-selected={index === active}
              className={`ow-find-item${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => {
                // mousedown, not click: the blur from clicking would close the
                // palette before the click could land.
                e.preventDefault();
                choose(result);
              }}
            >
              <span className="ow-find-item-title">{result.title || 'Untitled'}</span>
              {result.snippet !== '' && <span className="ow-find-item-snippet">{result.snippet}</span>}
            </li>
          ))}
        </ul>

        <p className="ow-find-summary" role="status">
          {summary}
        </p>
      </div>
    </div>
  );
}