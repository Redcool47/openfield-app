# PROGRESS

> A dated diary. Newest first. Append; do not rewrite.
>
> Not a changelog — `git log` is that. This records **what was found, what it
> meant, and what follows**, because the reasons are not in the diffs.

---

## 2026-10-21 — Session eight: equations, tags, wiki links, callouts, and a folder you can point at

### Equations are drawn as equations

There is a small LaTeX parser in the model and a renderer in the ui-kit, and
the text of an equation is the text as it is *drawn* rather than the LaTeX.

That last part is the whole trick. The editor compares what is on the screen
with what the model holds, and a difference between the two is a difference
the editor has to resolve. An equation whose stored text was `x^2` and whose
drawn text was `x²` would tear itself apart on the next keystroke.

The parser is in the model rather than in the interface for that reason alone:
the drawing and the stored text come from one parse, or they drift.

### Tags, wiki links and callouts

Three syntaxes that turn themselves into something, sharing one mechanism. The
rules fire on the closing character, because that is the only moment at which
the token is complete. A tag is the exception — its name is not finished until
the word is, so it fires on the space after it.

A wiki link names another page, and a title that matches no page is left as
text: a link that goes nowhere is worse than text.

A callout is a quote whose first line names the kind, in the syntax every
other tool that writes Markdown with callouts uses. A note written elsewhere
should arrive as a note and not as a quote.

### Two things had to change underneath

**`block.setText` now splices instead of replacing.** It used to write the
whole content, which deleted every mention, equation and tag in the block on
the next keystroke. It now works out the smallest edit that turns the old
text into the new one and splices that, so the nodes outside it survive. This
was a real bug that had been there since mentions were added, and it was
visible the moment an equation existed to be destroyed.

**The editor's pending text gives way when the texts agree.** The pending text
is what the user has typed, held until the model catches up. When the two texts
agree the model is authoritative, because it holds the markup a draft cannot.

### An import that takes a folder

Export your pages, unzip the export, point the app at the folder. Every
Markdown file becomes a page, every CSV becomes a database, and the heading of
a file becomes the title of the page. It is in Settings, Import.

The path is typed rather than chosen with a file dialog: the application has
no dialog yet, and a path that can be pasted is the one that works on every
platform.

---

## 2026-10-21 — Session seven: the notes are files now, and the settings dialog was broken in a way nobody had looked at

### The settings was stuck in the corner, and the reason was a name collision

Two layers, one class name. The ui-kit owned `.ow-modal` for a *dialog card* —
520px wide, with its own background, radius and shadow. The application used
the same name for the *full-screen scrim* that holds a dialog. The
application's CSS is imported after the ui-kit's, so the scrim inherited the
card's `width: min(520px, ...)`, and a fixed element with a width and
`inset: 0` is over-constrained: the width wins and the right inset is
ignored. So the overlay was 520px wide and anchored to the top-left corner
instead of covering the window.

The card also asked for `--ow-bg-raised`, a token that does not exist. An
unknown variable makes the whole declaration invalid, so the card was
transparent and the page showed through it.

Neither of these was visible in a test, because the old settings sheet was
narrow enough to fit in the corner and the tests never looked at what was
behind it. The overlay is now `.ow-overlay` and the dialog `.ow-dialog`, and
the settings are a navigation rail and a pane rather than six groups stacked
in a sheet.

The same collision had been hiding the cheat sheet test: the sheet could be
opened but not closed, because the settings dialog underneath it was covering
the button that opened it.

### The notes are Markdown files now

SQLite is right for speed and atomicity and wrong for everything else. Another
program cannot open a database, and a file-sync tool carrying a live SQLite
file between two machines will eventually hand both of them a corrupt one.
Syncthing, iCloud Drive, Dropbox and a home server over SMB all want files.

So every page is also written as a Markdown file with plain frontmatter, in a
folder the user points at whatever they already sync. The database stays on
the machine that wrote it.

The direction that matters is the one nobody thinks about: a file that changed
*outside* the app has to come back in. A page is re-read when the hash of its
file no longer matches the hash recorded when the app last wrote it. Hashes
rather than timestamps, because two machines have two clocks and a sync tool
does not preserve them.

A child page lives in a folder named after its parent, so the folder tree in
any file browser is the page tree.

### AI, off until it is turned on

There is no default provider and no default key. Settings, Advanced, AI holds
the provider — OpenRouter, OpenAI, Anthropic, Google, Groq, DeepSeek, a local
Ollama, or any OpenAI-compatible gateway — the model, and the key.

The key is stored in the workspace database and is never handed back to the
renderer. The panel gets a hint and a flag, not the key, so it cannot be
shown, logged or copied by accident.

