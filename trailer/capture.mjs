/**
 * Capture the real app for the trailer.
 *
 * Every frame comes from the app itself on a throwaway workspace, exactly the
 * way the e2e tests take pictures: no mockup, no invented UI.
 *
 *   node trailer/capture.mjs
 *
 * It also prints the frame-space centre of each thing the film's cursor clicks,
 * because those clicks are meant to be real: the shot cuts to the state the
 * click produced. Aim the cursor with these numbers, not by eye.
 */

import { _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// The film places the window at this box on a 1920x1080 frame. Cue coordinates
// are mapped into it here, so the two files cannot drift apart silently.
const WIN = { left: 240, top: 115, width: 1440, height: 853 };

const root = process.cwd();
const electronMain = join(root, 'apps', 'desktop', 'dist', 'main', 'index.js');
const frames = join(root, 'trailer', 'frames');
mkdirSync(frames, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'ow-trailer-'));
const profile = mkdtempSync(join(tmpdir(), 'ow-trailer-profile-'));

const app = await electron.launch({
  args: [electronMain],
  env: { ...process.env, OW_WORKSPACE: dir, OW_USER_DATA: profile },
});

const page = await app.firstWindow();
await page.waitForSelector('.ow-app');
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1440, 900);
  win.center();
});
await page.waitForTimeout(600);

const exec = (id, args) =>
  page.evaluate(
    async ([commandId, a]) => {
      const bridge = globalThis.ow;
      const r = await bridge.execute(commandId, a);
      if (!r.ok) throw new Error(`${commandId}: ${JSON.stringify(r)}`);
      return r.value;
    },
    [id, args],
  );

const shot = async (name) => {
  await page.keyboard.press('Escape');
  // The app draws a focus ring on the block the caret is in. In a still that
  // reads as a selected block, so the caret is blurred first.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1400, 30);
  // The caret sits at the end of the last block, and the app scrolls it into
  // view; a still that starts halfway down the page looks like a mistake.
  await page.evaluate(() => {
    const s = document.querySelector('.ow-page-scroll');
    if (s) s.scrollTop = 0;
  });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(frames, `${name}.png`) });
  console.log('shot', name);
};

const editor = () => page.getByRole('textbox', { name: 'paragraph' }).last();

const { width: viewW, height: viewH } = await page.evaluate(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
}));
const cues = {};
const cue = async (name, locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  cues[name] = {
    x: Math.round(WIN.left + (box.x + box.width / 2) * (WIN.width / viewW)),
    y: Math.round(WIN.top + (box.y + box.height / 2) * (WIN.height / viewH)),
  };
};

// --- the workspace ---------------------------------------------------------
const roadmap = await exec('page.create', { title: 'Roadmap' });
const meeting = await exec('page.create', { title: 'Meeting notes' });
const field = await exec('page.create', { title: 'Field notes' });
// One child, so the sidebar shows what nesting looks like.
const design = await exec('page.create', { title: 'Design system', parentPage: field.id });

const insert = async (type, text) => exec('block.insert', { type, text });
const todo = async (text, checked) => {
  const b = await insert('todo', text);
  if (checked) await exec('block.setChecked', { id: b.id, checked: true });
  return b;
};

// A page opens with one empty block. Left empty it shows the "Type '/' for
// commands" placeholder, which in a still reads as a blank page, so every page
// that appears in the film starts with a typed line.
const firstLine = async (text) => {
  await editor().click();
  await page.keyboard.type(text, { delay: 20 });
  await page.waitForTimeout(300);
};

// --- Roadmap: structure, and something already done ------------------------
await exec('page.open', { id: roadmap.id });
await firstLine('Four things matter this month.');
await insert('quote', 'The editor is what people open first, so it ships before the database polish.');
await insert('heading2', 'Now');
await todo('Draft the launch note', true);
await todo('Write the migration guide', true);
await todo('Ship the database views');
await insert('heading2', 'Next');
await todo('Relation and rollup properties');
await insert('paragraph', 'Nothing here needs a server. The workspace is a folder you already sync.');

