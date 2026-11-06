/**
 * Draw a piece of LaTeX.
 *
 * The parser is in the model, because the text of an equation has to be the
 * same whether it is drawn or stored: the editor compares what is on the
 * screen with what the model holds, and a difference between the two is a
 * difference the editor has to resolve.
 */

import type { ReactNode } from 'react';
import { parseLatex, type LatexNode } from '@ow/model';

function draw(nodes: LatexNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case 'text':
        return <span key={key}>{node.value}</span>;
      case 'symbol':
        return <span key={key} className="ow-math-symbol">{node.value}</span>;
      case 'group':
        return <span key={key}>{draw(node.body, key)}</span>;
      case 'sup':
        return (
          <span key={key}>
            {draw(node.base, key + 'b')}
            <sup>{draw(node.exponent, key + 'e')}</sup>
          </span>
        );
      case 'sub':
        return (
          <span key={key}>
            {draw(node.base, key + 'b')}
            <sub>{draw(node.subscript, key + 's')}</sub>
          </span>
        );
      case 'subsup':
        return (
          <span key={key}>
            {draw(node.base, key + 'b')}
            <sub>{draw(node.subscript, key + 's')}</sub>
            <sup>{draw(node.exponent, key + 'e')}</sup>
          </span>
        );
      case 'frac':
        return (
          <span key={key} className="ow-math-frac">
            <span className="ow-math-frac-top">{draw(node.numerator, key + 'n')}</span>
            <span className="ow-math-frac-bottom">{draw(node.denominator, key + 'd')}</span>
          </span>
        );
      case 'root':
        return (
          <span key={key} className="ow-math-root">
            <span className="ow-math-root-sign">√</span>
            <span className="ow-math-root-body">{draw(node.body, key + 'r')}</span>
          </span>
        );
      default:
        return null;
    }
  });
}

/**
 * Render a piece of LaTeX.
 *
 * The result is a React node, not a string: an equation is markup, and
 * treating it as text is how a note ends up with `x^2` where it meant x
 * squared.
 */
export function renderLatex(latex: string): ReactNode {
  try {
    const nodes = parseLatex(latex);
    return <span className="ow-math">{draw(nodes, 'm')}</span>;
  } catch {
    // A piece of LaTeX this cannot parse is shown as it was written. That is
    // honest, and better than an empty box.
    return <span className="ow-math ow-math--raw">{latex}</span>;
  }
}
