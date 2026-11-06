/**
 * Tests for the text-editing commands and the markdown input triggers.
 *
 * These exist because the editor drives them and a silent failure is invisible:
 * if `block.setText` throws, the contenteditable simply stops accepting text and
 * nothing reports an error anywhere. The trigger tests matter more still, since
 * three of the triggers were wrong before the published shortcut reference
 * arrived -- `>` opened a quote instead of a toggle, `"` opened nothing at all,
 * and the to-do trigger also accepted a spaced form that ate literal text.
 */

import { describe, expect, it } from 'vitest';
import { markdownTriggerMatch, BLOCK_DEFINITIONS } from '@ow/model';

describe('markdown input triggers', () => {
  it('opens a toggle list on ">"', () => {
    // The counter-intuitive one. A greater-than sign reads as a quote to
    // everyone, which is exactly why it is worth a test.
    expect(markdownTriggerMatch('> ')).toBe('toggle');
  });

  it('opens a quote on a double quote', () => {
    expect(markdownTriggerMatch('" ')).toBe('quote');
  });

  it('accepts every documented numbered-list marker', () => {
    // "1.", "a." and "i." all produce a numbered list. Restricting this to "1."
    // means nested lists cannot change numeral style.
    expect(markdownTriggerMatch('1. ')).toBe('numberedListItem');
    expect(markdownTriggerMatch('a. ')).toBe('numberedListItem');
    expect(markdownTriggerMatch('i. ')).toBe('numberedListItem');
  });

  it('uses "[]" for a to-do and not "[ ]"', () => {
    expect(markdownTriggerMatch('[] ')).toBe('todo');
    // The spaced form must NOT trigger: the user typing "[ ] " meant those
    // characters literally, and consuming them is data loss.
    expect(markdownTriggerMatch('[ ] ')).toBeNull();
  });

  it('accepts all three bullet markers', () => {
    for (const marker of ['*', '-', '+']) {
      expect(markdownTriggerMatch(`${marker} `)).toBe('bulletedListItem');
    }
  });

  it('distinguishes the three heading levels', () => {
    expect(markdownTriggerMatch('# ')).toBe('heading1');
    expect(markdownTriggerMatch('## ')).toBe('heading2');
    expect(markdownTriggerMatch('### ')).toBe('heading3');
    // A fourth hash is not a heading; it is text.
    expect(markdownTriggerMatch('#### ')).toBeNull();
  });

  it('only matches at the end of the line', () => {
    // Otherwise "a * b " would turn the whole line into a list.
    expect(markdownTriggerMatch('some text - ')).toBeNull();
    expect(markdownTriggerMatch('- not at the end')).toBeNull();
  });

  it('ignores ordinary prose', () => {
    expect(markdownTriggerMatch('hello ')).toBeNull();
    expect(markdownTriggerMatch('2 > 1 ')).toBeNull();
    expect(markdownTriggerMatch('')).toBeNull();
  });

  it('resolves every trigger to a type the registry defines', () => {
    // A trigger pointing at a type that does not exist would produce a command
    // id with no command behind it.
    const known = new Set(BLOCK_DEFINITIONS.map((d) => d.type));
    for (const prefix of ['> ', '" ', '# ', '## ', '### ', '- ', '* ', '+ ', '1. ', 'a. ', 'i. ', '[] ']) {
      const type = markdownTriggerMatch(prefix);
      if (type) expect(known.has(type)).toBe(true);
    }
  });

  it('every declared trigger is actually reachable', () => {
    // The invariant that matters: no definition may declare a markdown trigger
    // that can never fire. Two ways that happens -- a typo in the pattern, or an
    // earlier definition shadowing it because the first match wins -- and neither
    // shows up as an error anywhere. The user just finds that a trigger they were
    // told about does nothing.
    //
    // Candidates are recovered from the pattern itself rather than hand-written,
    // so adding a definition automatically adds a check and the test cannot drift
    // away from the registry. Alternation is expanded: "[-*+] " is three separate
    // triggers that must all work, and "(?:1|a|i). " likewise. Both have to be
    // enumerated, because a single one of them being shadowed by an earlier
    // definition is exactly the bug this is looking for.
    const unescape = (s: string): string => s.replace(/\\([\s\S])/g, '$1');
    const candidates = (source: string): string[] => {
      const body = source.replace(/^\^/, '').replace(/\$$/, '');
      const group = /\((?:\?:)?([^()]+)\)/.exec(body);
      if (group) {
        const alts = group[1]!.split('|');
        return alts.flatMap((alt) =>
          candidates(body.slice(0, group.index) + alt + body.slice(group.index + group[0].length)),
        );
      }
      // The lookbehind matters: the to-do pattern is `/^\[\] $/`, and a naive
      // `\[...\]` match starts at the *escaped* bracket and produces a candidate
      // of `"\\ "`, which resolves to nothing and fails for the wrong reason.
      const cls = /(?<!\\)\[((?:\\.|[^\]\\])*)\]/.exec(body);
      if (cls) {
        const members = cls[1]!.split('').map(unescape);
        return members.flatMap((m) =>
          candidates(body.slice(0, cls.index) + m + body.slice(cls.index + cls[0].length)),
        );
      }
      return [unescape(body)];
    };

    for (const def of BLOCK_DEFINITIONS) {
      const source = def.markdown?.pattern?.source;
      if (!source) continue;
      for (const literal of candidates(source)) {
        expect(
          markdownTriggerMatch(literal),
          `${def.type} declares "${literal}" but that input resolves to something else`,
        ).toBe(def.type);
      }
    }
  });
});
