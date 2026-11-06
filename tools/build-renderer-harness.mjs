#!/usr/bin/env node
/**
 * Build a browser-loadable harness for the renderer.
 *
 * The renderer can only run inside Electron, because its only way to reach the
 * workspace is the preload bridge. That makes layout impossible to inspect or
 * assert on from anything but a running app -- which is how a sidebar that did
 * not fill the window survived several launches: the only way to see it was to
 * launch the app and squint at a screenshot.
 *
 * This writes a copy of the built index.html with `window.ow` stubbed by a plain
 * script ahead of the module bundle. The React code, the CSS and the tokens are
 * the real built artefacts; only the bridge is replaced. So what the browser
 * renders is what the app renders, and the geometry can be measured.
 *
 * The asset filenames are hashed, so the paths are read out of the built HTML
 * rather than hardcoded -- otherwise the harness would silently stop matching
 * the build after the next rebuild.
 *
 * Usage: node tools/build-renderer-harness.mjs [--serve]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const rendererDir = join(process.cwd(), 'apps', 'desktop', 'dist', 'renderer');
const builtHtml = join(rendererDir, 'index.html');

if (!existsSync(builtHtml)) {
  console.error(`no built renderer at ${builtHtml} -- run: node apps/desktop/bin/dev.mjs --package`);
  process.exit(1);
}

/**
 * A stub state shaped like buildState() in the main process.
 *
 * Deliberately contains a nested page and a few blocks: an empty workspace would
 * collapse the sidebar and hide exactly the layout faults this harness exists to
 * catch.
 */
const FIXTURE = {
  workspacePath: 'C:/harness/workspace',
  pages: [
    {
      id: 'p1',
      title: 'Getting started',
      icon: null,
      parentPage: null,
      isFavorite: false,
      hasChildren: true,
      depth: 0,
    },
    {
      id: 'p2',
      title: 'Nested child page',
      icon: null,
      parentPage: 'p1',
      isFavorite: false,
      hasChildren: false,
      depth: 1,
    },
    {
      id: 'p3',
      title: 'A second top level page',
      icon: null,
      parentPage: null,
      isFavorite: false,
      hasChildren: false,
      depth: 0,
    },
  ],
  favorites: [],
  trashed: [],
  current: {
    id: 'p1',
    title: 'Getting started',
    rows: [
      { id: 'b1', type: 'heading1', text: 'A heading', depth: 0, checked: false, collapsed: false },
      { id: 'b2', type: 'paragraph', text: 'A paragraph of body text.', depth: 0, checked: false, collapsed: false },
      { id: 'b3', type: 'todo', text: 'A to-do', depth: 0, checked: false, collapsed: false },
    ],
  },
  stats: { pages: 3, blocks: 3 },
  integrity: { ok: true, issues: [] },
  /**
   * A database on the open page, so the table and board views can be exercised
   * without launching Electron. Included because the database UI is now a real
   * surface and "launch the app and look" stopped being a reasonable way to check
   * it -- the same reasoning that produced this harness in the first place.
   */
  database: {
    collection: {
      id: 'c1',
      name: 'Task UI Showcase',
      schema: {
        properties: [
          { id: 'prop-name', name: 'Name', type: 'text' },
          {
            id: 'prop-status',
            name: 'Status',
            type: 'select',
            options: [
              { id: 'opt-todo', name: 'To do', color: '#9b9b9b' },
              { id: 'opt-progress', name: 'In progress', color: '#2f6fed' },
              { id: 'opt-blocked', name: 'Blocked', color: '#e06c5c' },
              { id: 'opt-done', name: 'Done', color: '#4a9d6f' },
            ],
          },
          { id: 'prop-due', name: 'Due', type: 'date' },
          { id: 'prop-done', name: 'Done', type: 'checkbox' },
          { id: 'prop-points', name: 'Points', type: 'number' },
        ],
      },
    },
    views: [
      { id: 'v1', type: 'table', name: 'All' },
      { id: 'v2', type: 'board', name: 'By Status' },
    ],
    rows: [
      { id: 'r1', title: 'Test install flow', values: { 'prop-status': { type: 'select', optionId: 'opt-progress' }, 'prop-due': { type: 'date', date: '2027-03-16' }, 'prop-done': { type: 'checkbox', checked: false } } },
      { id: 'r2', title: 'Fix sidebar', values: { 'prop-status': { type: 'select', optionId: 'opt-blocked' }, 'prop-points': { type: 'number', number: 5 } } },
      { id: 'r3', title: 'Ship installer', values: { 'prop-status': { type: 'select', optionId: 'opt-done' }, 'prop-due': { type: 'date', date: '2027-03-08' }, 'prop-done': { type: 'checkbox', checked: true }, 'prop-points': { type: 'number', number: 13 } } },
      { id: 'r4', title: 'Draft the spec', values: {} },
    ],
  },
};

/**
 * The stub, emitted as its own file rather than inline.
 *
 * An inline <script> is refused by the built page's own Content-Security-Policy
 * (`script-src 'self'`), which is correct behaviour and worth keeping: the
 * harness should render under the same policy the app does, not a relaxed one.
 * So the stub is loaded from a URL 'self' permits, ahead of the module bundle.
 */
const stub = `/* Generated by tools/build-renderer-harness.mjs. Stands in for the preload bridge. */
window.__owHarness = true;
window.__errors = [];
window.addEventListener('error', function (e) {
  window.__errors.push('error: ' + (e.message || 'unknown') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  window.__errors.push('unhandled rejection: ' + (r && r.stack ? r.stack : String(r)));
});
window.ow = {
  execute: async function (id, args) {
    window.__owCalls = window.__owCalls || [];
    window.__owCalls.push({ id: id, args: args || {} });
    return { id: id, ok: true, value: null };
  },
  state: async function () { return ${JSON.stringify(FIXTURE)}; },
  onState: function () { return function () {}; },
};
`;

const html = readFileSync(builtHtml, 'utf8');

// Insert before the first <script> so the bridge exists by the time the module
// bundle runs. A module script is deferred, so a classic script here always
// wins the race.
const at = html.indexOf('<script');
if (at === -1) {
  console.error('built index.html has no <script>; has the renderer entry moved?');
  process.exit(1);
}

const stubTag = '<script src="./harness-stub.js"></script>\n';
const harnessHtml = html.slice(0, at) + stubTag + html.slice(at);

writeFileSync(join(rendererDir, 'harness-stub.js'), stub);
const outFile = join(rendererDir, 'harness.html');
writeFileSync(outFile, harnessHtml);
console.log(`harness: wrote ${outFile} and harness-stub.js`);

if (!process.argv.includes('--serve')) process.exit(0);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
  const file = join(rendererDir, rel === '' ? 'harness.html' : rel);
  if (!file.startsWith(rendererDir) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const port = 4173;
server.listen(port, '127.0.0.1', () => {
  console.log(`harness: serving http://127.0.0.1:${port}/harness.html  (ctrl-c to stop)`);
});
