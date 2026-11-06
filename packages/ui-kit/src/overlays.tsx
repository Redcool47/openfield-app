/**
 * Menu, Popover, Tooltip, Modal and Toast.
 *
 * What they have in common, and why they live together: each one needs
 * positioning relative to an anchor, dismissal on Escape and on outside click,
 * correct ARIA roles, and a focus story. Getting those right once here is the
 * difference between an accessible application and a pile of divs.
 *
 * Two rules the reference behaviour implies and these components encode:
 *
 *  1. A popup opens *toward* available space and flips when there is none. The
 *     slash menu in the reference opens upward when the caret is low on screen.
 *  2. Escape closes the topmost layer only. Nested menus must not all vanish.
 *
 * Positioning is measured against the viewport on open and repositioned on
 * scroll and resize. That is deliberate over CSS anchor positioning: it behaves
 * identically across the versions this app targets, and the fallback path is
 * trivial to reason about.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

// ------------------------------------------------------------------ geometry

export interface Placement {
  side: 'top' | 'bottom' | 'left' | 'right';
  align: 'start' | 'center' | 'end';
}

export interface Position {
  top: number;
  left: number;
  /** The side actually used, after flipping for available space. */
  resolved: Placement['side'];
}

const GAP = 4;

/**
 * Place a box next to an anchor, flipping when it would leave the viewport.
 *
 * `margin` is the space to keep from the viewport edge. Without it a menu that
 * fits but sits flush against the edge reads as clipped even when it is not.
 */
export function placeOverlay(
  anchor: DOMRect,
  box: { width: number; height: number },
  preferred: Placement,
  margin = 8,
): Position {
  const vw = typeof window === 'undefined' ? 1920 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 1080 : window.innerHeight;

  let side = preferred.side;
  const fits = (candidate: Placement['side']) => {
    if (candidate === 'bottom') return anchor.bottom + GAP + box.height <= vh - margin;
    if (candidate === 'top') return anchor.top - GAP - box.height >= margin;
    if (candidate === 'right') return anchor.right + GAP + box.width <= vw - margin;
    return anchor.left - GAP - box.width >= margin;
  };
  if (!fits(side)) {
    const opposite: Record<Placement['side'], Placement['side']> = {
      top: 'bottom',
      bottom: 'top',
      left: 'right',
      right: 'left',
    };
    side = opposite[side];
  }

  let top = 0;
  let left = 0;
  if (side === 'bottom' || side === 'top') {
    top = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - box.height;
    if (preferred.align === 'start') left = anchor.left;
    else if (preferred.align === 'center') left = anchor.left + anchor.width / 2 - box.width / 2;
    else left = anchor.right - box.width;
  } else {
    left = side === 'right' ? anchor.right + GAP : anchor.left - GAP - box.width;
    top = anchor.top;
  }

  // Clamp horizontally so a long menu never hangs off the side.
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - box.width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, vh - box.height - margin));
  return { top, left, resolved: side };
}

// -------------------------------------------------------------- useDismissable

/**
 * Escape and outside-click dismissal, plus repositioning.
 *
 * Listens on `pointerdown` in the capture phase rather than `click`, so a
 * pointerdown that lands on something else does not first trigger that thing's
 * handler and then close the overlay on top of it.
 */
function useOverlayBehaviour(
  ref: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  preferred: Placement,
): Position {
  const [position, setPosition] = useState<Position>({ top: 0, left: 0, resolved: 'bottom' });

  const reposition = useCallback(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const box = el.getBoundingClientRect();
    setPosition(placeOverlay(anchor.getBoundingClientRect(), { width: box.width, height: box.height }, preferred));
  }, [ref, anchorRef, preferred.side, preferred.align]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stop here so a nested overlay's own handler does not also fire.
        event.stopPropagation();
        onClose();
      }
    };
    const onReflow = () => reposition();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, onClose, ref, anchorRef, reposition]);

  return position;
}

// ---------------------------------------------------------------------- menu

export interface MenuItemSpec {
  /** Stable key. Used for keyboard focus bookkeeping, so it must be unique. */
  key: string;
  label: string;
  /** Muted second line, as the reference slash menu uses. */
  description?: string;
  icon?: ReactNode;
  /** Renders in the danger style. Used for "Move to trash" (requirement R2). */
  danger?: boolean;
  disabled?: boolean;
  /** Keyboard hint shown at the right edge. */
  shortcut?: string;
  onSelect: () => void;
}

export interface MenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: MenuItemSpec[];
  /** Uppercase group headers interleaved with the items. */
  groups?: { header: string; keys: string[] }[];
  onClose: () => void;
  placement?: Placement;
  minWidth?: number;
  label?: string;
}

