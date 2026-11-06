/**
 * Record the app doing real work, for the trailer.
 *
 * The film used to be stills with a drawn cursor moving between them. That
 * cannot show typing, a selection being coloured, or a page reflowing when its
 * font changes -- and those are the things the film is meant to show. So this
 * records the actual application while a script drives it, and cuts the take
 * into shots.
 *
 *   node trailer/record.mjs
 *
 * One continuous recording, marked with `mark()` at the moment each shot
 * begins. Recording is Playwright's own video of the Electron window, so every
 * frame is the app; nothing is redrawn afterwards.
 *
 * Why marks rather than timing the shots afterwards: cue times for the drawn
 * cursor are logged relative to the shot that contains them, and both come from
 * the same clock, so the cursor cannot drift away from the click it is meant to
 * be making. Only the take's absolute offset within the video file is estimated,
 * and an error there shifts a whole shot, never the pointer inside it.
 */

import { _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

// The film places the window at this box on a 1920x1080 frame. Cue coordinates
// are mapped into it here, so the two files cannot drift apart silently.
const WIN = { left: 240, top: 115, width: 1440, height: 853 };

// The window frame costs 13px of width and 61px of height on this platform, so
// this outer size gives a 1440x853 viewport: the video then matches the window
// box in index.html one pixel to one pixel.
const WINDOW = { width: 1453, height: 914 };

const root = process.cwd();
const shotsDir = join(root, 'trailer', 'shots');
const metaDir = join(root, 'trailer', 'frames');
rmSync(shotsDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });
mkdirSync(metaDir, { recursive: true });

const videoDir = mkdtempSync(join(tmpdir(), 'ow-rec-'));
const dir = mkdtempSync(join(tmpdir(), 'ow-trailer-'));
const profile = mkdtempSync(join(tmpdir(), 'ow-trailer-profile-'));

const app = await electron.launch({
  args: [join(root, 'apps', 'desktop', 'dist', 'main', 'index.js')],
  env: { ...process.env, OW_WORKSPACE: dir, OW_USER_DATA: profile },
  recordVideo: { dir: videoDir, size: { width: WIN.width, height: WIN.height } },
});

const page = await app.firstWindow();
await page.waitForSelector('.ow-app');
await app.evaluate(({ BrowserWindow }, size) => {
  BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
}, [WINDOW.width, WINDOW.height]);
await page.waitForTimeout(600);

const { width: viewW, height: viewH } = await page.evaluate(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
}));
if (viewW !== WIN.width || viewH !== WIN.height) {
  throw new Error(`viewport ${viewW}x${viewH} does not match the film's ${WIN.width}x${WIN.height}`);
}

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

// --- the workspace the take moves around in --------------------------------
// Built with commands, and before the first mark, so none of it is in the film.
const roadmap = await exec('page.create', { title: 'Roadmap' });
const meeting = await exec('page.create', { title: 'Meeting notes' });
const design = await exec('page.create', { title: 'Design system', parentPage: roadmap.id });

const insert = (type, text) => exec('block.insert', { type, text });

await exec('page.open', { id: roadmap.id });
await insert('heading2', 'Now');
await insert('todo', 'Draft the launch note');
await insert('todo', 'Ship the database views');
await insert('heading2', 'Next');
await insert('bulletedListItem', 'Relation and rollup properties');

await exec('page.open', { id: meeting.id });
await insert('heading2', 'Decisions');
await insert('bulletedListItem', 'Offline first: no account, no server.');
await insert('bulletedListItem', 'One Markdown file per page.');
await insert('quote', 'Ship the editor before the database polish.');

await exec('page.open', { id: design.id });
await insert('bulletedListItem', 'Spacing follows one scale.');

const people = (await exec('db.people.add', { name: 'Aroha' })).id
  ? (await exec('db.people.list', {})).people
  : [];
const db = await exec('db.create', { name: 'Reading list' });
await exec('db.property.add', { collectionId: db.id, name: 'Author' });
await exec('db.property.add', { collectionId: db.id, name: 'Owner', type: 'person' });
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
  if (people[0]) {
    await exec('db.value.set', {
      collectionId: db.id,
      pageId: row.id,
      propertyId: 'prop-owner',
      value: [people[0].id],
    });
  }
}

// --- the take --------------------------------------------------------------
const shots = [];
let current = null;
const clock = () => Date.now();

const mark = (name, note) => {
  if (current) current.endMs = clock();
  current = { name, note, startMs: clock(), cues: [] };
  shots.push(current);
};