// --- Meeting notes: the page the first click lands on ----------------------
await exec('page.open', { id: meeting.id });
await firstLine('Decisions from the last sync.');
await insert('heading2', 'Decisions');
await insert('bulletedListItem', 'Offline first: no account, no server.');
await insert('bulletedListItem', 'One Markdown file per page.');
await insert('bulletedListItem', 'The assistant stays off until it is asked for.');
await insert('heading2', 'Follow-ups');
await todo('Write the migration guide', true);
await todo('Publish the file format spec');
await insert('quote', 'Ship the editor before the database polish.');

// --- Design system: the child page the third click lands on ----------------
await exec('page.open', { id: design.id });
await firstLine('Every colour and space on this page comes from a token.');
await insert('heading2', 'Tokens');
await insert('bulletedListItem', 'Spacing follows one scale.');
await insert('bulletedListItem', 'One accent colour, everywhere.');
await insert('heading3', 'In code');
await insert('code', 'const space = [0, 4, 8, 12, 16, 24, 32];\nconst accent = tokens.colour.accent;');
await insert(
  'paragraph',
  'A block may only be changed through a command, so the history stays complete.',
);

// --- Field notes: the inline chips ----------------------------------------
await exec('page.open', { id: field.id });

// The first line is typed rather than inserted: typing is the one thing the
// film shows happening live, and it is deterministic enough at 20ms a key.
// Everything else is a command, because a command cannot race the model.
await firstLine('A quiet place for the work in progress.');

await insert('heading2', 'This week');
await todo('Draft the launch note', true);
await todo('Sync the workspace folder');

// Inline chips are set by command against a range, which is the same path the
// slash menu and the toolbar take. One placeholder per chip, and the offsets
// come from the string: a hand-counted index once put a link in the middle of
// a word, and the frame showed "See f|Roadmap".
const equationLine = 'Compare ~ against the draft.';
const equation = await insert('paragraph', equationLine);
await exec('inline.equation.set', {
  id: equation.id,
  from: equationLine.indexOf('~'),
  to: equationLine.indexOf('~') + 1,
  latex: 'E = mc^2',
});

const linkLine = 'Filed under ~ and ~. See ~ for what comes next.';
const markers = [...linkLine].flatMap((ch, i) => (ch === '~' ? [i] : []));
const links = await insert('paragraph', linkLine);
// Right to left: each chip replaces one character, so a later replacement
// would move an earlier offset.
const fill = async (index, command, args) =>
  exec(command, { id: links.id, from: markers[index], to: markers[index] + 1, ...args });
await fill(2, 'inline.wiki.set', { title: 'Roadmap' });
await fill(1, 'inline.tag.set', { name: 'shipped' });
await fill(0, 'inline.tag.set', { name: 'research' });

await insert('heading2', 'Why this exists');
await insert(
  'paragraph',
  'Every note is Markdown on disk. There is no export step, and the folder syncs with whatever you already use.',
);

// One favourite, so the sidebar shows what a pinned page looks like.
await exec('page.favorite.toggle', { id: field.id });

// --- the database ----------------------------------------------------------
await exec('db.people.add', { name: 'Aroha' });
const people = (await exec('db.people.list', {})).people;
const db = await exec('db.create', { name: 'Reading list' });
await exec('db.property.add', { collectionId: db.id, name: 'Author' });
await exec('db.property.add', { collectionId: db.id, name: 'Owner', type: 'person' });
// A second view, so the film can click the tab and the table becomes a board.
await exec('db.view.add', { collectionId: db.id, type: 'board', name: 'Board' });
const books = [
  ['The Design of Everyday Things', 'Don Norman', 'opt-done'],
  ['Thinking in Systems', 'Donella Meadows', 'opt-progress'],
  ['A Pattern Language', 'Christopher Alexander', 'opt-todo'],
  ['The Humane Interface', 'Jef Raskin', 'opt-progress'],
  ['How Buildings Learn', 'Stewart Brand', 'opt-done'],
];
for (const [title, author, status] of books) {
  const row = await exec('db.row.add', { collectionId: db.id, title });
  await exec('db.value.set', { collectionId: db.id, pageId: row.id, propertyId: 'prop-author', value: author });
  await exec('db.value.set', { collectionId: db.id, pageId: row.id, propertyId: 'prop-status', value: status });
  await exec('db.value.set', {
    collectionId: db.id,
    pageId: row.id,
    propertyId: 'prop-owner',
    value: [people[0].id],
  });
}

