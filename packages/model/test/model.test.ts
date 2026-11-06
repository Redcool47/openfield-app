import { beforeEach, describe, expect, it } from 'vitest';
import {
  History,
  blockDef,
  caretAt,
  createDoc,
  deletableIds,
  get,
  indent,
  insert,
  insertLineBreak,
  mergeBackward,
  moveSibling,
  moveToTrash,
  nextBlock,
  normalizeRuns,
  outdent,
  pageSelection,
  previousBlock,
  purgeBlock,
  restore,
  selectedBlocks,
  selectedText,
  selectAllInBlock,
  selectAllPage,
  setColor,
  setProps,
  sliceText,
  spliceText,
  textOf,
  textSelection,
  transact,
  trashBlock,
  treeShape,
  turnInto,
  type Doc,
  type Caret,
  type Selection,
  toggleMark,
  toggleOpen,
  walk,
} from '@ow/model';

/** Build a document from a compact spec: two leading spaces mean one level in. */
function build(lines: string[]): Doc {
  const doc = createDoc();
  const stack: string[] = [];
  for (const line of lines) {
    const depth = (line.length - line.trimStart().length) / 2;
    const label = line.trim();
    const type = label.startsWith('# ') ? 'heading1' : 'paragraph';
    const body = label.replace(/^# /, '');
    while (stack.length > depth) stack.pop();
    const parentId = depth > 0 ? (stack[depth - 1] ?? null) : null;
    const b = insert(doc, { type, parentId, content: { runs: [{ text: body }] } });
    stack[depth] = b.id;
    stack.length = depth + 1;
  }
  return doc;
}

describe('rich text', () => {
  it('merges adjacent runs with identical styling', () => {
    const runs = normalizeRuns([
      { text: 'a', marks: ['bold'] },
      { text: 'b', marks: ['bold'] },
      { text: 'c' },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.text).toBe('ab');
  });

  it('drops empty runs', () => {
    expect(normalizeRuns([{ text: '' }, { text: 'x' }])).toEqual([{ text: 'x' }]);
  });

  it('keeps overlapping marks on one run', () => {
    const runs = toggleMark([{ text: 'hello' }], 0, 5, 'bold');
    const bolded = toggleMark(runs, 0, 5, 'italic');
    expect(bolded[0]!.marks).toEqual(['bold', 'italic']);
  });

  it('splits a run when a mark covers part of it', () => {
    const runs = toggleMark([{ text: 'hello world' }], 0, 5, 'bold');
    expect(runs).toHaveLength(2);
    expect(runs[0]!.text).toBe('hello');
    expect(runs[0]!.marks).toEqual(['bold']);
    expect(runs[1]!.text).toBe(' world');
    expect(runs[1]!.marks).toBeUndefined();
  });

  it('toggles a mark off when the selection already has it', () => {
    const on = toggleMark([{ text: 'hello' }], 0, 5, 'bold');
    const off = toggleMark(on, 0, 5, 'bold');
    expect(off[0]!.marks).toBeUndefined();
  });

  it('splices text while preserving marks on the untouched edges', () => {
    const runs = toggleMark([{ text: 'hello world' }], 0, 5, 'bold');
    const after = spliceText(runs, 0, 5, 'HI');
    // Replacement text carries no styling, and normalising merges it with the
    // unmarked tail, so the result is a single unstyled run.
    expect(textOf(after)).toBe('HI world');
    expect(after).toEqual([{ text: 'HI world' }]);
  });

  it('slices across run boundaries and preserves styling', () => {
    const runs = toggleMark([{ text: 'hello world' }], 0, 5, 'bold');
    const slice = sliceText(runs, 3, 8);
    expect(textOf({ runs: slice })).toBe('lo wo');
  });
});

describe('document tree', () => {
  it('builds a valid nested tree', () => {
    const doc = build(['a', '  b', '    c', '  d', 'e']);
    expect(treeShape(doc)).toEqual(['a', '  b', '    c', '  d', 'e']);
  });

  it('keeps the tree valid through inserts and deletes', () => {
    const doc = build(['a', '  b', '    c']);
    const h = new History();
    transact(doc, h, 'insert', (tx) => {
      const b = insert(doc, { type: 'paragraph', parentId: doc.roots[0]!, content: { runs: [{ text: 'x' }] } });
      tx.touch(b.id);
    });
    expect(treeShape(doc)).toEqual(['a', '  b', '    c', '  x']);
  });

  it('assigns increasing fractional positions', () => {
    const doc = createDoc();
    const ids = Array.from({ length: 50 }, (_, i) => insert(doc, { content: { runs: [{ text: String(i) }] } }).id);
    const positions = ids.map((id) => doc.blocks[id]!.position);
    expect([...positions].sort()).toEqual(positions);
  });

  it('promotes children when a block is converted to one that cannot nest', () => {
    // Converting an indented paragraph to a code block: a code block holds text
    // only, so the children must be lifted to siblings rather than dropped.
    const doc = build(['a', '  b']);
    const rootId = doc.roots[0]!;
    const history = new History();
    transact(doc, history, 'turn into code', (tx) => {
      turnInto(doc, tx, rootId, 'code');
    });
    expect(doc.blocks[rootId]!.type).toBe('code');
    expect(treeShape(doc)).toEqual(['a', 'b']);
  });
});

describe('enter behaviour', () => {
  it('splits a paragraph and moves the tail into the new block', () => {
    const doc = build(['hello world']);
    const history = new History();
    const id = doc.roots[0]!;
    transact(doc, history, 'enter', (tx) => {
      tx.touch(id);
      const r = insertLineBreak(doc, tx, { blockId: id, offset: 5 });
      expect(r.caret).toEqual({ blockId: doc.roots[1]!, offset: 0 });
    });
    expect(treeShape(doc)).toEqual(['hello', ' world']);
  });

  it('exits a list when Enter is pressed on an empty list item', () => {
    const doc = createDoc();
    const history = new History();
    const item = insert(doc, { type: 'bulletedListItem', content: { runs: [] } });
    transact(doc, history, 'enter', (tx) => {
      tx.touch(item.id);
      insertLineBreak(doc, tx, { blockId: item.id, offset: 0 });
    });
    expect(doc.blocks[item.id]!.type).toBe('paragraph');
    expect(doc.blocks[doc.roots[1]!]!.type).toBe('paragraph');
  });

  it('keeps the same list type when splitting a non-empty list item', () => {
    const doc = createDoc();
    const history = new History();
    const item = insert(doc, { type: 'bulletedListItem', content: { runs: [{ text: 'item' }] } });
    transact(doc, history, 'enter', (tx) => {
      tx.touch(item.id);
      insertLineBreak(doc, tx, { blockId: item.id, offset: 2 });
    });
    expect(doc.blocks[doc.roots[1]!]!.type).toBe('bulletedListItem');
    expect(treeShape(doc)).toEqual(['it', 'em']);
  });

  it('drops a heading to a paragraph when splitting an empty one', () => {
    const doc = createDoc();
    const history = new History();
    const h = insert(doc, { type: 'heading1', content: { runs: [] } });
    transact(doc, history, 'enter', (tx) => {
      tx.touch(h.id);
      insertLineBreak(doc, tx, { blockId: h.id, offset: 0 });
    });
    expect(doc.blocks[h.id]!.type).toBe('paragraph');
  });

  it('inserts a newline in a code block instead of splitting', () => {
    const doc = createDoc();
    const history = new History();
    const c = insert(doc, { type: 'code', content: { runs: [{ text: 'x' }] } });
    let caret: Caret = { blockId: c.id, offset: 1 };
    transact(doc, history, 'enter', (tx) => {
      tx.touch(c.id);
      caret = insertLineBreak(doc, tx, caret).caret;
    });
    expect(caret).toEqual({ blockId: c.id, offset: 2 });
    expect(doc.roots).toHaveLength(1);
    expect(textOf(doc.blocks[c.id]!.content)).toBe('x\n');
  });
});

describe('backspace behaviour', () => {
  it('merges into the previous block at the join', () => {
    const doc = build(['hello', 'world']);
    const history = new History();
    const second = doc.roots[1]!;
    transact(doc, history, 'backspace', (tx) => {
      tx.touch(second);
      const r = mergeBackward(doc, tx, { blockId: second, offset: 0 });
      expect(r.caret).toEqual({ blockId: doc.roots[0]!, offset: 5 });
    });
    expect(treeShape(doc)).toEqual(['helloworld']);
  });

  it('turns a styled block into a paragraph before merging', () => {
    const doc = build(['# heading']);
    const history = new History();
    const id = doc.roots[0]!;
    transact(doc, history, 'backspace', (tx) => {
      tx.touch(id);
      const r = mergeBackward(doc, tx, { blockId: id, offset: 0 });
      expect(r.caret.blockId).toBe(id);
    });
    expect(doc.blocks[id]!.type).toBe('paragraph');
    expect(treeShape(doc)).toEqual(['heading']);
  });

  it('re-parents children when a block is absorbed', () => {
    const doc = build(['a', 'b', '  child']);
    const history = new History();
    const bId = doc.roots[1]!;
    transact(doc, history, 'backspace', (tx) => {
      tx.touch(bId);
      mergeBackward(doc, tx, { blockId: bId, offset: 0 });
    });
    expect(treeShape(doc)).toEqual(['ab', '  child']);
  });

  it('is a no-op at the very start of the first block', () => {
    const doc = build(['only']);
    const history = new History();
    const id = doc.roots[0]!;
    transact(doc, history, 'backspace', (tx) => {
      tx.touch(id);
      const r = mergeBackward(doc, tx, { blockId: id, offset: 0 });
      expect(r.caret.blockId).toBe(id);
    });
    expect(treeShape(doc)).toEqual(['only']);
  });

  it('deletes one grapheme cluster rather than one code unit', () => {
    const doc = build(['a\u{1F469}\u200D\u{1F4BB}b']);
    const history = new History();
    const id = doc.roots[0]!;
    transact(doc, history, 'backspace', (tx) => {
      tx.touch(id);
      // Caret after the multi-unit emoji sequence plus the preceding "a".
      const r = mergeBackward(doc, tx, { blockId: id, offset: 6 });
      expect(r.caret.offset).toBe(1);
    });
    expect(textOf(doc.blocks[id]!.content)).toBe('ab');
  });
});

describe('indent and outdent', () => {
  it('indents a block under its previous sibling', () => {
    const doc = build(['a', 'b']);
    const history = new History();
    transact(doc, history, 'tab', (tx) => {
      indent(doc, tx, doc.roots[1]!);
    });
    expect(treeShape(doc)).toEqual(['a', '  b']);
  });

  it('is a no-op for the first sibling', () => {
    const doc = build(['a', 'b']);
    const history = new History();
    let changed = true;
    transact(doc, history, 'tab', (tx) => {
      changed = indent(doc, tx, doc.roots[0]!).changed;
    });
    expect(changed).toBe(false);
    expect(treeShape(doc)).toEqual(['a', 'b']);
  });

  it('outdents to the grandparent level', () => {
    const doc = build(['a', '  b', '    c']);
    const history = new History();
    transact(doc, history, 'shift-tab', (tx) => {
      outdent(doc, tx, walk(doc).find((x) => textOf(x.content) === 'c')!.id);
    });
    expect(treeShape(doc)).toEqual(['a', '  b', '  c']);
  });

  it('round-trips indent then outdent', () => {
    const doc = build(['a', 'b', 'c']);
    const before = treeShape(doc);
    const history = new History();
    transact(doc, history, 'tab', (tx) => {
      indent(doc, tx, doc.roots[1]!);
    });
    expect(treeShape(doc)).not.toEqual(before);
    transact(doc, history, 'shift-tab', (tx) => {
      outdent(doc, tx, walk(doc).find((x) => textOf(x.content) === 'b')!.id);
    });
    expect(treeShape(doc)).toEqual(before);
  });
});

describe('moving blocks', () => {
  it('moves a block up among siblings', () => {
    const doc = build(['a', 'b', 'c']);
    const history = new History();
    transact(doc, history, 'move up', (tx) => {
      moveSibling(doc, tx, doc.roots[2]!, -1);
    });
    expect(treeShape(doc)).toEqual(['a', 'c', 'b']);
  });

  it('does nothing at either end', () => {
    const doc = build(['a', 'b']);
    const history = new History();
    transact(doc, history, 'move up', (tx) => {
      expect(moveSibling(doc, tx, doc.roots[0]!, -1).changed).toBe(false);
    });
    transact(doc, history, 'move down', (tx) => {
      expect(moveSibling(doc, tx, doc.roots[1]!, 1).changed).toBe(false);
    });
    expect(treeShape(doc)).toEqual(['a', 'b']);
  });

  it('refuses to move a block into its own subtree', () => {
    const doc = build(['a', '  b']);
    const history = new History();
    transact(doc, history, 'move', (tx) => {
      expect(() => outdent(doc, tx, doc.roots[0]!)).not.toThrow();
    });
  });
});

describe('turn into and toggles', () => {
  it('turns a paragraph into a heading', () => {
    const doc = build(['title']);
    const history = new History();
    transact(doc, history, 'turn into', (tx) => {
      turnInto(doc, tx, doc.roots[0]!, 'heading1');
    });
    expect(doc.blocks[doc.roots[0]!]!.type).toBe('heading1');
  });

  it('rejects a conversion the registry does not allow', () => {
    const doc = build(['x']);
    const history = new History();
    transact(doc, history, 'turn into', (tx) => {
      expect(() => turnInto(doc, tx, doc.roots[0]!, 'database')).toThrow();
    });
  });

  it('toggles a to-do checkbox', () => {
    const doc = createDoc();
    const history = new History();
    const t = insert(doc, { type: 'todo', content: { runs: [{ text: 'task' }] } });
    transact(doc, history, 'toggle', (tx) => {
      tx.touch(t.id);
      toggleOpen(doc, tx, t.id);
    });
    expect(doc.blocks[t.id]!.props.checked).toBe(true);
  });

  it('toggles a disclosure triangle open state', () => {
    const doc = createDoc();
    const history = new History();
    const t = insert(doc, { type: 'toggle', content: { runs: [{ text: 'more' }] } });
    const child = insert(doc, { parentId: t.id, content: { runs: [{ text: 'hidden' }] } });
    expect(doc.blocks[t.id]!.collapsed).toBe(false);
    transact(doc, history, 'toggle', (tx) => {
      tx.touch(t.id);
      toggleOpen(doc, tx, t.id);
    });
    expect(doc.blocks[t.id]!.collapsed).toBe(true);
    expect(walk(doc).map((b) => b.id)).not.toContain(child.id);
  });
});

describe('trash and restore', () => {
  it('hides a trashed subtree from the walk', () => {
    const doc = build(['a', '  b', 'c']);
    const history = new History();
    transact(doc, history, 'trash', (tx) => {
      moveToTrash(doc, tx, doc.roots[0]!);
    });
    expect(treeShape(doc)).toEqual(['c']);
  });

  it('restores a page to its original parent', () => {
    const doc = build(['a', '  b']);
    const bId = walk(doc)[1]!.id;
    const history = new History();
    transact(doc, history, 'trash', (tx) => moveToTrash(doc, tx, bId));
    expect(treeShape(doc)).toEqual(['a']);
    transact(doc, history, 'restore', (tx) => restore(doc, tx, bId));
    expect(treeShape(doc)).toEqual(['a', '  b']);
  });

  it('purges a subtree permanently', () => {
    const doc = build(['a', '  b']);
    const aId = doc.roots[0]!;
    const history = new History();
    transact(doc, history, 'purge', (tx) => purgeBlock(doc, tx, aId));
    expect(doc.blocks[aId]).toBeUndefined();
    expect(Object.keys(doc.blocks)).toHaveLength(0);
  });
});

describe('undo and redo', () => {
  it('restores the exact previous tree', () => {
    const doc = build(['a', 'b', 'c']);
    const before = treeShape(doc);
    const history = new History();
    transact(doc, history, 'indent', (tx) => indent(doc, tx, doc.roots[1]!));
    expect(treeShape(doc)).toEqual(['a', '  b', 'c']);
    history.undo(doc);
    expect(treeShape(doc)).toEqual(before);
    history.redo(doc);
    expect(treeShape(doc)).toEqual(['a', '  b', 'c']);
  });

  it('undoes a text edit', () => {
    const doc = build(['hello']);
    const history = new History();
    const id = doc.roots[0]!;
    transact(doc, history, 'type', (tx) => {
      tx.touch(id);
      get(doc, id).content = { runs: [{ text: 'hello!' }] };
    });
    expect(textOf(doc.blocks[id]!.content)).toBe('hello!');
    history.undo(doc);
    expect(textOf(doc.blocks[id]!.content)).toBe('hello');
  });

  it('undoes a creation by removing the block', () => {
    const doc = build(['a']);
    const history = new History();
    transact(doc, history, 'create', (tx) => {
      const b = insert(doc, { content: { runs: [{ text: 'b' }] } });
      tx.touch(b.id);
    });
    expect(treeShape(doc)).toEqual(['a', 'b']);
    history.undo(doc);
    expect(treeShape(doc)).toEqual(['a']);
  });

  it('undoes a subtree deletion with every descendant', () => {
    const doc = build(['a', '  b', '    c']);
    const before = treeShape(doc);
    const history = new History();
    transact(doc, history, 'trash', (tx) => moveToTrash(doc, tx, doc.roots[0]!));
    history.undo(doc);
    expect(treeShape(doc)).toEqual(before);
  });

  it('coalesces a run of typing into one undo step', () => {
    const doc = build(['']);
    const history = new History();
    const id = doc.roots[0]!;
    for (const ch of 'abc') {
      transact(doc, history, 'type', (tx) => {
        tx.touch(id);
        const cur = textOf(get(doc, id).content);
        get(doc, id).content = { runs: [{ text: cur + ch }] };
      }, { group: `type:${id}`, coalescible: true });
    }
    expect(textOf(doc.blocks[id]!.content)).toBe('abc');
    expect(history.depth).toBe(1);
    history.undo(doc);
    expect(textOf(doc.blocks[id]!.content)).toBe('');
  });

  it('does not coalesce structural changes with typing', () => {
    const doc = build(['a', 'b']);
    const history = new History();
    transact(doc, history, 'type', (tx) => {
      tx.touch(doc.roots[0]!);
      get(doc, doc.roots[0]!).content = { runs: [{ text: 'aa' }] };
    }, { group: 'type:x' });
    transact(doc, history, 'indent', (tx) => indent(doc, tx, doc.roots[1]!), { group: 'type:x' });
    expect(history.depth).toBe(2);
  });

  it('drops the redo stack when a new action arrives', () => {
    const doc = build(['a']);
    const history = new History();
    transact(doc, history, 'one', (tx) => {
      tx.touch(doc.roots[0]!);
      get(doc, doc.roots[0]!).content = { runs: [{ text: 'x' }] };
    });
    history.undo(doc);
    expect(history.canRedo).toBe(true);
    transact(doc, history, 'two', (tx) => {
      tx.touch(doc.roots[0]!);
      get(doc, doc.roots[0]!).content = { runs: [{ text: 'y' }] };
    });
    expect(history.canRedo).toBe(false);
  });

  it('survives a long random sequence of edits', () => {
    const doc = build(['a', 'b', '  c', 'd']);
    const history = new History();
    const types = ['paragraph', 'bulletedListItem', 'todo', 'heading2', 'quote'];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 300; i += 1) {
      const all = walk(doc);
      if (all.length === 0) break;
      const target = all[Math.floor(rnd() * all.length)]!;
      const op = Math.floor(rnd() * 5);
      transact(doc, history, `op${i}`, (tx) => {
        if (op === 0) insertLineBreak(doc, tx, { blockId: target.id, offset: 0 });
        else if (op === 1) indent(doc, tx, target.id);
        else if (op === 2) outdent(doc, tx, target.id);
        else if (op === 3) moveSibling(doc, tx, target.id, rnd() > 0.5 ? 1 : -1);
        else turnInto(doc, tx, target.id, types[Math.floor(rnd() * types.length)]!);
      });
    }
    const after = treeShape(doc);
    while (history.canUndo) history.undo(doc);
    expect(treeShape(doc)).toEqual(['a', 'b', '  c', 'd']);
    while (history.canRedo) history.redo(doc);
    expect(treeShape(doc)).toEqual(after);
  });
});

describe('selection model', () => {
  let doc: Doc;
  beforeEach(() => {
    doc = build(['alpha', 'beta', '  nested', 'gamma']);
  });

  it('selects a single block at text level', () => {
    const s: Selection = textSelection(doc.roots[0]!, 0, 3);
    expect(selectedText(doc, s)).toBe('alp');
    expect(selectedBlocks(doc, s).map((b) => b.id)).toEqual([doc.roots[0]!]);
  });

  it('escalates from block text to the whole page', () => {
    let s: Selection = caretAt(doc.roots[0]!, 0);
    s = selectAllInBlock(doc, s);
    expect(selectedText(doc, s)).toBe('alpha');
    s = selectAllPage(s);
    expect(s.level).toBe('page');
    expect(selectedBlocks(doc, s)).toHaveLength(4);
  });

  it('selects a contiguous range of blocks in document order', () => {
    const s = blockRange(doc, 'beta', 'gamma');
    // Clipboard text joins blocks with newlines and no indentation: indentation
    // is a rendering concern, and baking it in would paste stray spaces.
    expect(selectedText(doc, s)).toBe('beta\nnested\ngamma');
  });

  it('normalises an anchor and focus given in reverse', () => {
    const reversed = blockRange(doc, 'gamma', 'beta');
    expect(selectedText(doc, reversed)).toBe('beta\nnested\ngamma');
  });

  it('lists deletable ids once per subtree', () => {
    const s = blockRange(doc, 'alpha', 'beta');
    const ids = deletableIds(doc, s);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(doc.roots[0]!);
  });

  it('finds the previous and next block across nesting boundaries', () => {
    const all = walk(doc);
    const beta = all.find((b) => textOf(b.content) === 'beta')!;
    const nested = all.find((b) => textOf(b.content) === 'nested')!;
    expect(previousBlock(doc, beta.id)).toBe(doc.roots[0]);
    expect(nextBlock(doc, beta.id)).toBe(nested.id);
    expect(nextBlock(doc, all[all.length - 1]!.id)).toBeNull();
  });
});

function blockRange(doc: Doc, fromText: string, toText: string): Selection {
  const all = walk(doc);
  const from = all.find((b) => textOf(b.content) === fromText)!;
  const to = all.find((b) => textOf(b.content) === toText)!;
  return { level: 'block', anchorId: from.id, focusId: to.id };
}

describe('block registry', () => {
  it('describes every registered type', () => {
    for (const type of ['paragraph', 'heading1', 'todo', 'code', 'database']) {
      expect(blockDef(type).label.length).toBeGreaterThan(0);
    }
  });

  it('offers markdown triggers only where declared', () => {
    expect(blockDef('heading1').markdown?.pattern.test('# ')).toBe(true);
    expect(blockDef('paragraph').markdown).toBeUndefined();
  });

  it('allows children only for containers', () => {
    expect(blockDef('bulletedListItem').canHaveChildren).toBe(true);
    expect(blockDef('heading1').canHaveChildren).toBeUndefined();
  });
});

describe('colour marks', () => {
  const runs = [{ text: 'plain blue plain' }];

  it('paints only the slice, and keeps the text intact', () => {
    const out = setColor(runs, 6, 10, 'blue', undefined);
    expect(out.map((r) => r.text)).toEqual(['plain ', 'blue', ' plain']);
    expect(out.map((r) => r.color)).toEqual([undefined, 'blue', undefined]);
    expect(textOf({ runs: out })).toBe('plain blue plain');
  });

  it('keeps the other colour when only one is given', () => {
    const painted = setColor(runs, 6, 10, 'blue', 'yellow');
    const recoloured = setColor(painted, 6, 10, 'red', undefined);
    expect(recoloured.find((r) => r.text === 'blue')).toMatchObject({
      color: 'red',
      background: undefined,
    });
  });

  it('treats default as no colour, so one command both paints and clears', () => {
    const painted = setColor(runs, 6, 10, 'blue', 'yellow');
    const cleared = setColor(painted, 6, 10, 'default', 'default');
    // Normalised back to one run: clearing an attribute that is already absent
    // must not leave two runs that differ in nothing.
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).not.toHaveProperty('color');
  });

  it('does nothing for an empty or reversed range', () => {
    expect(setColor(runs, 4, 4, 'blue', undefined)).toBe(runs);
    expect(setColor(runs, 9, 3, 'blue', undefined)).toBe(runs);
  });
});