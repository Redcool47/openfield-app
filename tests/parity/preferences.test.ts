/**
 * Appearance preferences.
 *
 * The validation matters more than the happy path. Every field here is read out
 * of localStorage on launch, so a value written by an older build, or a
 * half-written one, has to fall back on its own rather than reaching a component
 * that knows nothing about preferences. That is why `normalise` is a pure
 * exported function instead of being buried inside `readFromStorage`.
 */

import { describe, expect, it } from 'vitest';
import { ACCENTS, appearanceVars, normalise, resolveTheme, SIDEBAR_MAX, SIDEBAR_MIN } from '../../apps/desktop/src/renderer/preferences';

describe('preferences.normalise', () => {
  it('falls back to the documented defaults for an empty object', () => {
    const p = normalise({});
    expect(p.theme).toBe('light');
    expect(p.textSize).toBe('medium');
    expect(p.contentWidth).toBe('medium');
    expect(p.zoom).toBe(100);
  });

  it('survives a value that is not an object at all', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      expect(normalise(junk).theme).toBe('light');
    }
  });

  it('rejects a theme this build does not know', () => {
    // An older build must still open when a newer one wrote 'sepia' here.
    expect(normalise({ theme: 'sepia' }).theme).toBe('light');
    expect(normalise({ theme: 'dark' }).theme).toBe('dark');
  });

  it('keeps a missing sidebarOpen distinct from an explicit false', () => {
    expect(normalise({}).sidebarOpen).toBe(true);
    expect(normalise({ sidebarOpen: false }).sidebarOpen).toBe(false);
  });

  it('rejects a colour that is not six hex digits', () => {
    // A free-form string here becomes a CSS colour, so 'url(...)' and '}' are
    // both a styling bug and an injection point.
    expect(normalise({ accent: 'red' }).accent).toBe('3b82f6');
    expect(normalise({ accent: 'ffffff; background: url(x)' }).accent).toBe('3b82f6');
    expect(normalise({ accent: '#3b82f6' }).accent).toBe('3b82f6');
    expect(normalise({ accent: 'AABBCC' }).accent).toBe('aabbcc');
  });

  it('clamps zoom rather than rejecting it', () => {
    expect(normalise({ zoom: 5000 }).zoom).toBe(200);
    expect(normalise({ zoom: -20 }).zoom).toBe(50);
    expect(normalise({ zoom: 137 }).zoom).toBe(137);
    expect(normalise({ zoom: Number.NaN }).zoom).toBe(100);
  });

  it('only accepts the named text sizes and widths', () => {
    expect(normalise({ textSize: 'huge' }).textSize).toBe('medium');
    expect(normalise({ textSize: 'large' }).textSize).toBe('large');
    expect(normalise({ contentWidth: 'infinite' }).contentWidth).toBe('medium');
    expect(normalise({ contentWidth: 'full' }).contentWidth).toBe('full');
  });
});

describe('preferences.appearanceVars', () => {
  it('emits the CSS custom properties the stylesheet reads', () => {
    const vars = appearanceVars(normalise({ accent: '0d9488', zoom: 150, contentWidth: 'wide' }));
    expect(vars['--ow-accent']).toBe('#0d9488');
    expect(vars['--ow-content-width']).toBe('1000px');
    expect(vars['--ow-zoom']).toBe('1.5');
  });

  it('gives every offered accent a value the validator accepts', () => {
    // Otherwise a swatch appears in the picker and clicking it does nothing,
    // because normalise throws the value away on the way back in.
    for (const a of ACCENTS) {
      expect(normalise({ accent: a.value }).accent).toBe(a.value);
    }
  });

  it('has distinct accents, so the picker is not five identical chips', () => {
    expect(new Set(ACCENTS.map((a) => a.value)).size).toBe(ACCENTS.length);
  });

  it('scales text but not the whole interface', () => {
    expect(appearanceVars(normalise({ textSize: 'large' }))['--ow-scale']).toBe('1.1');
    expect(appearanceVars(normalise({ textSize: 'small' }))['--ow-scale']).toBe('0.925');
    expect(appearanceVars(normalise({ textSize: 'medium' }))['--ow-scale']).toBe('1');
  });
});

describe('preferences.resolveTheme', () => {
  it('resolves system against the machine and leaves an explicit choice alone', () => {
    expect(resolveTheme('system', { matches: true })).toBe('dark');
    expect(resolveTheme('system', { matches: false })).toBe('light');
    expect(resolveTheme('light', { matches: true })).toBe('light');
    expect(resolveTheme('dark', { matches: false })).toBe('dark');
  });

  it('defaults to light when the query is unavailable', () => {
    // Falling back to dark here would open the app dark on a machine that
    // cannot be queried, which is the exact failure light-as-default avoids.
    expect(resolveTheme('system', undefined)).toBe('light');
  });
});
describe('sidebar width', () => {
  it('clamps a stored width to the range the drag allows', () => {
    // A width outside the range is a stale one, and honouring it either hides
    // the editor or leaves the sidebar wider than the window.
    expect(normalise({ sidebarWidth: 10 }).sidebarWidth).toBe(SIDEBAR_MIN);
    expect(normalise({ sidebarWidth: 9999 }).sidebarWidth).toBe(SIDEBAR_MAX);
    expect(normalise({ sidebarWidth: 320 }).sidebarWidth).toBe(320);
    expect(normalise({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(260);
  });
});
