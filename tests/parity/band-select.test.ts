/**
 * Rubber-band block selection, and edge autoscroll while anything is dragged.
 *
 * The geometry helpers are pure and unit-tested in band-select.test.ts; this
 * file is only the DOM plumbing that feeds them.
 */

import { describe, expect, it } from 'vitest';
import { autoscrollDelta, bandBetween, intersects, isTinyBand } from '../../apps/desktop/src/renderer/band-select';

describe('bandBetween', () => {
  it('normalises a drag made upwards and leftwards', () => {
    // A drag from bottom-right to top-left covers the same rectangle as its
    // reverse. Compared raw, half of all drags would test as no overlap and
    // silently select nothing.
    const up = bandBetween(300, 400, 100, 50);
    expect(up).toEqual({ left: 100, top: 50, right: 300, bottom: 400 });
    expect(up.right - up.left).toBe(200);
    expect(up.bottom - up.top).toBe(350);
  });

  it('is the same rectangle whichever way it was drawn', () => {
    expect(bandBetween(10, 20, 110, 220)).toEqual(bandBetween(110, 220, 10, 20));
  });
});

describe('intersects', () => {
  const box = bandBetween(0, 0, 100, 100);

  it('is true when the rectangles overlap', () => {
    expect(intersects(box, bandBetween(50, 50, 150, 150))).toBe(true);
    expect(intersects(box, bandBetween(10, 10, 20, 20))).toBe(true);
  });

  it('is false for touching edges, not merely adjacent', () => {
    // Sharing an edge is not covering a block. Including it would select a
    // block the user dragged past but did not reach.
    expect(intersects(box, bandBetween(100, 0, 200, 100))).toBe(false);
    expect(intersects(box, bandBetween(-100, 0, 0, 100))).toBe(false);
  });

  it('is false when one rectangle contains nothing of the other', () => {
    expect(intersects(box, bandBetween(200, 200, 300, 300))).toBe(false);
  });
});

describe('isTinyBand', () => {
  it('treats a stationary press as a click', () => {
    // Every mousedown starts a band. Without this, clicking a block's margin
    // would select everything between there and the pointer's resting place.
    expect(isTinyBand(bandBetween(100, 100, 102, 101))).toBe(true);
    expect(isTinyBand(bandBetween(100, 100, 130, 120))).toBe(false);
  });
});

describe('autoscrollDelta', () => {
  const top = 0;
  const bottom = 600;

  it('is zero away from both edges', () => {
    expect(autoscrollDelta(300, top, bottom)).toBe(0);
    expect(autoscrollDelta(60, top, bottom)).toBe(0);
    expect(autoscrollDelta(540, top, bottom)).toBe(0);
  });

  it('scrolls up near the top and down near the bottom', () => {
    expect(autoscrollDelta(4, top, bottom)).toBeLessThan(0);
    expect(autoscrollDelta(596, top, bottom)).toBeGreaterThan(0);
  });

  it('ramps with closeness rather than jumping to a constant', () => {
    // A constant rate makes the far end of a long page unreachable in one
    // gesture and the near end uncontrollable.
    const near = Math.abs(autoscrollDelta(2, top, bottom));
    const mid = Math.abs(autoscrollDelta(24, top, bottom));
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
  });

  it('never returns a fractional or zero-length step', () => {
    // scrollBy with a sub-pixel delta is a no-op that looks like a hang.
    for (let y = 0; y <= 600; y += 7) {
      expect(Number.isInteger(autoscrollDelta(y, top, bottom))).toBe(true);
    }
  });
});