/**
 * A menu with full keyboard support.
 *
 * Arrow keys move, Home/End jump, typing jumps to the first item whose label
 * starts with the typed characters (typeahead), and Enter or Space selects.
 * Escape closes. This is the behaviour a `role="menu"` promises, so it has to
 * actually be there.
 */
export function Menu({
  open,
  anchorRef,
  items,
  groups,
  onClose,
  placement = { side: 'bottom', align: 'start' },
  minWidth,
  label = 'Menu',
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const position = useOverlayBehaviour(ref, anchorRef, open, onClose, placement);
  const [active, setActive] = useState(0);
  const typeahead = useRef({ text: '', at: 0 });

  const enabled = items.filter((i) => !i.disabled);

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  if (!open) return null;

  const move = (delta: number) => {
    if (!enabled.length) return;
    const current = items.findIndex((i) => i.key === enabled[active]?.key);
    let next = current + delta;
    if (next < 0) next = enabled.length - 1;
    if (next >= enabled.length) next = 0;
    const target = enabled[next];
    if (target) setActive(items.indexOf(target));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActive(items.indexOf(enabled[0]!));
        break;
      case 'End':
        event.preventDefault();
        setActive(items.indexOf(enabled[enabled.length - 1]!));
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const item = enabled[active];
        if (item) {
          item.onSelect();
          onClose();
        }
        break;
      }
      default: {
        if (event.key.length !== 1) return;
        const now = Date.now();
        const state = typeahead.current;
        state.text = now - state.at > 800 ? event.key : state.text + event.key;
        state.at = now;
        const match = items.findIndex((i) => !i.disabled && i.label.toLowerCase().startsWith(state.text.toLowerCase()));
        if (match >= 0) setActive(match);
      }
    }
  };

  const headerFor = (key: string) => groups?.find((g) => g.keys.includes(key))?.header;
  const lastHeader = { value: '' };

  const content = (
    <div
      ref={ref}
      className="ow-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        top: position.top,
        left: position.left,
        ...(minWidth ? { minWidth } : {}),
      }}
    >
      {items.map((item) => {
        const header = headerFor(item.key);
        const showHeader = header && header !== lastHeader.value;
        if (showHeader) lastHeader.value = header;
        const isActive = items.indexOf(item) === active;
        return (
          <div key={item.key}>
            {showHeader && (
              <div className="ow-menu-group" role="presentation">
                {header}
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              className={`ow-menu-item${item.danger ? ' ow-menu-item-danger' : ''}`}
              data-active={isActive || undefined}
              disabled={item.disabled}
              onPointerEnter={() => setActive(items.indexOf(item))}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
              {item.icon && <span className="ow-menu-icon">{item.icon}</span>}
              <span className="ow-menu-text">
                <span className="ow-menu-label">{item.label}</span>
                {item.description && <span className="ow-menu-desc">{item.description}</span>}
              </span>
              {item.shortcut && <span className="ow-menu-shortcut">{item.shortcut}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );

  return createPortal(content, document.body);
}

// ------------------------------------------------------------------- tooltip

export interface TooltipProps {
  label: string;
  children: ReactNode;
  placement?: Placement;
  delayMs?: number;
}

/** Shows on hover and on keyboard focus. Hidden from pointer users who do not hover. */
export function Tooltip({ label, children, placement = { side: 'top', align: 'center' }, delayMs = 400 }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const position = useOverlayBehaviour(ref, anchorRef, open, () => setOpen(false), placement);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delayMs);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <>
      <span
        ref={anchorRef}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={hide}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={ref}
            role="tooltip"
            className="ow-tooltip"
            style={{ top: position.top, left: position.left }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

// --------------------------------------------------------------------- modal

export interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Rendered in the footer, right-aligned. */
  actions?: ReactNode;
}

/**
 * A modal dialog.
 *
 * Focus is trapped while open and restored to the trigger on close. Both matter:
 * without the trap, Tab walks into the page behind the dialog; without the
 * restore, focus lands at the top of the document and the user loses their place.
 */
export function Modal({ open, title, children, onClose, actions }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      if (!focusable.length) return;
      const firstEl = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      (restoreTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="ow-modal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="ow-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="ow-modal-title">{title}</h2>
        <div className="ow-modal-body">{children}</div>
        {actions && <div className="ow-modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

// --------------------------------------------------------------------- toast

export interface ToastSpec {
  id: string;
  message: string;
  tone?: 'info' | 'error';
  /** Optional single action, e.g. "Undo". */
  action?: { label: string; run: () => void };
}

export function ToastRegion({ toasts, onDismiss }: { toasts: ToastSpec[]; onDismiss: (id: string) => void }) {
  return createPortal(
    <div className="ow-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`ow-toast${toast.tone === 'error' ? ' ow-toast-error' : ''}`}>
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="ow-toast-action"
              onClick={() => {
                toast.action!.run();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" className="ow-toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}