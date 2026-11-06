/**
 * A small LaTeX parser.
 *
 * Equations are a rendering problem, not a text problem: `x^2` has to be drawn
 * as a superscript, not shown as the characters. A full LaTeX engine is far
 * more than this application needs and far more than it should carry, so
 * this handles the subset that actually appears in notes:
 *
 *   x^2          superscript
 *   x_i          subscript
 *   x_i^2        both
 *   \frac{a}{b}  fraction
 *   \sqrt{x}     square root
 *   \alpha        greek and common symbols
 *   \times \cdot \le \ge \ne \approx \infty \pm \to
 *
 * The parser lives in the model rather than in the interface for one reason:
 * the text of an equation has to be the same whether it is drawn or stored, or
 * the editor's diff between what is on the screen and what the model holds
 * tears the equation apart on the next keystroke. One parser, two consumers:
 * the drawing and the plain text.
 *
 * Anything it does not know is drawn as itself. A note with a piece of LaTeX
 * this cannot render shows the LaTeX, which is honest, rather than showing
 * nothing.
 */

export const LATEX_SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  times: '×',
  div: '÷',
  cdot: '·',
  pm: '±',
  mp: '∓',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  forall: '∀',
  exists: '∃',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  supset: '⊃',
  cup: '∪',
  cap: '∩',
  land: '∧',
  lor: '∨',
  neg: '¬',
  ldots: '…',
  cdots: '⋯',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  sum: '∑',
  prod: '∏',
  int: '∫',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  therefore: '∴',
  because: '∵',
  star: '⋆',
  prime: '′',
  degree: '°',
};

/** One piece of a parsed expression. */
export type LatexNode =
  | { kind: 'text'; value: string }
  | { kind: 'symbol'; value: string }
  | { kind: 'group'; body: LatexNode[] }
  | { kind: 'sup'; base: LatexNode[]; exponent: LatexNode[] }
  | { kind: 'sub'; base: LatexNode[]; subscript: LatexNode[] }
  | { kind: 'subsup'; base: LatexNode[]; subscript: LatexNode[]; exponent: LatexNode[] }
  | { kind: 'frac'; numerator: LatexNode[]; denominator: LatexNode[] }
  | { kind: 'root'; body: LatexNode[] };

class Parser {
  private pos = 0;
  /**
   * Written out rather than as a constructor parameter property, because the
   * CLI runs this TypeScript source directly and Node's type stripping does
   * not support parameter properties.
   */
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): LatexNode[] {
    return this.parseUntil('');
  }

  private parseUntil(closer: string): LatexNode[] {
    const nodes: LatexNode[] = [];
    let text = '';
    const flush = () => {
      if (text.length > 0) {
        nodes.push({ kind: 'text', value: text });
        text = '';
      }
    };

    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]!;

      if (closer && ch === closer) {
        this.pos += 1;
        flush();
        return nodes;
      }

      if (ch === '{') {
        flush();
        this.pos += 1;
        const body = this.parseUntil('}');
        nodes.push({ kind: 'group', body });
        this.continueWithScripts(nodes);
        continue;
      }

      if (ch === '\\') {
        flush();
        const command = this.readCommand();
        if (command === 'frac') {
          const numerator = this.readGroup();
          const denominator = this.readGroup();
          nodes.push({ kind: 'frac', numerator, denominator });
        } else if (command === 'sqrt') {
          const body = this.readGroup();
          nodes.push({ kind: 'root', body });
        } else {
          nodes.push({ kind: 'symbol', value: LATEX_SYMBOLS[command] ?? command });
        }
        continue;
      }

      if (ch === '^' || ch === '_') {
        flush();
        // The caret of the script is consumed here, so the group that follows
        // is the script and not the caret itself.
        this.pos += 1;
        const script = this.readGroup();
        // A node that already carries a script gets the second one added to
        // it: `x_i^2` is one base with a subscript and a superscript, not a
        // superscript on a subscript.
        const previous = nodes[nodes.length - 1];
        if (previous && previous.kind === 'sub' && ch === '^') {
          nodes[nodes.length - 1] = {
            kind: 'subsup',
            base: previous.base,
            subscript: previous.subscript,
            exponent: script,
          };
          continue;
        }
        if (previous && previous.kind === 'sup' && ch === '_') {
          nodes[nodes.length - 1] = {
            kind: 'subsup',
            base: previous.base,
            subscript: script,
            exponent: previous.exponent,
          };
          continue;
        }
        const base = this.takeBase(nodes);
        if (ch === '^') {
          nodes.push({ kind: 'sup', base, exponent: script });
        } else {
          nodes.push({ kind: 'sub', base, subscript: script });
        }
        continue;
      }

      if (ch === ' ') {
        // A space in LaTeX is a separator, not a character.
        this.pos += 1;
        continue;
      }

      text += ch;
      this.pos += 1;
    }

    flush();
    return nodes;
  }

  /**
   * Attach a script to the node before it.
   *
   * `x_i^2` is a subscript and a superscript on the same base, and the second
   * one has to find the first rather than start a new base.
   */
  private continueWithScripts(nodes: LatexNode[]): void {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]!;
      if (ch !== '^' && ch !== '_') return;
      this.pos += 1;
      const script = this.readGroup();
      const base = this.takeBase(nodes);
      const last = nodes[nodes.length - 1];
      if (last && last.kind === 'sub' && ch === '^') {
        nodes[nodes.length - 1] = {
          kind: 'subsup',
          base: last.base,
          subscript: last.subscript,
          exponent: script,
        };
      } else if (last && last.kind === 'sup' && ch === '_') {
        nodes[nodes.length - 1] = {
          kind: 'subsup',
          base: last.base,
          subscript: script,
          exponent: last.exponent,
        };
      } else if (ch === '^') {
        nodes.push({ kind: 'sup', base, exponent: script });
      } else {
        nodes.push({ kind: 'sub', base, subscript: script });
      }
    }
  }

  /** The node a script attaches to: the last one, or an empty base. */
  private takeBase(nodes: LatexNode[]): LatexNode[] {
    const last = nodes[nodes.length - 1];
    if (!last) return [];
    nodes.pop();
    if (last.kind === 'text') return [{ kind: 'text', value: last.value }];
    return [last];
  }

  private readCommand(): string {
    this.pos += 1; // the backslash
    let name = '';
    while (this.pos < this.source.length && /[A-Za-z]/.test(this.source[this.pos]!)) {
      name += this.source[this.pos];
      this.pos += 1;
    }
    return name;
  }

  /** A group in braces, or a single character. */
  private readGroup(): LatexNode[] {
    while (this.pos < this.source.length && this.source[this.pos] === ' ') this.pos += 1;
    if (this.source[this.pos] === '{') {
      this.pos += 1;
      return this.parseUntil('}');
    }
    const ch = this.source[this.pos];
    if (ch === undefined) return [];
    this.pos += 1;
    return [{ kind: 'text', value: ch }];
  }
}

