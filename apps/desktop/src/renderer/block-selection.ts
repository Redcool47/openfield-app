/**
 * Which blocks a multi-block selection covers.
 *
 * Kept as pure functions over an id list rather than living inside the editor
 * component. Selection is the easiest thing in an editor to get subtly wrong and
 * the hardest to see: a range computed off by one, or reversed, still highlights
 * *something*, so it looks like it works while deleting the wrong block. That is
 * a data-loss bug wearing the costume of a styling bug, and it cannot be caught
 * by looking at the screen.
 *
 * The rules below are the ones worth stating rather than deriving:
 *
 *   - An anchor and a focus, in either order. The user can drag upwards, and a
 *     selection that only works downwards is a selection that surprises someone
 *     exactly when they are rearranging text.
 *   - Range is by document order, never by id. Ids are not sortable -- they are
 *     generated, and in this schema they encode creation time, so two blocks
 *     edited in sequence are out of order relative to how they appear.
 *   - Unknown ids select nothing. A stale id from a row that has just been
 *     deleted must not silently select from the top of the page.
 */

/** Ids in document order. */
export type RowId = string;

/**
 * The ids between `anchorId` and `focusId` inclusive, in document order.
 *
 * Returns an empty array if either id is not present. Selecting everything
 * because one id went stale is the failure this guards against: the next command
 * a user presses would be a delete, and it would take the page with it.
 */
export function blockRange(
  order: readonly RowId[],
  anchorId: RowId,
  focusId: RowId,
): RowId[] {
  const from = order.indexOf(anchorId);
  const to = order.indexOf(focusId);
  if (from === -1 || to === -1) return [];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return order.slice(lo, hi + 1);
}

/** The same range as a Set, for the `includes` check during render. */
export function blockRangeSet(
  order: readonly RowId[],
  anchorId: RowId | null,
  focusId: RowId | null,
): Set<RowId> {
  if (anchorId === null || focusId === null) return new Set();
  return new Set(blockRange(order, anchorId, focusId));
}

/** The endpoints of a selection. A null endpoint means "no selection yet". */
export interface Selection {
  anchor: RowId | null;
  focus: RowId | null;
}

/**
 * Move the focus end of a selection.
 *
 * `extend` false starts a fresh selection on the new block; true keeps the anchor
 * where it is and grows or shrinks the range. Separate because "extend" and
 * "select this one" look identical when the range happens to be a single block,
 * which is exactly the case where guessing wrong resets the user's anchor.
 *
 * Takes the whole selection, null included, because the natural call site is a
 * state updater that has just been handed whatever the current state was -- and
 * that is null on the first click of a session.
 */
export function nextSelection(current: Selection | null, id: RowId, extend: boolean): Selection {
  if (!extend || current?.anchor == null) return { anchor: id, focus: id };
  return { anchor: current.anchor, focus: id };
}

/**
 * Collapse a selection back to a single block.
 *
 * Called when the caret moves by an explicit click, so that clicking away from a
 * selected run does not leave the highlight sitting behind the caret -- which
 * reads as the selection still being live and is not.
 */
export function collapseSelection(_current: Selection | null, id: RowId): Selection {
  return { anchor: id, focus: id };
}