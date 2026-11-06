/**
 * The block editor.
 *
 * One `contenteditable` element per block rather than one editor for the whole
 * page. That choice is what makes the rest tractable: the document is already a
 * tree of blocks, so a per-block editor has no internal model to reconcile
 * against the block model, and every keystroke maps to exactly one block.
 *
 * Three rules this file follows without exception:
 *
 *   1. The editor never mutates the document. It renders what the model says,
 *      and every change is a named command. A contenteditable element is a
 *      hostile thing to combine with a command registry -- the browser will
 *      happily edit the DOM behind your back -- so the single most important
 *      thing here is that DOM changes are *reverted* to the model's text unless
 *      the model agrees.
 *   2. The DOM is written only when it disagrees with the model. Rewriting a
 *      contenteditable's text on every render moves the caret to the start and
 *      makes the field unusable, so the text is compared first.
 *   3. Nothing here is privileged. If a user action can be expressed as a
 *      command id, it is, which is what lets the CLI and the keyboard map drive
 *      exactly the same code the mouse does.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inlineRuleAt, markdownTriggerMatch, slashEntries } from '@ow/model';
import type { ColorName } from '@ow/model';
import { Icon, renderLatex, type IconName } from '@ow/ui-kit';
import {
  bandBetween,
  intersects,
  isTinyBand,
  startAutoScroll,
  type BandRect,
} from './band-select.js';
import {
  blockRange,
  blockRangeSet,
  collapseSelection,
  nextSelection,
  type Selection,
} from './block-selection.js';

/** A flattened block row, as returned by the session outline. */
export interface BlockRow {
  id: string;
  type: string;
  text: string;
  depth: number;
  checked: boolean;
  collapsed: boolean;
  hiddenChildren: number;
  /** The runs behind `text`, so marks and links can be drawn. */
  runs: import('@ow/model').TextRun[];
}

export interface RunResult {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type Run = (id: string, args?: Record<string, unknown>) => Promise<RunResult>;

const BLOCK_ICON: Record<string, IconName> = {
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  paragraph: 'text',
  bulletedListItem: 'bulletedList',
  numberedListItem: 'numberedList',
  todo: 'todo',
  toggle: 'toggle',
  quote: 'quote',
  code: 'code',
  divider: 'divider',
  callout: 'quote',
};

/** Blocks that render as a marker plus an editable line. */
const HAS_MARKER = new Set(['bulletedListItem', 'numberedListItem', 'todo', 'toggle']);

/** Blocks whose text is set in a monospaced face on a tinted panel. */
const MONOSPACED = new Set(['code']);

/**
 * Where the caret, or the selection, should be after the next render.
 *
 * `end` is present only while a range is selected. That matters for formatting:
 * applying bold must leave the same words selected, because the obvious next
 * thing a user does is press Ctrl+I. Collapsing to a caret after the first mark
 * makes the second one apply to nothing, which reads as the shortcut being
 * broken rather than as a selection that vanished.
 */
interface Caret {
  id: string;
  offset: number;
  end?: number;
  /**
   * The text the offset was measured against.
   *
   * The caret is only put back when the text underneath it has changed. Without
   * this the app re-places the caret on every state push, and a push arrives
   * on every keystroke, so the caret is moved out from under the user
   * continuously.
   */
  text: string;
}

/** Read the caret's character offset within an element's text. */
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return el.textContent?.length ?? 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return el.textContent?.length ?? 0;
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/** Place the caret at a character offset within an element. */
function placeCaret(el: HTMLElement, offset: number, end?: number): void {
  const text = el.textContent ?? '';
  const clamp = (n: number) => Math.max(0, Math.min(n, text.length));

  // Resolve a character offset to a (text node, offset) pair.
  const locate = (target: number): { node: Node; offset: number } | null => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (seen + len >= target) return { node, offset: target - seen };
      seen += len;
      node = walker.nextNode();
    }
    return null;
  };

  const from = locate(clamp(offset));
  const to = end === undefined ? null : locate(clamp(end));

  const range = document.createRange();
  if (from && to && end !== undefined) {
    // Selection, preserved so consecutive formatting shortcuts compose.
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } else if (from) {
    range.setStart(from.node, from.offset);
    range.collapse(true);
  } else {
    // No text nodes at all: put the caret in the element itself so an empty
    // block is still typeable into.
    range.selectNodeContents(el);
    range.collapse(true);
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Character offsets of the current selection within an element's text.
 *
 * Returns null when the selection is collapsed or falls outside the element,
 * because a mark applied to an empty range is a no-op the user would read as a
 * broken shortcut. Selection can legitimately extend past one block in a
 * multi-block editor; this reports only what is inside this one, and the caller
 * is expected to check that the range covers something before acting.
 */
function selectionOffsets(el: HTMLElement): { from: number; to: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const measure = (node: Node, offset: number): number => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  const from = measure(range.startContainer, range.startOffset);
  const to = measure(range.endContainer, range.endOffset);
  return to > from ? { from, to } : null;
}

/**
 * The offset of the slash that opens the block menu, if the caret sits in one.
 *
 * The slash must start the line and be followed only by query characters, with
 * no whitespace between. That is what stops the menu from reopening every time
 * a URL containing a slash is typed, and it is why the menu closes by itself
 * once a space is typed rather than needing a click.
 *
 * Returns null when there is no menu here, which is the common case.
 */
function slashStart(text: string, caret: number): number | null {
  const before = text.slice(0, caret);
  if (!before.startsWith('/')) return null;
  if (/\s/.test(before.slice(1))) return null;
  return 0;
}

/**
 * Where an `@` mention query starts, or null.
 *
 * Only at the start of a word. An `@` in the middle of one -- an email address,
 * a handle -- is text, and opening a page picker over it would make those
 * impossible to type. The slash rule is the same shape for the same reason.
 */
function mentionStart(text: string, caret: number): number | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // Must be at a word boundary: the start of the line, or after whitespace.
  if (at !== 0 && !/\s/.test(before[at - 1]!)) return null;
  if (/\s/.test(before.slice(at + 1))) return null;
  return at;
}

export interface BlockEditorProps {
  rows: BlockRow[];
  run: Run;
  /** Every page in the workspace, for the @ picker. Passed in rather than
      fetched: the renderer has no database handle, and a fetch per keystroke
      would be a round trip to answer a question the state already has. */
  pages: { id: string; title: string }[];
}

