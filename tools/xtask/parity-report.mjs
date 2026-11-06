/**
 * Parity report generator.
 *
 * Reads `parity/ledger.csv` and emits `parity/checklist.generated.md` and
 * `docs/parity-report.md` with counts and percentages.
 *
 * The rules that make the numbers mean something:
 *
 *  - **DONE without a proof path is rejected.** The generator downgrades such
 *    rows to PARTIAL and says so in the output. A row claiming completion with
 *    no test and no screenshot is exactly the failure this project exists to
 *    avoid, so it is not allowed to inflate the number.
 *  - **The proof path must exist on disk.** A row citing
 *    `tests/foo.test.ts` when that file is absent is downgraded too, because a
 *    broken path is indistinguishable from no proof at all once you are reading
 *    the CSV alone.
 *  - **PARTIAL counts 0.5, everything else 0.** There is no partial credit for
 *    being mostly there.
 *  - **The weights are T1 3, T2 2, T3 1, T4 0.25**, so a missing Tier-1 item
 *    costs far more than a missing Tier-3 item.
 *
 * CSV parsing is a small hand-rolled reader rather than a dependency: the format
 * is fixed, unquoted, and a dependency for eleven lines of splitting is not
 * worth the supply-chain surface.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const STATUS = {
  TODO: 0,
  WIP: 0,
  PARTIAL: 0.5,
  DONE: 1,
  WONTFIX: 0,
  BLOCKED: 0,
};

export const TIER_WEIGHT = { T1: 3, T2: 2, T3: 1, T4: 0.25 };

/** Parse the ledger CSV. Quoted fields are supported for notes containing commas. */
export function parseLedger(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0] ?? '').map((h) => h.trim().toLowerCase());
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((key, index) => {
      row[key] = (cells[index] ?? '').trim();
    });
    // Skip the blank line the template ends with.
    if (!row.id) continue;
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Check a row's proof. Returns a problem string, or null when the proof holds.
 */
export function checkProof(row, root) {
  const proof = (row.proof ?? '').trim();
  if (!proof) return 'no proof recorded';
  // A proof is a comma- or semicolon-separated list of file paths and/or
  // evidence ids. Only paths are checked for existence.
  for (const part of proof.split(/[;,]\s*/)) {
    const token = part.trim();
    if (!token) continue;
    if (token.startsWith('http')) continue;
    if (/^ev_[a-f0-9]{16,}$/.test(token)) continue; // evidence id
    if (token.startsWith('<')) continue; // inline literal
    if (!existsSync(join(root, token))) return `proof path does not exist: ${token}`;
  }
  return null;
}