// --- frames ----------------------------------------------------------------
await exec('page.open', { id: roadmap.id });
await shot('page-roadmap');

await exec('page.open', { id: meeting.id });
await shot('page-meeting');

await exec('page.open', { id: field.id });
await shot('page-inline');

await exec('page.open', { id: design.id });
await shot('page-design');

await exec('page.open', { id: db.pageId });
await shot('db-table');
// Aimed while the table is on screen: switching views and coming back is a
// path the film never takes, and the numbers only have to match the still.
await cue('statusChip', page.getByText('In progress', { exact: true }).first());
await cue('boardTab', page.locator('.ow-db-view', { hasText: 'Board' }).first());

// The board is reached the way a person reaches it: press the tab. If this
// click ever stops working, the film's table-to-board cut becomes a lie.
await page.locator('.ow-db-view', { hasText: 'Board' }).first().click();
await page.waitForTimeout(400);
await shot('db-board');

// The settings dialog is captured as an element, not as part of the window:
// the film shows it on its own, and a crop of the window would carry a strip
// of the scrim and whatever page was behind it.
//
// It is shot as a full window and cropped, rather than with an element
// screenshot: Playwright's element screenshot of this card leaves a sliver of
// the previous paint across the top edge, and that sliver ends up in the film.
await page.locator('.ow-settings-open').click();
const dialog = page.getByRole('dialog', { name: 'Settings' });
await dialog.waitFor({ state: 'visible' });
await page.getByRole('tab', { name: 'Advanced' }).click();
await page.waitForTimeout(1200);

const card = await page.locator('.ow-settings-card').boundingBox();
const dpr = await page.evaluate(() => devicePixelRatio);
await page.screenshot({ path: join(frames, 'settings-advanced-full.png') });
execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-i', join(frames, 'settings-advanced-full.png'),
  '-vf', `crop=${Math.round(card.width * dpr)}:${Math.round(card.height * dpr)}:${Math.round(card.x * dpr)}:${Math.round(card.y * dpr)}`,
  join(frames, 'settings-advanced.png'),
]);
rmSync(join(frames, 'settings-advanced-full.png'));
console.log('shot settings-advanced', card, 'dpr', dpr);

// --- the clicks the film makes --------------------------------------------
// Each of these is the centre of a control the cursor will press. The window
// is scrolled to the top for all of them, so the numbers match the stills.
// Escape does not dismiss the settings card; its close button does.
await page.getByRole('button', { name: 'Close settings' }).click();
await page.waitForTimeout(400);
await exec('page.open', { id: roadmap.id });
await cue('meeting', page.locator('.ow-row-main', { hasText: 'Meeting notes' }).first());
await cue('field', page.locator('.ow-row-main', { hasText: 'Field notes' }).first());
await cue('design', page.locator('.ow-row-main', { hasText: 'Design system' }).first());
await cue('readingList', page.locator('.ow-row-main', { hasText: 'Reading list' }).first());

// Zoom targets: the two places the film punches in.
await exec('page.open', { id: field.id });
cues.chips = await (async () => {
  const box = await page.locator(`.ow-block[data-block-id="${links.id}"]`).boundingBox();
  return {
    x: Math.round(WIN.left + (box.x + box.width / 2) * (WIN.width / viewW)),
    y: Math.round(WIN.top + (box.y + box.height / 2) * (WIN.height / viewH)),
  };
})();

writeFileSync(join(frames, 'cues.json'), `${JSON.stringify(cues, null, 2)}\n`);
console.log('cues', JSON.stringify(cues));

await app.close();
for (const d of [dir, profile]) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
console.log('done');