A small bubble in the bottom-left corner opens a chat. The bubble only exists
when AI can do something: the user has turned it on and pasted in a key. An
application with a permanent AI button in the corner is an application asking
to be used by a machine rather than by a person.

Debug mode is in the Advanced section. It shows the things that are normally
hidden: the bubble even when AI is off, and a diagnostics readout.

### Typing still lost characters, intermittently

Two bugs, and the second was behind the first.

The guard that stopped the model overwriting the screen compared the model
against a *remembered* copy of what had been typed. That is not the same
thing as what was on the screen, and the two come apart exactly when it
matters.

And the app re-placed the caret on every state push. A push arrives on every
keystroke, so the caret was moved out from under the user continuously, and
when the stored offset had been measured against different text it landed in
the wrong place — the rest of the word was then typed there, and
`Hello Openfield` arrived as `lo OpenfieldHel`.

The guard is now anchored to the screen, and the caret is only put back when
the text underneath it has actually moved. Six consecutive runs of the typing
tests pass, where it failed about one run in five before.

---

## 2026-10-20 — Session six: the dropped keystroke was two bugs, and the second was wearing the first one's clothes

### The character that vanished

Helo Openfield. One character gone, intermittently, always under load.

The note in docs/gaps.md blamed React: the block's text is controlled and comes
from the model, so a keystroke that arrives while the previous round trip is in
flight is overwritten by the re-render. That was true and it was not the whole
truth. There were **two** writers, and the second one bypassed React entirely:

1. React's commit — the block's children are rendered from the model.
2. syncText, a layout effect that wrote el.textContent = row.text on every
   state push.

A local buffer in React cannot stop the second one. That is why the first attempt
at this fix did nothing: the draft was correct in React's render, and
syncText overwrote it a microsecond later.

### The fix

The editor keeps the text the user has typed — the *pending text* — and the DOM
is the copy that holds the character:

- The pending text is what React renders for that block.
- syncText refuses to write the model over a block whose pending text
  disagrees with the model: the model is behind, and the DOM is the only copy
  that has the character.
- The pending text is dropped when the model catches up. un resolves *after*
  the state push, so a resolved lock.setText means the model has the text.
- Every command other than typing clears it, because for those the model is
  authoritative. Undo is the case that matters.

### The second bug, which had been hiding behind the first

Dropping the pending text re-renders the block from the model's runs, which
replaces the element's children, and replacing children collapses the selection
into the element. The caret-restoring layout effect did not re-run — its
dependencies had not changed — so the caret sat at the start of the block and the
rest of the word was typed there.

Hello Openfield arrived as lo OpenfieldHel.

The undo test in desktop-editor.spec.ts failed **six times out of six** before
the fix and passes now: the caret bug had been corrupting the *model's* text, not
just the display. A test that only reads the screen would not have caught that,
which is why the new test reads the model as well.

### Also in this session

Page lock, last-edited-by-and-on, and backlinks. The locked column had been in
the schema since the first migration with nothing writing to it — a column is not
a feature. A mention is an inline node in a block's content, so the backlink
index is the content itself; the SQL narrows with a LIKE and the rows are then
parsed and checked, because a LIKE match alone reports a page that merely
contains the same characters.

---

## 2026-10-20 — Session four: the visual pass, and two test-infrastructure bugs

### The settings panel was eating the sidebar

Comparing our shell against the operator's reference frame side by side showed
the real problem was structural, not cosmetic: six labelled control groups
(Appearance, Keyboard, Text size, Content width, Accent, Zoom) sat permanently
in the sidebar body, under the page tree. The sidebar read as a settings panel
with a page list wedged into it.

Moved behind one Settings control. The cheat sheet became its own dialog rather
than nested inside Settings — two `role="dialog"` elements inside one another
is a modal inside a modal. The most recently opened one now wins by z-index
rather than by source order, so that stays true if the two blocks are reordered.

**Should follow:** the top bar still carries back/forward chevrons where the
reference has a sidebar toggle and a breadcrumb.

### Three rendering defects, all found by looking rather than by testing

- **Numbered list items had no number at all**, and bulleted ones drew their
  bullet twice — once from a pre-existing `::before` on the item's own text,
  once from the new gutter marker. Numbers now come from a CSS counter keyed on
  document order, so they renumber after a drag or a delete rather than needing
  a stored digit that can drift out of step with the screen.
- **Code blocks rendered as a panel inside a panel** with a visible seam:
  `.ow-block-mono` set a background, border and padding on the editable line
  while `.ow-block-code` set another background, radius and padding on the block
  around it. One box now.

`tests/e2e/ui-reference.spec.ts` captures our shell on the same content as the
reference frame, so the comparison is repeatable rather than something done once
by eye.

### CI went red, and the cause was not any test