/** Log where a control is, in frame space, at this instant. */
const cue = async (name, locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  current.cues.push({
    name,
    t: (clock() - current.startMs) / 1000,
    x: Math.round(WIN.left + (box.x + box.width / 2) * (WIN.width / viewW)),
    y: Math.round(WIN.top + (box.y + box.height / 2) * (WIN.height / viewH)),
  });
};

/** Move the real pointer to a control and press it. */
const press = async (name, locator) => {
  await cue(name, locator);
  await locator.click();
};

const settle = (ms) => page.waitForTimeout(ms);

// A landmark in the recording, so the shot cuts can be lined up exactly. It is
// painted and removed before the first mark, so the film never contains it.
await page.evaluate(() => {
  const flash = document.createElement('div');
  flash.id = 'ow-calibration';
  flash.style.cssText =
    'position:fixed;inset:0;background:#ff0000;z-index:2147483647';
  document.body.appendChild(flash);
});
await settle(500);
const flashEndMs = clock();
await page.evaluate(() => document.getElementById('ow-calibration')?.remove());
await settle(300);

// Shot 1: a new page, typed from nothing.
await exec('page.open', { id: roadmap.id });
await settle(700);
mark('new-page', 'A page is a file: make one and type into it');
await press('newPage', page.locator('.ow-new-page'));
await page.waitForTimeout(700);
const title = page.getByRole('textbox', { name: 'Page title' });
await title.click();
await page.keyboard.type('Field notes', { delay: 95 });
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const firstBlock = page.locator('.ow-block-text').first();
await firstBlock.click();
await page.keyboard.type('Everything here is a file on disk.', { delay: 60 });

// Shot 2: the selection bar, and a highlight.
await settle(500);
mark('colour', 'Colour a line without leaving the keyboard');
await page.keyboard.press('Home');
await page.keyboard.press('Shift+End');
await page.waitForTimeout(400);
await press('colourButton', page.getByRole('button', { name: 'Colour', exact: true }));
await page.waitForTimeout(450);
await press('fillYellow', page.locator('.ow-selbar-row').nth(1).getByRole('button', { name: 'yellow' }));
// Hold the result. The fill used to land 0.65 s before the cut, which is not
// long enough to see what changed; the payoff needs a beat of its own.
await settle(1400);

// Shot 3: the slash menu makes a to-do.
//
// Every step waits for the app to have caught up rather than for a fixed time:
// the editor is a controlled contenteditable, so a keystroke that arrives while
// the previous command is still in flight lands at the previous caret -- which
// is how "/todo" ended up as literal text in the wrong block.
const caretInLastBlock = () =>
  page.waitForFunction(() => {
    const blocks = [...document.querySelectorAll('.ow-block-text')];
    const last = blocks[blocks.length - 1];
    return Boolean(last) && last.contains(document.activeElement);
  });

mark('todo', 'Type a slash and the blocks come to you');
await page.keyboard.press('End');
await settle(250);
const blocksBefore = await page.locator('.ow-block-text').count();
await page.keyboard.press('Enter');
await page.waitForFunction(
  (n) => document.querySelectorAll('.ow-block-text').length === n,
  blocksBefore + 1,
);
await caretInLastBlock();
await page.keyboard.type('/', { delay: 80 });
await page.locator('.ow-slash').waitFor({ state: 'visible' });
await page.keyboard.type('todo', { delay: 90 });
await page.waitForFunction(
  () => document.querySelectorAll('.ow-slash-item').length === 1,
);
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => [...document.querySelectorAll('.ow-block')].some((b) => b.dataset.type === 'todo'),
);
// Picking a list block leaves the caret in that block with a fresh empty
// paragraph below it, so "the last block" is the wrong place to wait for.
await page.waitForFunction(() => {
  const todo = [...document.querySelectorAll('.ow-block')].find((b) => b.dataset.type === 'todo');
  return Boolean(todo) && todo.contains(document.activeElement);
});
await settle(250);
await page.keyboard.type('Sync the folder with the team', { delay: 55 });

// Shot 4: the page's typeface, changed from the page menu.
await settle(500);
mark('font', 'Every page carries its own typeface');
await press('pageOptions', page.getByRole('button', { name: 'Page options' }));
await page.waitForTimeout(450);
await press('fontSerif', page.getByRole('menuitem', { name: 'Serif', exact: true }));
await page.waitForTimeout(1400);