export function BlockEditor({ rows, run, pages }: BlockEditorProps) {
  const [caret, setCaret] = useState<Caret | null>(null);
  const [textSel, setTextSel] = useState<{ id: string; from: number; to: number } | null>(null);
  /**
   * What the user has typed into a block, held until the model catches up.
   *
   * The editor is a controlled contenteditable: React renders the block's text
   * from the model. A keystroke therefore does not reach the screen until the
   * command has been sent, the model has answered and the state has been pushed
   * back -- and a character typed in that window is overwritten by the re-render,
   * because the model does not have it yet.
   *
   * Holding the draft means React always writes back exactly what the user
   * typed, and the marks come back when the draft is dropped.
   */
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [slash, setSlash] = useState<{ id: string; query: string } | null>(null);
  const [mention, setMention] = useState<{ id: string; from: number; query: string; active: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [band, setBand] = useState<BandRect | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const hosts = useRef(new Map<string, HTMLElement>());

  /**
   * Whether the command about to be issued is the editor's own typing.
   *
   * Set for the duration of the `block.setText` that `onInput` sends, and for
   * nothing else.
   */
  const typingRef = useRef(false);

  /**
   * Set when a command changed the text on purpose.
   *
   * Undo, a markdown rule and a turn-into all move the model somewhere the
   * screen is not, and for those the model is authoritative: "the model is
   * behind" is the wrong thing to believe. The flag makes the next sync write
   * the model's text whatever the screen says.
   */
  const forceSync = useRef(false);

  /**
   * The command door, with one extra rule.
   *
   * The pending text is *not* cleared here. It is dropped when the model
   * catches up with the screen, which is the only moment at which the two are
   * known to agree. Clearing it here would hand the model the screen while it
   * was still behind, and the next write would take the last few characters
   * with it.
   */
  const runCmd = useCallback(
    (id: string, args?: Record<string, unknown>) => {
      return run(id, args);
    },
    [run],
  );

  /**
   * The multi-block selection, as an anchor and a focus rather than a computed
   * range. Storing the endpoints instead of the range is what makes it possible
   * to extend in either direction: a stored range can only grow at one end
   * without re-deriving it, and re-deriving from a range is how a selection ends
   * up anchored somewhere the user never clicked.
   */
  const [range, setRange] = useState<Selection | null>(null);

  // Document order, recomputed from rows rather than cached, so it can never
  // disagree with what is on screen after an insert or a move.
  const order = useMemo(() => rows.map((r) => r.id), [rows]);
  const selected = useMemo(
    () => blockRangeSet(order, range?.anchor ?? null, range?.focus ?? null),
    [order, range],
  );

  /**
   * Write the model's text into the DOM, but only where they disagree.
   *
   * This is the whole defence against contenteditable and React fighting over
   * the same node. The browser edits the element directly; React would then
   * re-render it from the model and, if the model has not caught up yet, wipe
   * the character just typed.
   *
   * The rule is anchored to what is *on the screen*, not to a remembered copy
   * of it. The screen is the only place a character typed in the last few
   * milliseconds exists, so the model may only write over it when the two
   * agree. When they agree the pending text has done its job and the marks
   * can come back.
   *
   * A command that changed the text on purpose -- undo, a markdown rule, a
   * turn-into -- sets the force flag, because for those the model is
   * authoritative and "behind" is the wrong word.
   */
  const syncText = useCallback(
    (row: BlockRow) => {
      const el = hosts.current.get(row.id);
      if (!el) return;
      const text = row.text;
      const onScreen = el.textContent ?? '';
      // A block with a mention, an equation or a tag in it is drawn as markup,
      // and writing the text over it would replace the node with its label.
      // React draws those, so the text is left alone.
      const hasNode = (row.runs ?? []).some((run) => run.inline);

      if (forceSync.current) {
        forceSync.current = false;
        setDraft(null);
        if (hasNode) return;
        if (onScreen === text) return;
        const at = caretOffset(el);
        el.textContent = text;
        placeCaret(el, at);
        return;
      }

      const pending = draft;
      if (pending && pending.id === row.id) {
        // The model is behind: the user has typed more than it has. The screen
        // holds the character and the model does not, so the screen wins.
        if (onScreen !== text) return;
        // The model has caught up with the screen. The pending text is done and
        // the marks can be drawn again.
        setDraft(null);
        return;
      }

      if (onScreen === text) return;
      const at = caretOffset(el);
      el.textContent = text;
      placeCaret(el, at);
    },
    [draft],
  );

  useLayoutEffect(() => {
    for (const row of rows) syncText(row);
  }, [rows, syncText]);

  // Restore focus and caret after a command has been through the registry and the
  // model has come back. Without this, any command that changes the text -- a
  // markdown trigger, Enter, undo -- drops the user's place.
  useLayoutEffect(() => {
    if (!caret) return;
    const el = hosts.current.get(caret.id);
    if (!el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    placeCaret(el, caret.offset, caret.end);
    // `draft` is in the dependencies on purpose.
    //
    // Dropping the pending text re-renders the block from the model's runs,
    // which replaces the element's children, and replacing children collapses
    // the selection into the element. Without this the caret was left at the
    // start of the block and the rest of the word was typed there: "Hello
    // Openfield" arrived as "lo OpenfieldHel".
  }, [caret, rows, draft]);

  /**
   * Scroll the page while a drag is near an edge.
   *
   * Runs for both the rubber band and block drag, because they are the same
   * problem: a gesture started on screen one, finished off it, and needs to
   * reach content that is not currently visible. Without this, moving a block to
   * the end of a long page means dragging to the bottom, waiting for nothing to
   * happen, and scrolling by hand mid-drag.
   */
  useEffect(() => {
    const draggingNow = band !== null || dragging !== null;
    if (!draggingNow) return;
    return startAutoScroll((deltaY) => {
      document.querySelector<HTMLElement>('.ow-page-scroll')?.scrollBy({ top: deltaY });
    });
  }, [band !== null, dragging !== null]);

  /**
   * Which blocks a rectangle covers, in document order.
   *
   * Read from the DOM rather than from the model: a band is a screen gesture,
   * and only the screen knows what is under the pointer. Collapsed blocks are
   * excluded because they are not visible, and selecting a block the user
   * cannot see is how a delete takes out something they never clicked.
   */
  const coveredBy = useCallback(
    (rect: BandRect): string[] => {
      const hit = Array.from(document.querySelectorAll<HTMLElement>('.ow-block[data-block-id]'))
        .filter((el) => !el.querySelector('[aria-label^="3 collapsed"]') && intersects(rect, domRect(el)))
        .map((el) => el.getAttribute('data-block-id')!)
        .filter((id) => order.includes(id));
      return order.filter((id) => hit.includes(id));
    },
    [order],
  );

  /**
   * Start a rubber band when the press lands on the page margin.
   *
   * Listens on the scroll container rather than on `.ow-blocks`, because
   * `.ow-blocks` is exactly as wide as the content: the margin the user aims at
   * is the container's own padding, and a handler on the content would never
   * see the press at all.
   *
   * A press on a block is ignored. It is a click into that block, and swallowing
   * those would turn the gutter into a dead zone across the whole page.
   */
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>('.ow-page-scroll');
    if (!scroller) return;

    const down = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target || !scroller.contains(target)) return;
      if (target.closest('.ow-block')) return;
      // The page title is edited by clicking it. It is not a block, so treating
      // it as margin prevented the mousedown that would have focused it: the
      // title could not be renamed with the mouse at all.
      if (target.closest('.ow-page-title')) return;
      // Only the margin beside the text, not the page furniture: a press on the
      // scrollbar or a floating control should do what it normally does.
      if (target.closest('.ow-page-scroll button, .ow-page-scroll a, .ow-page-scroll input')) return;
      event.preventDefault();

      const start = { x: event.clientX, y: event.clientY };
      setBand(bandBetween(start.x, start.y, start.x, start.y));

      const move = (e: MouseEvent) => setBand(bandBetween(start.x, start.y, e.clientX, e.clientY));
      const finish = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', finish);
        setBand((current) => {
          if (current && !isTinyBand(current)) {
            const hit = coveredBy(current);
            if (hit.length > 0) setRange({ anchor: hit[0]!, focus: hit[hit.length - 1]! });
          }
          return null;
        });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', finish);
    };

    scroller.addEventListener('mousedown', down);
    return () => scroller.removeEventListener('mousedown', down);
  }, [coveredBy]);

  const focusBlock = useCallback(
    (id: string, offset?: number) => {
      const target = rows.find((r) => r.id === id);
      setCaret({ id, offset: offset ?? 0, text: target?.text ?? '' });
    },
    [rows],
  );

  /**
   * Mirror the browser's live selection, for the floating toolbar only.
   *
   * Deliberately NOT stored in `caret`. `caret` drives a layout effect that
   * re-places the caret, so writing a selection into it makes the effect collapse
   * the selection that produced it -- the toolbar would appear and vanish on
   * every selectionchange. Two states, one for "where the caret is" and one for
   * "what is selected".
   *
   * Listens on the document because `selectionchange` does not bubble to the
   * element it originated in.
   */
  useEffect(() => {
    const sync = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setTextSel(null);
        return;
      }
      const node = sel.anchorNode;
      const block = (node instanceof Element ? node : node?.parentElement)?.closest('.ow-block');
      const host = block?.querySelector<HTMLElement>('.ow-block-text');
      const id = block?.getAttribute('data-block-id');
      if (!host || !id) return;
      // Only a selection inside one block gets a toolbar; one that runs past
      // this block's text has no single rect to point at.
      const range = selectionOffsets(host);
      if (!range) return;
      setTextSel({ id, from: range.from, to: range.to });
    };
    document.addEventListener('selectionchange', sync);
    return () => document.removeEventListener('selectionchange', sync);
  }, []);

  /**
   * Apply a markdown input rule.
   *
   * Fires on the space that completes the trigger, and strips the matched prefix
   * so "> " becomes an empty toggle rather than a toggle reading "> ". The caret
   * lands at zero because that is where the remaining text now begins.
   *
   * Both `text` and `text + ' '` are tried. A keydown handler normally runs
   * before the character is inserted, so the space is not in the element yet --
   * but that ordering is not guaranteed across input methods. An IME, a
   * paste-then-space, or a browser that reports the space first all produce the
   * other order, and a trigger that silently stops working under a CJK input
   * method is a bad failure to have.
   */
  const tryMarkdown = useCallback(
    async (id: string, text: string) => {
      const type = markdownTriggerMatch(text) ?? markdownTriggerMatch(`${text} `);
      if (!type) return false;
      forceSync.current = true;
    await runCmd('block.setText', { id, text: '' });
      await runCmd(`block.turnInto.${type.replace(/([A-Z])/g, (m) => m).replace(/[^A-Za-z0-9]/g, '')}`, { id });
      focusBlock(id, 0);
      return true;
    },
    [runCmd, focusBlock],
  );

  /**
   * Apply the inline rule that ends at the caret, if there is one.
   *
   * The rules fire on the closing character, because that is the only moment
   * at which the token is complete. A tag is the exception: its name is not
   * finished until the word is, so it fires on the space after it.
   *
   * A rule that matches nothing does nothing, and a rule that cannot be
   * applied -- a wiki link to a page that does not exist -- leaves the text as
   * it was. A link that goes nowhere is worse than text.
   */
  const applyInlineRule = useCallback(
    async (row: BlockRow, text: string, caret: number): Promise<boolean> => {
      const match = inlineRuleAt(text, caret);
      document.documentElement.setAttribute('data-dbg', JSON.stringify({ text, caret, match }));
      if (!match) return false;

      if (match.id === 'equation') {
        await runCmd('inline.equation.set', {
          id: row.id,
          from: match.from,
          to: match.to,
          latex: match.value,
        });
        return true;
      }
      if (match.id === 'tag') {
        await runCmd('inline.tag.set', {
          id: row.id,
          from: match.from,
          to: match.to,
          name: match.value,
        });
        return true;
      }
      const target = await runCmd('inline.wiki.set', {
        id: row.id,
        from: match.from,
        to: match.to,
        title: match.value,
      });
      return target.ok;
    },
    [runCmd],
  );

  const onInput = useCallback(
    async (row: BlockRow, el: HTMLElement) => {
      const text = el.textContent ?? '';
      const at = caretOffset(el);
      setCaret({ id: row.id, offset: at, text });
      // The draft is what the user has actually typed, held until the model
      // catches up.
      //
      // Without it, every keystroke is: type -> send the command -> the model
      // answers -> the state pushes -> React re-renders the block from the model.
      // A character typed while that round trip was still in flight got
      // overwritten by the re-render, because the model did not have it yet.
      // It showed up as "Hello Openfield" arriving as "Helo Openfield", and it
      // was intermittent enough to look like a flake.
      setDraft({ id: row.id, text });
      // The menu is decided here and only here. Opening and closing are the same
      // question -- "does the caret sit in a slash query?" -- and answering it in
      // two places is how a menu ends up stuck open after a space, because the
      // keydown that opened it has no idea a space was typed.
      const slashAt = slashStart(text, at);
      setSlash(slashAt === null ? null : { id: row.id, query: text.slice(slashAt + 1, at) });
      // Same single-decision-point rule as the slash menu: the mention query is
      // recomputed from the caret on every input, so typing a space closes it
      // without a keydown having to know that spaces end queries.
      const mentionAt = mentionStart(text, text.length);
      setMention((current) =>
        mentionAt === null
          ? null
          : {
              id: row.id,
              from: mentionAt,
              query: text.slice(mentionAt + 1),
              // Keep the highlight where the user left it while the query narrows.
              // A list that resets to the top on every keystroke cannot be
              // narrowed past its first entry.
              active: current && current.id === row.id && current.from === mentionAt ? current.active : 0,
            },
      );
      // The model has caught up when this resolves. The command is answered
      // after the state is pushed, so by then the model holds the text that was
      // typed.
      typingRef.current = true;
      try {
        await runCmd('block.setText', { id: row.id, text });
      } finally {
        typingRef.current = false;
      }
      // Clear the pending text only if it is still this one. If the user typed
      // again while the command was in flight, the newer pending text is the
      // live one, and dropping it here would let the model overwrite a
      // character that has not reached it yet.
      setDraft((current) =>
        current && current.id === row.id && current.text === text ? null : current,
      );
      // The inline rules run after the text has been sent.
      //
      // Before, the rule's edit was undone by the keystroke that triggered it:
      // the rule made the equation and the setText that followed replaced it
      // with the raw characters again.
      void applyInlineRule(row, text, at);
    },
    [runCmd, applyInlineRule],
  );

  /**
   * Replace the mention query with a link to `pageId`.
   *
   * The query characters are removed and the page's title is inserted as real
   * text carrying an inline node. Storing the literal "@Quarter" instead would
   * leave search, export and word count all disagreeing with the screen, so the
   * model has to hold what the user actually sees.
   */
  const pickMention = useCallback(
    async (pageId: string) => {
      const m = mention;
      if (!m) return;
      const title = pages.find((p) => p.id === pageId)?.title ?? '';
      setMention(null);
      await runCmd('block.setText', {
        id: m.id,
        text: (rows.find((r) => r.id === m.id)?.text ?? '').slice(0, m.from),
      });
      await runCmd('inline.page.set', { id: m.id, from: m.from, to: m.from, pageId, label: title });
      focusBlock(m.id, m.from + title.length);
    },
    [mention, pages, rows, run, focusBlock],
  );

  const onKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLElement>, row: BlockRow) => {
      const el = event.currentTarget;
      const text = el.textContent ?? '';
      const at = caretOffset(el);

      // Undo and redo are owned by App, but the pending text has to go when
      // they happen.
      //
      // The model is about to move backwards, to text the user never typed
      // just now. A pending text that survived that would keep the model out of
      // the screen, and the undo would look like it had done nothing.
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          // Undo moves the model backwards on purpose. The screen has to follow it.
          forceSync.current = true;
          setDraft(null);
        }
      }

      /**
       * A live block selection takes the key, before any caret logic.
       *
       * Without this, Backspace with three blocks selected would delete the one
       * character before the caret and leave the selection sitting there looking
       * like it had done nothing -- which is the worst outcome, because it reads
       * as a broken key rather than as a missing feature.
       *
       * Both keys behave identically on purpose. Backspace conventionally means
       * "join with the previous block" while a selection is live and Delete means
       * "remove forward"; implementing only one makes the other look arbitrary,
       * and the asymmetry stays invisible until someone reaches for it.
       */
      if ((event.key === 'Backspace' || event.key === 'Delete') && range) {
        // `range` can hold a null endpoint only in the instant before it is
        // replaced. A keypress in that window has no range to act on, so it is
        // ignored rather than passed a null id and failing inside the command.
        const anchor = range.anchor;
        const focus = range.focus;
        if (anchor === null || focus === null) return;
        event.preventDefault();
        if (blockRange(order, anchor, focus).length === 0) return;
        setRange(null);
        // One command for the whole range, so one Ctrl+Z brings all of it back.
        await runCmd('block.deleteRange', { anchorId: anchor, focusId: focus });
        return;
      }

  /**

  /**
   * The mention picker takes the keyboard while it is open.
       *
       * Handled here rather than on the menu element because the menu never
       * takes focus: the caret stays in the block so typing keeps narrowing the
       * query, which is the whole point. A menu with its own onKeyDown and no
       * focus is a menu whose arrow keys and Enter do nothing at all.
       */
      if (mention && mention.id === row.id) {
        const hits = matchingPages(pages, mention.query);
        if (event.key === 'Escape') {
          event.preventDefault();
          setMention(null);
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setMention((c) =>
            c && hits.length > 0 ? { ...c, active: (c.active + step + hits.length) % hits.length } : c,
          );
          return;
        }
        if (event.key === 'Enter' && hits[mention.active]) {
          event.preventDefault();
          await pickMention(hits[mention.active]!.id);
          return;
        }
        if (event.key === 'Tab' && hits[mention.active]) {
          event.preventDefault();
          await pickMention(hits[mention.active]!.id);
          return;
        }
      }

      // Undo and redo are deliberately NOT handled here.
      //
      // App.tsx already owns them on a window-level keydown listener, and having
      // both is not a harmless duplication: one Ctrl+Z fired two commands and
      // undid two edits. Worse, it was invisible in testing because each half
      // worked perfectly on its own.
      //
      // This is the general hazard of a per-component handler plus a global one.
      // A shortcut that means the same thing in two places has two owners, and
      // two owners is one too many. The global listener wins, and the marks
      // below stay here because the global handler does not claim them.

      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();

        // Inline marks. These need a selection, because "bold" with nothing
        // selected has no meaning -- there is no character to mark.
        const marks: Record<string, string> = {
          b: 'mark.bold.toggle',
          i: 'mark.italic.toggle',
          u: 'mark.underline.toggle',
          e: 'mark.code.toggle',
        };
        const shifted: Record<string, string> = { s: 'mark.strikethrough.toggle' };
        // Ctrl+K, or Cmd+K. The prompt is here rather than in the command layer
        // because the main process has no prompt of its own; the scheme check
        // stays in the command so the CLI gets it too.
        if (key === 'k' && (event.ctrlKey || event.metaKey)) {
          const link = selectionOffsets(el);
          if (link && link.to > link.from) {
            event.preventDefault();
            const href = window.prompt('Link URL (leave empty to remove)', '');
            if (href === null) return;
            await runCmd('mark.link.set', { id: row.id, from: link.from, to: link.to, href });
            setCaret({ id: row.id, offset: link.from, end: link.to, text: row.text });
          }
          return;
        }

        const markId = event.shiftKey ? shifted[key] : marks[key];
        if (markId) {
          const range = selectionOffsets(el);
          if (range) {
            event.preventDefault();
            await runCmd(markId, { id: row.id, from: range.from, to: range.to });
            setCaret({ id: row.id, offset: range.from, end: range.to, text: row.text });
          }
          return;
        }
      }

      // Enter: split the block. The command decides what the new block is --
      // inside a list it continues the list, in a heading it becomes a paragraph
      // -- so the editor does not second-guess it.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const head = text.slice(0, at);
        const tail = text.slice(at);
        forceSync.current = true;
    await runCmd('block.setText', { id: row.id, text: head });
        const created = await runCmd('block.insert', {
          type: row.type === 'code' ? 'paragraph' : row.type,
          text: tail,
          parentId: row.type === 'divider' ? null : undefined,
        });
        const newId = (created.value as { id?: string } | undefined)?.id;
        if (newId) focusBlock(newId, 0);
        return;
      }

      // Backspace at the very start of a block.
      //
      // Two cases, and conflating them is a common bug. On an *empty* block the
      // block itself goes away -- that is block.backspace, which promotes or
      // merges. On a *non-empty* block there is nothing to delete inside this
      // block, and deleting "backwards" means joining onto the previous block, so
      // the caret moves there and the user deletes with a second press if that is
      // what they meant. Letting the browser handle it instead would silently do
      // nothing at all, because a contenteditable with no previous sibling inside
      // the same host element has nothing to merge into.
      if (event.key === 'Backspace' && at === 0) {
        const index = rows.findIndex((r) => r.id === row.id);
        if (text.length === 0) {
          event.preventDefault();
          await runCmd('block.backspace', { id: row.id });
          return;
        }
        const previous = index > 0 ? rows[index - 1] : null;
        if (previous) {
          event.preventDefault();
          focusBlock(previous.id, previous.text.length);
          return;
        }
        // No previous block: let the browser do whatever it does, which is
        // nothing, rather than pretending the key was handled.
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        // A live selection indents the whole range. This has to come before the
        // single-block path: Tab with four blocks selected otherwise moves one
        // block and leaves the selection looking untouched.
        if (range && range.anchor !== null && range.focus !== null) {
          const anchor = range.anchor;
          const focus = range.focus;
          if (blockRange(order, anchor, focus).length === 0) return;
          setRange(null);
          await runCmd('block.indentRange', { anchorId: anchor, focusId: focus, outdent: event.shiftKey });
          return;
        }
        await runCmd(event.shiftKey ? 'block.outdent' : 'block.indent', { id: row.id });
        focusBlock(row.id, at);
        return;
      }

      // A space is where both markdown triggers and the slash menu begin, so it
      // is the single point where "the user asked for a block type" is decided.
      if (event.key === ' ') {
        if (await tryMarkdown(row.id, text + ' ')) {
          event.preventDefault();
          return;
        }
      }

      if (event.key === 'Escape') {
        // With a range selected, Escape narrows it to the one block holding the
        // caret instead of clearing it outright. Clearing loses the selection
        // entirely and the user has to start again; narrowing is the step they
        // were asking for and is what every other editor does.
        if (range && range.anchor !== null && range.focus !== null && range.anchor !== range.focus) {
          // The caret wins where it is: it is the block the user is actually in.
          // Falling back to the anchor covers the case where focus moved out of
          // the editor entirely, e.g. into the gutter.
          const keep = caret?.id ?? range.anchor;
          setRange(collapseSelection(range, keep));
          return;
        }
        setSlash(null);
      }
    },
    [runCmd, rows, focusBlock, tryMarkdown, range, order],
  );

  /** Move the caret to a sibling block when the user arrows off the end. */
  const onKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, row: BlockRow) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const el = event.currentTarget;
      const at = caretOffset(el);
      const text = el.textContent ?? '';
      const index = rows.findIndex((r) => r.id === row.id);
      const target =
        event.key === 'ArrowUp'
          ? index > 0
            ? rows[index - 1]
            : null
          : index >= 0 && index < rows.length - 1
            ? rows[index + 1]
            : null;
      if (!target) return;
      // Only move when the caret is genuinely leaving the line, so arrowing
      // within a wrapped paragraph still works normally.
      if (event.key === 'ArrowUp' && at !== 0) return;
      if (event.key === 'ArrowDown' && at !== text.length) return;
      focusBlock(target.id, event.key === 'ArrowUp' ? undefined : target.text.length);
    },
    [rows, focusBlock],
  );

  return (
    <div
      className="ow-blocks"
      role="document"
      aria-label="Page content"
    >
      {band && (
        <div
          className="ow-band"
          aria-hidden="true"
          style={{ left: band.left, top: band.top, width: band.right - band.left, height: band.bottom - band.top }}
        />
      )}

      {rows.map((row) => {
        const marker = HAS_MARKER.has(row.type);
        return (
          <div
            key={row.id}
            className={`ow-block ow-block-${row.type}${marker ? ' ow-block-marked' : ''}${
              selected.has(row.id) ? ' ow-block-selected' : ''
            }`}
            data-type={row.type}
            data-block-id={row.id}
            data-selected={selected.has(row.id) ? 'true' : undefined}
            data-dragging={dragging === row.id ? 'true' : undefined}
            data-drop={dropAt?.id === row.id ? (dropAt.after ? 'after' : 'before') : undefined}
            style={{ marginLeft: `${row.depth * 26}px` }}
            onMouseDown={(e) => {
              // The gutter's own handler is an ancestor-descendant relationship,
              // and mouse events bubble: without this guard the gutter selects a
              // block and this immediately clears it again, so clicking a handle
              // does nothing at all.
              if ((e.target as HTMLElement).closest('.ow-block-gutter')) return;
              // A plain click inside the block clears any block selection rather
              // than making one. Placing a caret is not selecting a block: if it
              // were, every click while typing would leave a highlight behind the
              // caret that reads as a live selection and is not.
              if (!e.shiftKey && e.button === 0) setRange(null);
            }}
          >
            <span
              className="ow-block-gutter"
          draggable
          // The grip is the drag handle and the plus adds a block below. Both sit
          // in the gutter rather than inside the text: anything inside the
          // contenteditable can receive a caret, and a caret landing on a button
          // is how a stray character ends up in a page.
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', row.id);
            e.dataTransfer.effectAllowed = 'move';
            setDragging(row.id);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDropAt(null);
          }}
              role="button"
              tabIndex={-1}
              aria-label={`Select block${row.text ? `: ${row.text}` : ''}`}
              aria-pressed={selected.has(row.id)}
              onMouseDown={(e) => {
                // preventDefault stops the browser turning this into a text
                // selection that fights the block selection for the same pixels.
                e.preventDefault();
                setRange((current) => nextSelection(current, row.id, e.shiftKey));
              }}
            onDragOver={(e) => {
                // Only the top and bottom quarters move the block; the middle
                // half would nest it, and nesting by accident while trying to
                // reorder is the single most complained-about drag bug.
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const box = e.currentTarget.closest('.ow-block')!.getBoundingClientRect();
                const after = e.clientY > box.top + box.height / 2;
                setDropAt({ id: row.id, after });
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                const drop = dropAt;
                setDragging(null);
                setDropAt(null);
                if (!id || !drop || id === drop.id) return;
                void runCmd('block.moveTo', { id, targetId: drop.id, position: drop.after ? 'after' : 'before' });
              }}
            >
              {/*
                The list marker goes where the block-type icon would be, in the
                gutter.

                Rendered as a sibling of the gutter instead, it produced two
                bullets: the gutter kept its own glyph and the marker added a
                second one beside it. One column, one marker. It is also the
                position the reference puts the bullet in -- the same slot the
                drag handle occupies on hover -- so the text does not shift when
                the pointer arrives.
              */}
              {(row.type === 'bulletedListItem' || row.type === 'numberedListItem') ? (
                <span className="ow-block-marker" aria-hidden="true" />
              ) : (
                <Icon name={BLOCK_ICON[row.type] ?? 'text'} size={14} />
              )}
              <button
                type="button"
                className="ow-block-add"
                aria-label={`Add a block below${row.text ? `: ${row.text}` : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  // Put the caret at the end of this block, then insert: block
                  // inserts relative to the focused block, so this lands the new
                  // one directly below rather than at the end of the page.
                  focusBlock(row.id, row.text.length);
                  void runCmd('block.insert', { type: 'paragraph' });
                }}
              >
                <Icon name="plus" size={12} />
              </button>
            </span>

            {row.type === 'todo' && (
              <input
                type="checkbox"
                className="ow-block-checkbox"
                checked={row.checked}
                aria-label={`Mark "${row.text}" done`}
                onChange={() => void runCmd('block.setChecked', { id: row.id })}
              />
            )}


            {mention && mention.id === row.id && (
              <MentionMenu
                pages={matchingPages(pages, mention.query)}
                active={mention.active}
                onHover={(i) => setMention((c) => (c ? { ...c, active: i } : c))}
                anchor={anchorMention(mention.from)}
                onDismiss={() => setMention(null)}
                onPick={(pageId) => void pickMention(pageId)}
              />
            )}

            {row.type === 'divider' ? (
              <hr className="ow-divider" />
            ) : row.type === 'tableOfContents' ? (
              <TableOfContents rows={rows} />
            ) : (
              <span
                ref={(el) => {
                  if (el) hosts.current.set(row.id, el);
                  else hosts.current.delete(row.id);
                }}
                className={`ow-block-text${MONOSPACED.has(row.type) ? ' ow-block-mono' : ''}${
                  row.checked ? ' ow-block-done' : ''
                }`}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-label={row.type}
                spellCheck
                data-placeholder={row.text ? undefined : "Type '/' for commands"}
                onInput={(e) => void onInput(row, e.currentTarget)}
                onKeyDown={(e) => void onKeyDown(e, row)}
                onKeyUp={(e) => onKeyUp(e, row)}
                onFocus={(e) => {
                  const el = e.currentTarget;
                  setCaret({ id: row.id, offset: caretOffset(el), text: el.textContent ?? '' });
                }}
                onBlur={() => {
                  setCaret(null);
                  // Leaving the block hands the text back to the model. A
                  // pending text that outlived the focus would keep the model
                  // out of the screen for good.
                  setDraft(null);
                }}
              >
                {/*
                  Runs are rendered whether or not the block is focused.
                  Swapping to a bare string on focus is what broke text selection
                  outright: replacing the child nodes destroyed the selection
                  anchor, so the caret ended up pointing at the element instead
                  of a text offset, and no drag or shift+arrow could select
                  anything. That is also why the mark commands had never been
                  exercisable from the UI -- Ctrl+B needs a selection to mean
                  anything.
                */}
                {renderBlock(row, draft)}
              </span>
            )}

            {slash && slash.id === row.id && (
              <SlashMenu
                query={slash.query}
                anchor={anchorSlash}
                onPick={async (type) => {
                  setSlash(null);
                  await runCmd('block.setText', { id: row.id, text: '' });
                  await runCmd(
                    `block.turnInto.${type.replace(/([A-Z])/g, (m) => m).replace(/[^A-Za-z0-9]/g, '')}`,
                    { id: row.id },
                  );
                  focusBlock(row.id, 0);
                }}
                onDismiss={() => setSlash(null)}
              />
            )}

            {row.hiddenChildren > 0 && (
              <button
                type="button"
                className="ow-collapsed-count"
                onClick={() => void runCmd('block.toggleOpen', { id: row.id })}
              >
                {row.hiddenChildren} collapsed
              </button>
            )}
          </div>
        );
      })}

      {/* One toolbar for the page, not one per block. Rendered inside the map it
          appeared once per block in the document, all of them stacked on the
          same selection. */}
      {textSel && textSel.to > textSel.from && (
        <SelectionToolbar blockId={textSel.id} from={textSel.from} to={textSel.to} run={run} />
      )}
    </div>
  );
}

/**
 * The block-type menu.
 *
 * Rendered as a sibling of the block rather than inside the editable element.
 * Putting focusable UI inside a contenteditable makes the browser do surprising
 * things with selection, and a menu that eats keystrokes is worse than no menu.
 */
/**
 * Viewport rect of a caret at `offset` inside a contenteditable.
 *
 * Built with a Range rather than guessed from the element's box, because a menu
 * anchored to the block opens far below the line being typed on as soon as the
 * query is more than a word long. `getClientRects` on a collapsed range is what
 * browsers expose the caret as; some return an empty list for a collapsed
 * range, hence the fallback that measures the element instead.
 */
/** A DOM element's box, as the plain rect the geometry helpers speak. */
function domRect(el: HTMLElement): BandRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function caretRect(el: HTMLElement, offset: number): DOMRect | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    last = text;
    if (seen + text.length >= offset) {
      const range = document.createRange();
      range.setStart(text, offset - seen);
      range.setEnd(text, offset - seen);
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) return rect;
      break;
    }
    seen += text.length;
    node = walker.nextNode();
  }
  if (!last) return el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : el.getBoundingClientRect();
}

/**
 * Where the slash menu opens: the caret, not the block.
 *
 * Measured on every render rather than stored, because the block scrolls and the
 * window resizes; a rect captured when the menu opened is stale by the time the
 * user has read it. Returns null before the block exists, and the menu then
 * falls back to the block's own corner.
 */
function anchorSlash(menu: HTMLElement | null): DOMRect | null {
  if (!menu) return null;
  const host = menu.closest('.ow-block')?.querySelector<HTMLElement>('.ow-block-text');
  if (!host) return null;
  const text = host.textContent ?? '';
  return caretRect(host, slashStart(text, text.length) ?? text.length);
}

/**
 * Draw a block's runs.
 *
 * Marks become data-attributes rather than inline styles or nested elements, so
 * the stylesheet owns every visual decision and a new mark is a CSS rule rather
 * than a new branch here.
 *
 * A link is rendered as a span rather than an anchor on purpose: an anchor
 * inside a contenteditable swallows the click, so the caret cannot be placed in
 * a linked word at all. The href still reaches the stylesheet for colour and
 * underline, and the command layer holds the real target.
 */
/**
 * What to draw for a block: the draft the user is typing, or the model.
 *
 * When the draft is an append -- the ordinary case of typing at the end of a
 * line -- the model's runs are still correct for everything before the caret, so
 * they are drawn and the new characters are appended as plain text. That keeps
 * the marks visible while typing, which rendering the whole draft as plain text
 * would not.
 *
 * When the draft is an edit in the middle, the run split no longer lines up
 * with the text, so the draft is drawn plain for that keystroke. The marks come
 * back when the model catches up and the draft is dropped.
 */
function renderBlock(
  row: BlockRow,
  draft: { id: string; text: string } | null,
): React.ReactNode {
  const runs = row.runs?.length ? renderRuns(row.runs) : null;
  const base = runs ?? row.text;
  if (!draft || draft.id !== row.id) return base;

  // The draft is what the user has typed, held until the model catches up.
  //
  // "Caught up" means the texts agree. When they do, the model is
  // authoritative, because it holds the markup a draft cannot: a mention, an
  // equation, a tag. A draft that outlived its text would keep the model out
  // of the screen for good.
  if (draft.text === row.text) return base;

  const draftText = draft.text;
  // Appending: the model's runs are still right for everything before the
  // caret, so they are drawn and the new characters follow them.
  //
  // This keeps the element's children stable while typing. React only rewrites
  // a text node's value when the value changes, and rewriting a value leaves
  // the selection alone -- replacing a node does not.
  if (draftText.startsWith(row.text)) {
    const suffix = draftText.slice(row.text.length);
    return suffix ? (
      <>
        {base}
        {suffix}
      </>
    ) : (
      base
    );
  }

  // An edit in the middle: the run split no longer lines up with the text, so
  // the draft is drawn plain for that keystroke. The marks come back when the
  // model catches up.
  return draftText;
}

/**
 * The table-of-contents block.
 *
 * The `toc` type has been in the block registry since the first release and
 * rendered as an ordinary paragraph: you could insert it from the slash menu and
 * nothing happened. This reads the headings out of the rows already in memory
 * rather than re-querying, because the editor is holding the whole page anyway.
 *
 * Entries are buttons that scroll, not anchors. An `href="#id"` needs the target
 * to exist in the URL fragment space and breaks the moment the page is exported;
 * a button plus scrollIntoView works the same offline.
 */
/**
 * The floating toolbar over a text selection.
 *
 * Positioned from the live selection rect on every render rather than stored
 * when the selection began: a rectangle captured at selection time is stale the
 * moment the page scrolls or the window resizes, and a toolbar that has drifted
 * away from its own text is worse than no toolbar.
 *
 * Mounted only when a block is focused, because marks are drawn only then and a
 * toolbar offering to bold something that is not rendered would be a lie.
 */
function SelectionToolbar({
  blockId,
  from,
  to,
  run,
}: {
  blockId: string;
  from: number;
  to: number;
  run: Run;
}) {
  /**
   * Re-measure the selection on every scroll and resize.
   *
   * The rect is state rather than something computed during render, because
   * nothing else changes when the page scrolls: the block id, the offsets and
   * the runs are all identical, so a toolbar that measured on render simply
   * stayed where it was while the text it was labelling moved out from under it.
   * `capture` is needed because the scroll happens on an inner container and
   * scroll events do not bubble from it.
   */
  const [rect, setRect] = useState<DOMRect | null>(null);
  const measure = useCallback(() => {
    const host = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"] .ow-block-text`);
    setRect(host ? caretRect(host, to) : null);
  }, [blockId, to]);

  useEffect(() => {
    measure();
    document.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      document.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  const apply = (command: string, extra: Record<string, unknown> = {}) =>
    void run(command, { id: blockId, from, to, ...extra });

  if (!rect) return null;
  // Flip above the line when there is not enough room below, measured against the
  // toolbar's own height rather than a guessed 40px.
  const above = window.innerHeight - rect.bottom < 56;

  return (
    <div
      className="ow-selbar"
      role="toolbar"
      aria-label="Text formatting"
      style={{
        position: 'fixed',
        left: Math.min(Math.max(rect.left, 8), window.innerWidth - 240),
        top: above ? Math.max(rect.top - 40, 8) : rect.bottom + 8,
      }}
    >
      {(
        [
          ['mark.bold.toggle', 'B', 'Bold', 'ow-selbar-glyph--bold'],
          ['mark.italic.toggle', 'I', 'Italic', 'ow-selbar-glyph--italic'],
          ['mark.strikethrough.toggle', 'S', 'Strikethrough', 'ow-selbar-glyph--strike'],
          ['mark.code.toggle', '<>', 'Code', 'ow-selbar-glyph--code'],
        ] as const
      ).map(([command, glyph, label, cls]) => (
        <button
          key={command}
          type="button"
          className="ow-selbar-btn"
          aria-label={label}
          title={label}
          // mousedown, not click: the browser collapses a selection when a click
          // lands anywhere outside it, so by the time click fires the toolbar
          // has already destroyed the selection it was about to act on.
          onMouseDown={(e) => {
            e.preventDefault();
            apply(command);
          }}
        >
          {/*
            Letterforms, not icons. Four new SVG paths would be new artwork in the
            design system for a toolbar, and a bold B is already exactly what a
            bold B means.
          */}
          <span className={`ow-selbar-glyph ${cls}`} aria-hidden="true">
            {glyph}
          </span>
        </button>
      ))}
      <button
        type="button"
        className="ow-selbar-btn"
        aria-label="Link"
        onMouseDown={(e) => {
          e.preventDefault();
          const href = window.prompt('Link URL (leave empty to remove)', '');
          if (href === null) return;
          apply('mark.link.set', { href });
        }}
      >
        <Icon name="link" size={14} />
      </button>
      <ColorPicker apply={apply} />
    </div>
  );
}

/**
 * The colour control: an "A" with a swatch under it, opening a two-row palette.
 *
 * Two rows because text colour and highlight are separate stored fields and
 * separate CSS attributes, so a single row would have to pick one and the other
 * would stay unreachable. The swatch doubles as the button's own underline, so
 * the control shows the last colour chosen rather than a generic icon.
 *
 * Every swatch acts on mousedown, like the marks beside it: a click outside the
 * selection collapses it before `click` fires.
 */
function ColorPicker({
  apply,
}: {
  apply: (command: string, extra?: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<ColorName>('default');
  const hues: ColorName[] = [
    'default',
    'gray',
    'brown',
    'orange',
    'yellow',
    'green',
    'blue',
    'purple',
    'pink',
    'red',
  ];

  return (
    <div className="ow-selbar-colour">
      <button
        type="button"
        className="ow-selbar-btn ow-selbar-btn--colour"
        aria-label="Colour"
        aria-expanded={open}
        title="Text and highlight colour"
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <span className="ow-selbar-glyph" aria-hidden="true">
          A
        </span>
        <span
          className={`ow-selbar-swatch ow-selbar-swatch--${last}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="ow-selbar-palette" role="group" aria-label="Colour">
          {(['color', 'background'] as const).map((kind) => (
            <div className="ow-selbar-row" key={kind}>
              <span className="ow-selbar-row-label">{kind === 'color' ? 'Text' : 'Fill'}</span>
              {hues.map((hue) => (
                <button
                  key={hue}
                  type="button"
                  className={`ow-selbar-swatch ow-selbar-swatch--${hue}${hue === 'default' ? ' is-default' : ''}`}
                  aria-label={hue}
                  title={hue}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    apply('mark.color.set', { [kind]: hue });
                    if (kind === 'color') setLast(hue);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where the mention picker opens: the `@`, not the end of the line. */
/** Pages whose title contains the query, case-insensitively. */
function matchingPages(pages: { id: string; title: string }[], query: string) {
  const q = query.trim().toLowerCase();
  return q.length === 0 ? pages : pages.filter((p) => p.title.toLowerCase().includes(q));
}

function anchorMention(from: number) {
  return (menu: HTMLElement | null): DOMRect | null => {
    if (!menu) return null;
    const host = menu.closest('.ow-block')?.querySelector<HTMLElement>('.ow-block-text');
    if (!host) return null;
    return caretRect(host, from);
  };
}

/**
 * The `@` page picker.
 *
 * Deliberately the same shape as the slash menu: a listbox positioned at the
 * caret, driven by arrow keys and Enter. Two different interaction models for
 * two things typed at the same place in a line would be a puzzle.
 */
function MentionMenu({
  pages,
  active,
  onHover,
  onPick,
  onDismiss,
  anchor,
}: {
  pages: { id: string; title: string }[];
  active: number;
  onHover: (index: number) => void;
  onPick: (id: string) => void;
  onDismiss: () => void;
  anchor: (host: HTMLElement | null) => DOMRect | null;
}) {
  const selfRef = useRef<HTMLDivElement>(null);
  const rect = anchor(selfRef.current);


  if (pages.length === 0) return null;
  const flip = rect !== null && rect.bottom > window.innerHeight - 280;

  return (
    <div
      ref={selfRef}
      className="ow-slash ow-mention"
      role="listbox"
      aria-label="Link to a page"
      tabIndex={-1}
      style={
        rect
          ? {
              position: 'fixed',
              top: flip ? undefined : rect.bottom + 6,
              bottom: flip ? window.innerHeight - rect.top + 6 : undefined,
              left: Math.min(Math.max(8, rect.left), window.innerWidth - 260),
            }
          : undefined
      }
    >
      {pages.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="option"
          className="ow-slash-item"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(p.id);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="ow-slash-icon">
            <Icon name="mention" size={14} />
          </span>
          <span className="ow-slash-text">
            <span className="ow-slash-label">{p.title || 'Untitled'}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TableOfContents({ rows }: { rows: BlockRow[] }) {
  const LEVEL: Record<string, number> = { heading1: 1, heading2: 2, heading3: 3 };
  const headings = rows
    .filter((r) => LEVEL[r.type] !== undefined)
    .map((r) => ({ id: r.id, text: r.text, level: LEVEL[r.type]! }));

  if (headings.length === 0) {
    // An empty contents list reads as a bug. Say what to do about it.
    return (
      <p className="ow-toc ow-toc--empty">
        No headings yet. Add a heading and it will appear here.
      </p>
    );
  }

  return (
    <nav className="ow-toc" aria-label="Table of contents">
      {headings.map((h) => (
        <button
          key={h.id}
          type="button"
          className="ow-toc-entry"
          data-level={h.level}
          onClick={() => {
            document.querySelector(`[data-block-id="${h.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          {h.text || 'Untitled'}
        </button>
      ))}
    </nav>
  );
}

function renderRuns(runs: import('@ow/model').TextRun[]): React.ReactNode {
  return runs.map((run, i) => {
    // An inline node is drawn as a chip carrying the same characters the model
    // holds, so text search, export and word count all still see what is on
    // screen. Rendering it as something else would make those three disagree
    // with the display.
    if (run.inline) {
      // An equation is drawn as an equation. Showing the LaTeX would be
      // honest about the source and useless to the reader.
      if (run.inline.kind === 'equation') {
        return (
          <span className="ow-inline ow-inline--equation" data-inline="equation" title={run.inline.latex}>
            {renderLatex(run.inline.latex)}
          </span>
        );
      }
      // A tag keeps its hash, because a tag without one reads as a word.
      //
      // The chip shows the run's text and nothing else. The run already holds
      // the hash, and adding one here would make what is on the screen differ
      // from what the model holds -- and the editor compares the two.
      if (run.inline.kind === 'tag') {
        return (
          <span className="ow-inline ow-inline--tag" data-inline="tag">
            {run.text}
          </span>
        );
      }
      return (
        <span
          className="ow-inline ow-inline--"
          data-inline={run.inline.kind}
          data-page-id={run.inline.kind === 'page' ? run.inline.pageId : undefined}
          title={run.inline.kind === 'page' ? 'Linked page' : undefined}
        >
          <Icon name={run.inline.kind === 'page' ? 'page' : 'mention'} size={12} />
          {run.text}
        </span>
      );
    }
    const marks = run.marks ?? [];
    if (marks.length === 0 && !run.link && !run.color && !run.background) {
      return run.text;
    }
    return (
      <span
        key={i}
        data-mark={marks.length > 0 ? marks.join(' ') : undefined}
        data-link={run.link ? 'true' : undefined}
        data-color={run.color}
        data-background={run.background}
        title={run.link?.href}
      >
        {run.text}
      </span>
    );
  });
}

function SlashMenu({
  query,
  anchor,
  onPick,
  onDismiss,
}: {
  query: string;
  anchor: (host: HTMLElement | null) => DOMRect | null;
  onPick: (type: string) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [active, setActive] = useState(0);
  const selfRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  // Generated from the registry, so a block type that exists is reachable from
  // the menu without anyone remembering to add it in a second place.
  const entries = slashEntries().filter(
    (item) =>
      q === '' ||
      item.label.toLowerCase().includes(q) ||
      // Aliases are the point of typing /h1 rather than /heading 1. Matching
      // the label alone made those words decorative.
      item.aliases.some((alias) => alias.toLowerCase().includes(q)),
  );
  // Clamped rather than trusted: deleting characters shrinks the list, and an
  // index past the end would silently pick nothing.
  const index = entries.length === 0 ? 0 : Math.min(active, entries.length - 1);

  // Reset whenever the query changes, so the highlighted row is always a row
  // that exists. Leaving it to the key handler means two places own "which row
  // is highlighted", and they disagree as soon as the list shrinks.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
        return;
      }
      if (entries.length === 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        // Wraps. A list that stops at the ends needs Shift+Arrow to reach the
        // last row, which nobody discovers.
        setActive((n) => (n + step + entries.length) % entries.length);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const picked = entries[index];
        if (picked) void onPick(picked.type);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries, index, onPick, onDismiss]);

  if (entries.length === 0) return null;
  // Fixed positioning against the measured caret rect, flipping above when there
  // is not enough room below. A menu that opens off the bottom of a short
  // window is worse than one anchored to the block.
  const rect = anchor(selfRef.current);
  const flip = rect !== null && rect.bottom > window.innerHeight - 320;
  return (
    <div
      ref={selfRef}
      className="ow-slash"
      role="listbox"
      aria-label="Block type"
      style={
        rect
          ? {
              position: 'fixed',
              top: flip ? undefined : rect.bottom + 6,
              bottom: flip ? window.innerHeight - rect.top + 6 : undefined,
              left: Math.min(rect.left, window.innerWidth - 260),
            }
          : undefined
      }
    >
      {entries.map((item, i) => (
        <button
          key={item.type}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`ow-slash-item${i === index ? ' ow-slash-active' : ''}`}
          // mousedown, not click: the blur from clicking would otherwise close
          // the menu before the click landed.
          onMouseDown={(e) => {
            e.preventDefault();
            void onPick(item.type);
          }}
        >
          <span className="ow-slash-icon">
            <Icon name={BLOCK_ICON[item.type] ?? 'text'} size={14} />
          </span>
          <span className="ow-slash-text">
            <span className="ow-slash-label">{item.label}</span>
            <span className="ow-slash-alias">{item.aliases[0] ? `/${item.aliases[0]}` : ''}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