/** Parse a piece of LaTeX into a tree. */
export function parseLatex(latex: string): LatexNode[] {
  return new Parser(latex).parse();
}

/**
 * The text of a parsed expression.
 *
 * Exactly the characters the drawing produces, and no more. The editor
 * compares what is on the screen with what the model holds, and a difference
 * between the two is a difference the editor has to resolve -- so they have
 * to be the same string.
 */
export function latexToText(nodes: LatexNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'symbol':
        out += node.value;
        break;
      case 'group':
        out += latexToText(node.body);
        break;
      case 'sup':
        out += latexToText(node.base) + latexToText(node.exponent);
        break;
      case 'sub':
        out += latexToText(node.base) + latexToText(node.subscript);
        break;
      case 'subsup':
        out += latexToText(node.base) + latexToText(node.subscript) + latexToText(node.exponent);
        break;
      case 'frac':
        out += latexToText(node.numerator) + latexToText(node.denominator);
        break;
      case 'root':
        // The sign is drawn, so it is part of the text.
        out += '√' + latexToText(node.body);
        break;
      default:
        break;
    }
  }
  return out;
}

/** The text of a piece of LaTeX, as the drawing shows it. */
export function latexText(latex: string): string {
  return latexToText(parseLatex(latex));
}

/**
 * The smallest edit that turns one text into another.
 *
 * The editor sends the whole text of a block, and the model has to work out
 * what changed so that the inline nodes outside the change survive. Replacing
 * the whole content would delete every mention, equation and tag in the
 * block on the next keystroke, which is what it used to do.
 */
export interface TextEdit {
  /** Where the change starts, in the old text and in the new one. */
  from: number;
  /** Where it ends, in the old text. */
  to: number;
  /** The text that goes there. */
  value: string;
}

export function diffText(oldText: string, nextText: string): TextEdit {
  const max = Math.min(oldText.length, nextText.length);
  let from = 0;
  while (from < max && oldText[from] === nextText[from]) from += 1;
  let back = 0;
  while (back < max - from && oldText[oldText.length - 1 - back] === nextText[nextText.length - 1 - back]) {
    back += 1;
  }
  return {
    from,
    to: oldText.length - back,
    value: nextText.slice(from, nextText.length - back),
  };
}
