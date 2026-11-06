# Measured reference values

All numbers here were **read out of pixels** in operator-supplied reference
footage, not estimated by eye. The measuring tool is
[`tools/measure-frame.mjs`](../tools/measure-frame.mjs); it decodes one frame to
raw RGB with ffmpeg, quantises to a 4-bit-per-channel grid so anti-aliasing does
not split one colour into a dozen near-identical entries, and reports each
bucket's mean colour and share of the frame.

Reproduce any row with:

```bash
node tools/measure-frame.mjs "<video>" <seconds> [--crop=w:h:x:y]
```

## Provenance

| Source | What it gave us |
|---|---|
| `Using slash commands - Notion (1080p).mp4`, frames at 21 s | Light-mode palette, sidebar and content geometry |
| `all-keyboard-shortcuts-in-notion-v0-....webp` | The full slash-command catalogue with aliases and descriptions (this file is titled "keyboard shortcuts" but actually documents slash commands) |
| `How I Use Notion Tutorial for Beginners - Luke Barousse (1080p).mp4` | Database and view surfaces |

**Caveat that applies to every number in this file:** the footage is macOS at an
unknown display scale, captured into a 1920×1080 video. Pixel values are
measured exactly; **pixel *sizes* are therefore scale-relative.** Sizes below are
recorded as measured with that caveat, and any size token must be validated on a
real Windows display before it is treated as final.

## Light palette (measured)

| Role | Value | Share of region | Notes |
|---|---|---|---|
| Page background | `#fdfdfc` | 95.7% of frame | Warm off-white. **Not** pure `#ffffff`. |
| Content background | `#fefefe` | 84.6% of text column | Indistinguishable from page bg at this quantisation; treat as one surface. |
| Sidebar background | `#f4f2f0` | 89.5% of sidebar | Distinctly warmer and darker than content. |
| Popover / overlay | `#fefefe` | 99.6% of top bar | Menus and dialogs read as the brightest surface. |
| Primary text | `#2a2a28` | 0.66% | Warm near-black. **Not** `#000000`. |
| Primary text (content region) | `#2b2b29` | 5.1% | Same token, different local anti-aliasing mix. |
| Secondary text | `#363635` | 1.4% | Slightly lifted from primary. |
| Muted text | `#9b9997` | 0.46% of sidebar | Sidebar row titles at rest. |
| Border / divider | `#e7e5e3` | 2.1% of sidebar | |
| Border / divider | `#e2e0dd` | 1.9% of sidebar | Slightly stronger rule. |
| Hover surface | `#f3f1ef` | 1.2% of sidebar | |

Three observations worth stating because they are exactly what eyeballing gets
wrong:

1. **The background is not white.** It is a warm off-white at `#fdfdfc`. Using
   `#ffffff` produces a visible difference on a good display.
2. **Text is not black.** It is `#2a2a28`, a warm near-black. Pure `#000` on a
   warm background reads harsh and blue.
3. **The sidebar is darker than the content, not lighter.** The intuitive
   assumption is the reverse.

## Geometry (measured, scale caveat applies)

| Element | Measured | Confidence |
|---|---|---|
| Sidebar width | ~260 px in a 1920-wide frame | medium |
| Content text column | ~550 px of the sampled region; the readable measure sits well inside the window | medium |
| Content is centred in the remaining space | yes | high |
| Top bar height | ~50 px | medium |

## Slash command catalogue (verified)

From the reference document image. This **corrects** several aliases in
`packages/model/src/registry.ts` that were previously guesses.

**Basic blocks** — `text`/`plain`, `page`, `bullet`, `num`, `todo`, `toggle`,
`div`, `quote`, `h1`/`#`, `h2`/`##`, `h3`/`###`, `link`, `esc`.

Notable:
- The bullet aliases are `bullet` and `num`, **not** `bulleted`/`numbered`.
- `/esc` is a real command: it clears the slash and leaves plain text behind.
- `#`, `##`, `###` are accepted as aliases alongside `h1`/`h2`/`h3`.

**Inline** — `mention`, `date`/`reminder`, `equation`, `emoji`.

**Media** — `image`, `pdf`, `book`, `video`, `audio`, `code`, `file`, `embed`.