// Shot 5: a database row, added the way a person adds one.
await settle(500);
mark('database', 'Databases are pages too');
await press('readingList', page.locator('.ow-row-main', { hasText: 'Reading list' }).first());
await page.waitForTimeout(800);
const addRow = page.locator('.ow-db-add-btn');
await press('addRow', addRow);
await page.waitForTimeout(900);
// The title cell is an input; it commits on blur, so the row keeps its name
// after the take moves on.
await press('newRowTitle', page.locator('.ow-db-title-input').last());
await page.keyboard.type('The Timeless Way of Building', { delay: 55 });
await page.keyboard.press('Tab');
await page.waitForTimeout(600);

// Shot 6: the same rows as a board.
mark('board', 'The same rows, as a board');
await press('boardTab', page.locator('.ow-db-view', { hasText: 'Board' }).first());
await settle(1200);

// Shot 7: quick find, with no pointer at all. This is the one beat where the
// keyboard does the navigating, which is the point of the app it is showing.
await settle(400);
mark('find', 'Find any page by typing its name');
await page.keyboard.press('Control+p');
await page.locator('.ow-find-input').waitFor({ state: 'visible' });
await page.keyboard.type('design', { delay: 90 });
await page.waitForFunction(() => document.querySelectorAll('.ow-find-item').length > 0);
await settle(400);
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.querySelector('.ow-page-title')?.textContent?.trim() === 'Design system',
);
await settle(1100);

// A tail so the last shot is not cut off mid-action.
await settle(600);
current.endMs = clock();

await app.close();
// Playwright writes the video when the context closes. A plain timer, because
// the page it would wait on is the one that just closed.
await new Promise((r) => setTimeout(r, 2000));

const videos = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
if (videos.length !== 1) throw new Error(`expected one recording, found ${videos.join(', ')}`);
const source = join(videoDir, videos[0]);

// Line up the take inside the file.
//
// Not from the file's duration: the recorder writes variable frame rate video,
// so "length of the file" and "wall-clock the recorder ran" are not the same
// number, and the error is big enough to put the wrong action in a shot. A
// short full-window flash immediately before the take gives a landmark in the
// file itself: find the frame where the red ends, and the clock time of that
// same moment is known.
const FLASH_FPS = 20;
const scanSeconds = 12;
const raw = execFileSync('ffmpeg', [
  '-v', 'error',
  '-t', String(scanSeconds),
  '-i', source,
  '-vf', `fps=${FLASH_FPS},scale=1:1:flags=area`,
  '-pix_fmt', 'rgb24',
  '-f', 'rawvideo',
  '-',
]);
let lastRed = -1;
for (let i = Math.floor(raw.length / 3) - 1; i >= 0; i -= 1) {
  if (raw[i * 3] > 180 && raw[i * 3 + 1] < 80 && raw[i * 3 + 2] < 80) {
    lastRed = i;
    break;
  }
}
if (lastRed < 0) throw new Error('the calibration flash is not in the recording');
const offset = (lastRed + 1) / FLASH_FPS - (flashEndMs - shots[0].startMs) / 1000;
if (!(offset > 0 && offset < 60)) throw new Error(`implausible video offset: ${offset}`);

const manifest = [];
for (const [i, shot] of shots.entries()) {
  const start = offset + (shot.startMs - shots[0].startMs) / 1000;
  const len = (shot.endMs - shot.startMs) / 1000;
  const file = `shot-${i + 1}.mp4`;
  // All-intra: the renderer seeks to a time per frame, and an inter-frame codec
  // makes every seek decode from the previous keyframe. -g 1 costs file size
  // and buys exact, fast seeks.
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', start.toFixed(3),
    '-i', source,
    '-t', len.toFixed(3),
    '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-g', '1', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    join(shotsDir, file),
  ]);
  manifest.push({ file, name: shot.name, note: shot.note, duration: len, cues: shot.cues });
  const cueList = shot.cues.map((c) => `${c.name}@${c.t.toFixed(2)}`).join(' ');
  console.log(`shot ${i + 1} ${shot.name.padEnd(10)} ${len.toFixed(2)}s  ${cueList}`);
}

writeFileSync(join(metaDir, 'shots.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const total = manifest.reduce((n, s) => n + s.duration, 0);
console.log(`take ${total.toFixed(2)}s in ${manifest.length} shots (video offset ${offset.toFixed(2)}s)`);

for (const d of [videoDir, dir, profile]) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