`electron.launch: WebSocket error: read ECONNRESET` across a burst of tests.
Every launch shared `%APPDATA%\Electron`, so one launch's profile lock was
still held by a process that had not finished exiting when the next one started.

`OW_USER_DATA` now overrides `userData` before ready. Electron's own
`--user-data-dir` is not honoured by this build, which is why `appearance.spec`
had been passing that flag and silently getting the shared profile anyway.

This was also the root cause of something patched around earlier without being
identified: preferences live in localStorage on the `file://` origin, which is
per-profile. `settings.spec` was clearing localStorage and reloading to work
around a zoom of 110 left by an earlier run. The scrub is gone; the test gets a
private profile instead.

The e2e step went from **10 minutes failing to 5.7 minutes passing** — the lock
contention had been serialising launches.

### The compliance finding

The shipped application icon is the reference product's mark. The original
prompt names this exact look as the thing to avoid, and the clean-room rules
forbid shipping another product's assets. It has to be replaced with original
artwork before the project is published. It is not a ledger row, because the
ledger tracks features and this is compliance — so it is recorded here and in
`STATUS.md` instead.

### Parity: 80.9% → 84.8%

Eight rows completed: page appearance, table of contents, rubber-band select and
autoscroll, sidebar drag, page move (with a real orphaning bug fixed), Recents,
the append-only op log, page properties for database rows, and `@` mentions.

---

## 2026-10-19 — Session three: the stored-but-invisible bug

### Marks were saved and never drawn

`Session.outline()` sent only the plain text of each block, so the renderer had
nothing to draw formatting from. Bold, italic, underline, strikethrough, code,
colour and links were all applied by their commands, recorded correctly in the
model, and then rendered as undifferentiated text. Toggling bold did nothing
visible.

Every existing mark test asserted the **model** after the command. That proves
the command ran; it does not prove the user can see anything.

**This is the most useful lesson in the project.** Any test that reads the
database after a UI action is testing the wrong layer. Prefer computed styles.

Two related hollow features turned up in the same search:

- `tableOfContents` had been in the block registry since the first release and
  rendered as an ordinary paragraph.
- `block.insert` **rejected** `tableOfContents`, because its argument enum was
  a hand-kept list of twelve types that had drifted from the registry. Two lists
  of block types, both maintained by hand, both stale.

Both now read `BLOCK_DEFINITIONS`.

### The app could not make a text selection at all

Swapping the editable line to a bare string on focus replaced its child nodes
and destroyed the selection anchor, so the caret pointed at the element rather
than a text offset. This is also why the mark shortcuts had never been
exercisable from the UI — Ctrl+B needs a selection to mean anything.

The floating selection toolbar then measured its position during render, which
never re-renders on scroll, so it stayed put while its text moved away. It now
re-measures on scroll and resize.

### A data-loss bug, found by a test rather than by reading

`page.move` took `(args.parentPage as string) ?? null`. An empty string is not
nullish, so it went straight into `parent_page`, producing a page whose parent
does not exist. The tree walk starts at the root and never visits it: the
command reported success and the page vanished from the sidebar with no way
back. The sidebar's own "Move to..." top-level entry passed exactly that value,
so it was reachable by clicking.

### Parity: 78.2% → 80.9%

---

## 2026-10-19 — Session two: hollow rows

Working the ledger honestly surfaced a pattern worth naming: **several features
were declared in the schema or the registry and never wired to anything.**
`op_log`, `recent`, `asset` and `page_version` all had tables in the first
migration and nothing writing to them. `noteOpened` and `recentPages` existed and
were already called; only the sidebar section was missing.

Also fixed: quick find reset the highlighted row to 0 when debounced results
landed, which is after the user has usually already pressed a key. Arrowing to
the second result and waiting for the list silently snapped the highlight back
and Enter opened the wrong row. This surfaced as an intermittent e2e failure and
is a real misbehaviour, not a test artefact.

---

## 2026-10-19 — Session one: the e2e suite was writing to the real workspace

Every e2e run opened and wrote the user's actual workspace. That is why the app
had accumulated 414 junk pages, and why three slash-menu tests passed alone and
failed together — each inherited the previous one's pages, so the caret landed
mid-line, the slash was no longer at the start of the line, and the menu
correctly refused to open.

`OW_WORKSPACE` overrides the workspace directory and the harness gives each test
its own. Verified by running the full suite twice in a row: 16 passed both times,
where before the second run failed.

---

## 2026-10-17 — Project start

Brief recorded as R1–R9 in `docs/requirements-from-operator.md`. Clean-room
rules, layered architecture, and a command registry as the only door into the
model. See `PROMPT.md` for the operating manual and the corrections the later
sessions earned.