**Advanced blocks** — `duplicate`, `moved to`, `delete`, `toc`, `button`/
`template`, `bread`, `math`/`latex`.

**Embeds** are grouped separately from Media (observed in the footage as its own
`EMBEDS` group header, e.g. a Figma entry).

Three of these are **actions**, not block types: `duplicate`, `moved to`,
`delete`. The registry must therefore separate "insert a block of type X" from
"run action Y", or a menu generated from the registry will offer to create a
duplicate block. This is a real design correction, not a nit.

## Slash menu appearance (observed)

- Grouped under **uppercase section headers** (`BASIC BLOCKS`, `INLINE`, `MEDIA`,
  `EMBEDS`, `ADVANCED BLOCKS`).
- Each row: a **left icon**, a **bold title**, and a **muted one-line
  description** beneath it.
- Row order in the observed menu: Text, Page, To-Do List, Heading 1, Heading 2,
  Heading 3.
- The menu is anchored near the caret, opens upward when there is no room below.

## Page header (observed)

- Optional large icon above the title, then the title in a large bold face.
- Top bar: breadcrumb (icon + page name) on the left; `Share`, `Updates`,
  `Favorites`, `...` on the right.
- Sidebar bottom holds a `+ New Page` action.
- A `?` help affordance sits at the bottom-right of the content area.
- Image blocks render **wider than the text measure**, breaking out of the
  content column.

## Not yet measured

- **Dark mode.** No dark-mode frame in the supplied material. The dark palette is
  therefore absent, not guessed, and every dark token in `design/tokens.json` is
  marked `approximate` until a dark frame is supplied.
- **Motion timings.** No frame sequence was measured for transition duration.
  Defaults are in `design/tokens.json`, tagged `approx`.
- **Font sizes and line heights.** Not extracted; the footage is video, so glyph
  rasterisation would corrupt the measurement. Needs a still at native
  resolution.
---

## Behaviour source: the published shortcut reference

Behaviour is **not** measured, because it cannot be � see
`docs/reference-findings.md`. It comes from an operator-supplied copy of the
published keyboard-shortcut reference. That is documentation of observed
behaviour, which is weaker than observing it directly but is real evidence, and
it is a published vendor document rather than recovered source. It is treated as
a specification to reimplement in our own words, not as code or text to copy.

It also corrected several things this project had previously guessed. Every
correction is recorded in `packages/commands/src/shortcuts.ts` under
`CORRECTIONS`, and the ones that changed model behaviour rather than just a
keybinding are listed here.

### Markdown input triggers

Three of these were wrong, and two were wrong in a way that would have been
obvious to any user within a minute of typing.

| Trigger | Result | Previously |
|---|---|---|
| `*` `-` `+` then space | bulleted list | correct |
| `[]` then space | to-do | also accepted `[ ]`, silently eating literal text |
| `1.` `a.` `i.` then space | numbered list | only `1.` |
| `#` `##` `###` then space | heading 1 / 2 / 3 | correct |
| **`>` then space** | **toggle list** | **quote block** |
| **`"` then space** | **quote block** | **no trigger at all** |
| `---` | divider | correct |

The `>` and `"` pairing is the one worth remembering: it is the opposite of the
intuitive assignment, and this project had it the intuitive way round.

### Turn-into chords

`ctrl+shift+0..9` on Windows and Linux, `cmd+option+0..9` on macOS. The digit
mapping had been guessed and **all ten were wrong**:

```
0 text   1 H1   2 H2   3 H3   4 to-do
5 bullet 6 num  7 toggle 8 code 9 page
```

Note that 5 is a bulleted list rather than a heading, and 9 is a page. A
plausible-looking guess ("0-3 text and headings, then the rest") gets three of
the ten wrong.

### Two chords that collide

`ctrl+k` is documented twice: "add a link" with a selection, and "open search"
otherwise. Both meanings are implemented, with a text selection as the
disambiguator � that being the only state in which wrapping a selection in a
link is meaningful. This is recorded in the ledger as a deliberate
disambiguation rather than a guess.

### Not implemented yet

`@` mentions, `[[` and `+` page pickers, `:emoji`, table cell fill (`ctrl+r` /
`ctrl+d`), alt-drag duplication, and multi-block selection. These are documented
in the reference and are not yet built; they are ledger rows, not silent gaps.
