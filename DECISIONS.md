# DECISIONS

> Decision log. Newest first.
>
> Format: what was decided, why, and what would change it. A decision with no
> revisit condition is one nobody examined.

---

## 2026-10-20 — The application icon must be original artwork before publication

**Decision.** Replace the shipped icon with original artwork. Not yet done.

**Why.** The current icon is the reference product's mark. The clean-room rules
forbid shipping another product's assets, and the original prompt names this
exact look — a black-and-white N in a rounded square — as the thing to avoid.
The product is MIT-licensed and claims to be clean-room; shipping the mark makes
that claim untrue, and it is the one thing in the repository that a reviewer
could use to dismiss the whole project.

**Revisit if** never. This is a rule, not a preference.

---

## 2026-10-19 — Each e2e launch gets its own Chromium profile

**Decision.** `OW_USER_DATA` overrides `app.setPath('userData')` before ready;
the test harness passes a fresh temp directory per launch.

**Why.** All 65 launches shared `%APPDATA%\Electron`, so one launch's profile
lock was still held by a process that had not finished exiting when the next
started — producing `electron.launch: WebSocket error: read ECONNRESET` across a
burst of tests. The same sharing is why a preference written by an earlier run
was still in place for the next: preferences live in localStorage on the
`file://` origin, which is per-profile.

Electron's `--user-data-dir` is not honoured by this build, which is why
`appearance.spec` had been passing that flag and silently getting the shared
profile anyway.

**Revisit if** Electron ever honours the switch, in which case the env override
becomes redundant. Do not remove it without checking.

---

## 2026-10-19 — Numbered list markers come from a CSS counter

**Decision.** `counter-reset` on the block list, `counter-increment` on each
numbered item, rendered through `::before` on a gutter marker.

**Why.** A digit computed in the model must be stored, and a stored digit can
drift out of step with what is on screen after a drag, a delete or an indent. A
counter keyed on document order renumbers itself.

**Revisit if** numbered lists are nested. The counter is currently flat across
the page, so a nested numbered list continues counting rather than restarting.
The reference restarts per contiguous run — that is the trigger to scope the
counter to sibling groups.

---

## 2026-10-19 — Settings live behind one control, not in the sidebar

**Decision.** Appearance, text size, content width, accent and zoom moved out of
the sidebar body into a dialog.

**Why.** Six labelled control groups stacked under the page tree made the
sidebar read as a settings panel with a page list wedged into it, and pushed the
navigation below the fold. The tree is what the sidebar is for.

**Revisit if** a settings control becomes something a user needs constantly.

---

## 2026-10-19 — Marks render unconditionally

**Decision.** Block runs are drawn whether or not the block is focused.

**Why.** The first version swapped to a bare string on focus, to avoid React
reconciling spans under a live caret. That replaced the child nodes and
destroyed the selection anchor, so **no text selection could be made at all** —
which is why the mark shortcuts had never been exercisable from the UI.

Rendering always, plus a layout effect that re-places the caret, is the smaller
set of surprises.

**Revisit if** typing in a heavily marked block turns out to fight the caret.

---

## 2026-10-19 — Block types come from the registry, never a hand-kept list

**Decision.** `block.insert`'s enum, the turn-into commands and the slash menu
all read the block definitions.

**Why.** Three separate lists of block types had each drifted. `block.insert`
rejected `tableOfContents` — a type the slash menu offered — because its list
was twelve entries out of date.

**Revisit never.** This is the shape that prevents a whole bug class.

---

## 2026-10-19 — The op log appends after the flush, and only for undoable commands

**Decision.** Every undoable mutation appends one row after the session flush.
Navigation and undo do not.

**Why.** Appending before the flush would let the log claim a change the
database does not have. Logging `page.open` would make a future replay
re-apply a navigation; logging `history.undo` would replay an undo as though
it were a change of mind.

`lamport` is read from the current maximum rather than taken from the caller,
because a caller-supplied clock is a clock that can go backwards and ordering is
the one thing the table is for.

**Revisit if** sync is actually built — the log is written for that, not for
this.

---

## 2026-10-19 — Assert computed styles, not the model

**Decision.** Any test about something appearing on screen reads a computed
style, not the database.

**Why.** Marks were stored correctly, applied by working commands, and rendered
as plain text for most of the project's life. Every mark test asserted the
model after the command. That proves the command ran; it does not prove the
user can see the result.

**Revisit never.**

---

## 2026-10-19 — Light theme is the default, not the OS setting

**Decision.** The app opens light whatever the operating system says. A
three-state `light / system / dark` preference still expresses "follow the
machine".

**Why.** Operator requirement, stated and consistent across the project.

**Cost, recorded honestly.** This is a deviation from reference behaviour, where
the theme follows the OS. It is a small behavioural difference in a product
whose success bar is "the user should never think this works differently".

**Revisit if** the operator decides reference parity matters more than the
light default. It is one line of code either way.

---

## 2026-10-19 — The editor is a custom model, not ProseMirror

**Decision.** Build the block editor on a custom document model.

**Why.** The original prompt offered both, and made a custom model conditional
on "an ADR with a plan for IME and composition, and tests proving them". The
model is built and the editor works; the ADR and the IME tests do not exist.

**Revisit if** IME composition proves unfixable in the custom model. Until then
the missing ADR is a documentation debt, not a technical blocker. **Do not
record this decision as complete until the ADR exists.**

---

## Earlier in the project

| Decision | Why | Revisit when |
|---|---|---|
| Preferences live in `localStorage`, not the database | A display preference is not document data. Every field is validated on read; a corrupt value falls back rather than failing to open. | Never |
| `--ow-accent` is validated as six hex digits | It becomes a CSS colour. Validation is what prevents injection. | Never |
| Zoom is clamped rather than rejected | Falling back to 100% looks like the setting had no effect. | If zoom gains a range control |
| Text size scales the page body only | Scaling root font would make the sidebar unreadable at large. | Never |
| Scroll restore uses `useLayoutEffect` | A normal effect runs before paint, and `scrollTop` against a stale layout is discarded. | Never |
| Links render as spans, not anchors | An anchor inside a `contenteditable` swallows the click, so the caret can never be placed inside a linked word. | Never |
| Quick find resets on query change, clamps on results | Resetting when results land throws away an arrow press made in the meantime. | Never |
| A menu item states the state it turns *on* | "Full width" with no tick is ambiguous; "Switch to narrow" is not. | Never |
| Numbering is computed from sibling order, never stored | A stored number drifts out of step with the screen. | Never |
| The command registry is the only door into the model | It is what makes the app drivable by an agent and testable headlessly. | Never |
