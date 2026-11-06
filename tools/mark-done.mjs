/**
 * Mark ledger rows DONE with a proof path.
 *
 * Usage: node tools/mark-done.mjs <id>=<proof>[;;<notes>] ...
 *
 * Not a general CSV editor on purpose. PowerShell's Export-Csv quotes and
 * rewrites every one of the 172 rows, which buries the two lines that actually
 * changed in 346 lines of diff. This rewrites only the rows it is given and
 * leaves the rest byte-identical.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'parity/ledger.csv';
const lines = readFileSync(path, 'utf8').split(/\r?\n/);

const marks = new Map();
for (const arg of process.argv.slice(2)) {
  const [id, rest] = arg.split('=');
  if (!id || !rest) throw new Error(`bad argument: ${arg}`);
  const [proof, notes = ''] = rest.split(';;');
  marks.set(id, { proof, notes });
}

/**
 * Ledger ids are `AREA-NNNN` and the set of areas grows over time. A hardcoded
 * alternation silently fails to match a new one, which is how DB-LIST and
 * DB-GALLERY went unmarkable -- and `[A-Z-]` alone cannot match `A11Y`.
 *
 * The prefix therefore allows digits, and the lookup still fails loudly on a
 * typo rather than silently doing nothing.
 */
const ID_PATTERN = /^([A-Z0-9][A-Z0-9-]*-[A-Z0-9]+),/;

let changed = 0;
for (let i = 0; i < lines.length; i++) {
  const m = ID_PATTERN.exec(lines[i]);
  if (!m) continue;
  const id = m[1];
  const mark = marks.get(id);
  if (!mark) continue;

  // The CSV is unquoted and comma-separated; notes with commas would break it.
  const cells = lines[i].split(',');
  cells[5] = 'DONE';
  cells[6] = mark.proof.replace(/,/g, ' ');
  cells[7] = mark.notes.replace(/,/g, ' ');
  const next = cells.slice(0, 8).join(',');
  if (next !== lines[i]) changed++;
  lines[i] = next;
  marks.delete(id);
}

if (marks.size) throw new Error(`no such row(s): ${[...marks.keys()].join(', ')}`);

writeFileSync(path, lines.join('\n'));
console.log(`marked ${changed} row(s) DONE`);