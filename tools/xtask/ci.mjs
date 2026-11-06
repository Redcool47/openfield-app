#!/usr/bin/env node
/**
 * `pnpm xtask ci` equivalent: one command that runs every gate.
 *
 * Order matters. Cheap structural checks run before slow ones so a layering
 * violation is reported in a second rather than after a full test run. Each step
 * runs in a child process so a crash in one step cannot take the rest with it,
 * and the first failure stops the run: a CI that keeps going after a failure
 * prints a wall of noise around the one line that mattered.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/**
 * Tools are launched as `node <script>` rather than through `npx` or a
 * `.bin` shim.
 *
 * On Windows, spawning a `.cmd` shim requires `shell: true`, which reintroduces
 * quoting problems and, worse, means the argument list is re-parsed by a command
 * interpreter. Running the tool's own JavaScript entry point under the current
 * Node binary avoids both, and makes CI behave identically on every platform.
 */
function tool(script, args = []) {
  const path = join(root, 'node_modules', script);
  if (!existsSync(path)) {
    throw new Error(`missing tool entry point: ${script} (run "npm install" first)`);
  }
  return { command: process.execPath, args: [path, ...args] };
}

const TSC = 'typescript/bin/tsc';
const VITEST = 'vitest/vitest.mjs';

/**
 * Each step declares what it proves, so a failure message says which guarantee
 * broke rather than only naming a command.
 */
const STEPS = [
  {
    name: 'layering',
    command: process.execPath,
    args: ['tools/xtask/layering.mjs'],
    proves: 'lower layers never import higher layers',
  },
  {
    name: 'attribution',
    command: process.execPath,
    args: ['tools/xtask/attribution.mjs'],
    proves: 'every asset and dependency is credited',
  },
  {
    name: 'typecheck',
    ...tool(TSC, ['-b', 'tsconfig.build.json']),
    proves: 'the sources typecheck',
  },
  {
    name: 'unit',
    ...tool(VITEST, ['run']),
    proves: 'unit and scenario tests pass',
  },
  {
    name: 'parity',
    command: process.execPath,
    args: ['tools/xtask/parity-report.mjs'],
    proves: 'the parity ledger is internally consistent',
  },
];

/**
 * Optional steps. These are reported, not enforced, and are skipped entirely
 * when the thing they need is not in the tree yet.
 *
 * `package` runs with `cwd` set to the desktop app. electron-builder resolves
 * its configuration from the package.json of the directory it is invoked in, so
 * running it from the repository root makes it look for an entry point in a
 * package that has none -- which fails with a message about a missing "index.js"
 * that says nothing about the real problem.
 */
const OPTIONAL = [
  {
    name: 'package',
    command: process.execPath,
    // Absolute, because this step runs with cwd set to apps/desktop and a
    // relative path would then be looked up there rather than at the repository
    // root. Resolving it up front also makes the failure legible: the error says
    // which file is missing instead of "Cannot find module" with no context.
    args: [join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--dir'],
    proves: 'a distributable build can be produced',
    requires: 'apps/desktop/dist/main/index.js',
    cwd: 'apps/desktop',
  },
  {
    name: 'e2e',
    command: process.execPath,
    args: [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test'],
    proves: 'the real app launches, renders and edits through the command bridge',
    // Gated on the same built entry point as `package`: the end-to-end tests
    // launch the actual Electron main process, so there is nothing to drive
    // until the app has been built.
    requires: 'apps/desktop/dist/main/index.js',
  },
];

function run(step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd ? join(root, step.cwd) : root,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });
    child.on('error', (error) => resolve({ code: 1, error: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const steps = STEPS.filter((s) => !only.length || only.includes(s.name));
  const results = [];

  for (const step of steps) {
    process.stdout.write(`\n--- ${step.name}: ${step.proves}\n`);
    const started = Date.now();
    const result = await run(step);
    const ms = Date.now() - started;
    results.push({ ...step, ...result, ms });
    if (result.code !== 0) {
      console.error(`\nCI FAILED at "${step.name}" (${step.proves}) after ${ms} ms`);
      report(results);
      process.exit(1);
    }
    console.log(`--- ${step.name}: ok (${ms} ms)`);
  }

  for (const step of OPTIONAL) {
    if (only.length && !only.includes(step.name)) continue;
    if (!existsSync(join(root, step.requires))) {
      console.log(`\n--- ${step.name}: skipped (${step.requires} not present yet)`);
      results.push({ ...step, code: 0, skipped: true, ms: 0 });
      continue;
    }
    process.stdout.write(`\n--- ${step.name}: ${step.proves}\n`);
    const started = Date.now();
    const result = await run(step);
    const ms = Date.now() - started;
    // Measured, not hardcoded to zero. A row that always reads "0 ms" cannot be
    // told apart from a row that was skipped, which is how a step that never ran
    // ends up reading as a step that passed.
    results.push({ ...step, ...result, ms });
    if (result.code !== 0) {
      // Deliberately non-fatal, but the failure is stated in the summary table
      // so it cannot be mistaken for a pass.
      console.warn(`\nCI WARNING: optional step "${step.name}" failed`);
      report(results);
      process.exit(0);
    }
    // Required steps print an explicit result line; optional ones used to print
    // nothing on success, so the transcript showed a step's output and then went
    // straight to the summary with no verdict. Silence there reads as "still
    // running" or "nothing to report".
    console.log(`--- ${step.name}: ok (${ms} ms)`);
  }

  report(results);
  console.log('\nCI PASSED');
}

function report(results) {
  const width = Math.max(...results.map((r) => r.name.length), 4);
  console.log('\n  step           result    time');
  console.log('  ------------------------------');
  for (const r of results) {
    const status = r.skipped ? 'skipped' : r.code === 0 ? 'ok' : 'FAIL';
    console.log(`  ${r.name.padEnd(width)}  ${status.padEnd(8)}  ${r.ms} ms`);
  }
}

await main();