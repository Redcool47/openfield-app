/**
 * The inline syntaxes that turn themselves into something.
 *
 * A block rule turns a line into a different *block*. These turn a piece of a
 * line into a different *thing*: an equation, a tag, a link to another page.
 *
 * They fire on the closing character rather than on a key press, because that
 * is the only moment at which the token is complete. Typing `$` opens nothing
 * and typing the second `$` completes it.
 *
 * The rules live in the model because the editor, the importer and the
 * exporter all have to agree on what the syntax is. A rule that only the
 * editor knew about would be a rule the Markdown files would not carry.
 */

import type { TextRun } from './rich-text.js';

export type InlineRuleId = 'equation' | 'tag' | 'wiki';

export interface InlineRule {
  id: InlineRuleId;
  /**
   * The token, delimiters included.
   *
   * The first group is the value: the latex, the tag name, or the page title.
   */
  pattern: RegExp;
  /**
   * Whether the token must start at a word boundary.
   *
   * A tag does: `C#` is not a tag, and `a#b` is not either. An equation and a
   * wiki link do not: `$x$` inside a word is still an equation.
   */
  boundary?: boolean;
  /**
   * Whether the token is finished by the space after it.
   *
   * A tag is: its name is not finished until the word is, so the tag is
   * recognised when the caret has moved past the space that follows it. An
   * equation and a wiki link are finished by their own closing character.
   */
  afterSpace?: boolean;
}

export const INLINE_RULES: InlineRule[] = [
  { id: 'equation', pattern: /\$([^$\n]+)\$/ },
  { id: 'wiki', pattern: /\[\[([^\][\n]+)\]\]/ },
  { id: 'tag', pattern: /#([A-Za-z][\w/-]*)/, boundary: true, afterSpace: true },
];

export interface InlineMatch {
  id: InlineRuleId;
  /** Where the token starts, and where it ends. */
  from: number;
  to: number;
  /** The value the rule carries: the latex, the tag, the title. */
  value: string;
}

/**
 * The rule whose token ends exactly at the caret.
 *
 * Ending at the caret is the whole test. A token somewhere earlier in the
 * line is not being typed, and a token the caret is in the middle of has not
 * been finished.
 */
export function inlineRuleAt(text: string, caret: number): InlineMatch | null {
  for (const rule of INLINE_RULES) {
    const pattern = new RegExp(rule.pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // A rule that the closing character finishes ends exactly at the caret.
      // A rule that the space after it finishes ends one short of it, with a
      // space in between.
      const finished = rule.afterSpace
        ? end === caret - 1 && /\s/.test(text[end] ?? '')
        : end === caret;
      if (finished) {
        if (rule.boundary) {
          const before = start === 0 ? '' : text[start - 1] ?? '';
          if (before !== '' && !/\s/.test(before)) continue;
        }
        return { id: rule.id, from: start, to: end, value: match[1] ?? '' };
      }
      if (start >= caret) break;
    }
  }
  return null;
}

/**
 * Turn `[[Title]]` text into links to pages.
 *
 * The importer is a pure function with no idea what pages exist, so it leaves
 * the wiki syntax as text and the layer that knows the pages resolves it. The
 * lookup is a callback for exactly that reason: the model does not depend on
 * the storage, and the storage does not depend on the editor.
 *
 * A title that matches no page is left alone. Turning `[[Something]]` into a
 * link to nothing would be worse than leaving it as text, because the text is
 * at least readable.
 */
export function resolveWikiLinks(
  runs: TextRun[],
  lookup: (title: string) => string | undefined,
): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    if (run.inline) {
      out.push(run);
      continue;
    }
    const text = run.text;
    if (!text.includes('[[')) {
      out.push(run);
      continue;
    }
    let last = 0;
    const pattern = /\[\[([^\][\n]+)\]\]/g;
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      const title = (match[1] ?? '').trim();
      const pageId = title.length > 0 ? lookup(title) : undefined;
      if (!pageId) continue;
      if (at > last) out.push({ ...run, text: text.slice(last, at) });
      out.push({ text: match[0], inline: { kind: 'page', pageId, label: title } });
      last = at + match[0].length;
    }
    if (last < text.length) out.push({ ...run, text: text.slice(last) });
    if (last === 0) out.push(run);
  }
  return out;
}
