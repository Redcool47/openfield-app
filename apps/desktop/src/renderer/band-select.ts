/**
 * Rubber-band block selection and edge autoscroll.
 *
 * Both live here rather than in the editor because the editor is already past
 * the point where another hundred lines help anyone reading it, and because
 * these two are the same idea seen twice: something is being dragged, and while
 * it is being dragged the pointer can ask the page to move.
 *
 * Kept as pure geometry plus one hook, so the "which blocks did that rectangle
 * cover" question -- the part where an off-by-one deletes the wrong blocks --
 * is testable without a browser.
 */

/** A rectangle in viewport coordinates, normalised so width/height are positive. */
export interface BandRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The rectangle between two drag points.
 *
 * Normalised because a drag from bottom-right to top-left is the same rectangle
 * as its reverse, and comparing them raw makes the intersection test fail for
 * exactly half of all drags.
 */
export function bandBetween(ax: number, ay: number, bx: number, by: number): BandRect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

/** Do two rectangles overlap by a meaningful amount? */
export function intersects(a: BandRect, b: BandRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Is this drag a click rather than a band? */
export function isTinyBand(a: BandRect): boolean {
  return a.right - a.left < 4 && a.bottom - a.top < 4;
}

/**
 * A container scrolls when the pointer is within `edge` pixels of its top or
 * bottom, faster the closer it is.
 *
 * Returns the pixel delta for this frame, or 0. The speed ramps rather than
 * jumping to a constant: a constant rate makes the far end of a long page
 * unreachable in one gesture and the near end uncontrollable.
 */
export function autoscrollDelta(pointerY: number, top: number, bottom: number, edge = 48): number {
  const max = 18;
  if (pointerY < top + edge) {
    const closeness = Math.min(1, (top + edge - pointerY) / edge);
    return -Math.max(1, Math.round(max * closeness));
  }
  if (pointerY > bottom - edge) {
    const closeness = Math.min(1, (pointerY - (bottom - edge)) / edge);
    return Math.max(1, Math.round(max * closeness));
  }
  return 0;
}

/**
 * Scroll while a drag is active and the pointer is near an edge.
 *
 * Returns a stop function. The listener is on the window rather than the
 * container because a drag leaves the element it started on -- that is the whole
 * point of a rubber band -- and once the pointer is outside, the container never
 * sees the event at all.
 */
export function startAutoScroll(onFrame: (deltaY: number) => void): () => void {
  let pointerY = 0;
  let active = false;

  const move = (event: MouseEvent) => {
    pointerY = event.clientY;
    active = true;
  };

  const leave = () => {
    active = false;
  };

  const tick = () => {
    if (!active) return;
    const scroller = document.querySelector<HTMLElement>('.ow-page-scroll');
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const delta = autoscrollDelta(pointerY, box.top, box.bottom);
    if (delta !== 0) onFrame(delta);
  };

  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', leave, true);
  window.addEventListener('mouseleave', leave, true);
  const timer = window.setInterval(tick, 40);

  return () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', leave, true);
    window.removeEventListener('mouseleave', leave, true);
    window.clearInterval(timer);
  };
}