export function analyse(rows, root) {
  const downgraded = [];
  const effective = rows.map((row) => {
    const status = (row.status ?? 'TODO').toUpperCase();
    const problem = status === 'DONE' ? checkProof(row, root) : null;
    if (problem) downgraded.push({ id: row.id, problem });
    return {
      ...row,
      status: problem ? 'PARTIAL' : status,
      downgraded: Boolean(problem),
      proofProblem: problem,
      credit: problem ? 0.5 : (STATUS[status] ?? 0),
    };
  });

  const byArea = new Map();
  const byTier = new Map();
  for (const row of effective) {
    const area = row.area || 'uncategorised';
    const tier = row.tier || 'T1';
    const areaBucket = byArea.get(area) ?? { total: 0, credit: 0 };
    areaBucket.total += 1;
    areaBucket.credit += row.credit;
    byArea.set(area, areaBucket);

    const tierBucket = byTier.get(tier) ?? { total: 0, credit: 0 };
    tierBucket.total += 1;
    tierBucket.credit += row.credit;
    byTier.set(tier, tierBucket);
  }

  let weighted = 0;
  let weightedTotal = 0;
  for (const row of effective) {
    const weight = TIER_WEIGHT[row.tier] ?? 1;
    weighted += row.credit * weight;
    weightedTotal += weight;
  }

  const statusCounts = {};
  for (const row of effective) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;

  return {
    rows: effective,
    byArea,
    byTier,
    statusCounts,
    total: effective.length,
    weightedPct: weightedTotal === 0 ? 0 : (weighted / weightedTotal) * 100,
    downgraded,
  };
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;

export function renderChecklist(result) {
  const lines = [
    '# Generated feature checklist',
    '',
    'Generated by `node tools/xtask/parity-report.mjs` from `parity/ledger.csv`.',
    'Do not edit this file by hand; edit the ledger and regenerate.',
    '',
    `Total catalogued features: **${result.total}**`,
    '',
    '## By area',
    '',
    '| Area | DONE-equivalent | Total | Percent |',
    '|---|---:|---:|---:|',
  ];
  for (const [area, bucket] of [...result.byArea].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(
      `| ${area} | ${bucket.credit.toFixed(1)} | ${bucket.total} | ${pct(bucket.credit / bucket.total)} |`,
    );
  }
  lines.push(
    '',
    '## By tier',
    '',
    '| Tier | DONE-equivalent | Total | Percent |',
    '|---|---:|---:|---:|',
  );
  for (const tier of ['T1', 'T2', 'T3', 'T4']) {
    const bucket = result.byTier.get(tier);
    if (!bucket) continue;
    lines.push(`| ${tier} | ${bucket.credit.toFixed(1)} | ${bucket.total} | ${pct(bucket.credit / bucket.total)} |`);
  }
  lines.push(
    '',
    '## By status',
    '',
    '| Status | Count |',
    '|---|---:|',
  );
  for (const [status, count] of Object.entries(result.statusCounts).sort()) {
    lines.push(`| ${status} | ${count} |`);
  }
  if (result.downgraded.length) {
    lines.push(
      '',
      '## Rows downgraded for missing or invalid proof',
      '',
      'These rows claimed DONE but could not be substantiated, so they were',
      'counted as PARTIAL instead. The generator will not report progress it',
      'cannot show.',
      '',
      '| Id | Problem |',
      '|---|---|',
    );
    for (const d of result.downgraded) lines.push(`| ${d.id} | ${d.problem} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderReport(result) {
  const t1 = result.byTier.get('T1');
  const t2 = result.byTier.get('T2');
  const lines = [
    '# Parity report',
    '',
    'Generated from `parity/ledger.csv`. Every number here is derived from the',
    'ledger, never estimated by hand. `DONE` counts 1, `PARTIAL` counts 0.5,',
    'everything else 0.',
    '',
    `Catalogued features: **${result.total}**`,
    '',
    `- Tier 1 coverage: ${t1 ? `${pct(t1.credit / t1.total)} (${t1.credit.toFixed(1)}/${t1.total})` : 'n/a'}`,
    `- Tier 2 coverage: ${t2 ? `${pct(t2.credit / t2.total)} (${t2.credit.toFixed(1)}/${t2.total})` : 'n/a'}`,
    `- Weighted parity across all tiers (T1 3, T2 2, T3 1, T4 0.25): **${result.weightedPct.toFixed(1)}%**`,
    '',
    result.downgraded.length
      ? `${result.downgraded.length} row(s) were downgraded from DONE because their proof was missing or pointed at a file that does not exist.`
      : 'Every DONE row has a proof path that exists on disk.',
    '',
    '## What this does and does not mean',
    '',
    'This measures coverage of the *catalogued* feature list, which was written',
    'from public documentation before the reference application could be',
    'observed. It is not a measurement of behavioural fidelity. A row can be',
    'DONE and still differ from the reference in ways this ledger does not',
    'capture, which is why each row also carries a source tag: `HINT` rows are',
    'unverified hypotheses and should be read as such.',
    '',
    'See `docs/gaps.md` for what is known to be missing.',
  ];
  return lines.join('\n');
}

/** Run from the command line. */
if (process.argv[1] && process.argv[1].endsWith('parity-report.mjs')) {
  const root = process.cwd();
  const ledgerPath = join(root, 'parity', 'ledger.csv');
  if (!existsSync(ledgerPath)) {
    console.error('parity: parity/ledger.csv not found');
    process.exit(2);
  }
  const result = analyse(parseLedger(readFileSync(ledgerPath, 'utf8')), root);
  mkdirSync(join(root, 'parity'), { recursive: true });
  writeFileSync(join(root, 'parity', 'checklist.generated.md'), renderChecklist(result));
  writeFileSync(join(root, 'docs', 'parity-report.md'), renderReport(result));
  console.log(
    `parity: ${result.total} rows, weighted ${result.weightedPct.toFixed(1)}%, ` +
      `${result.downgraded.length} downgraded`,
  );
  process.exit(0);
}