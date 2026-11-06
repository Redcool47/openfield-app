# External references

Where design ideas came from, and what was taken. This file is internal: it is
not packaged. `apps/desktop/package.json` sets `files` to `["dist/**/*",
"package.json"]`, so no markdown from this repository ships inside the app; the
only `.md` files in `app.asar` are the licence files of bundled dependencies.

Read this as an audit trail. The rule this project works to is that analysis
informs behaviour and every line of code is our own, so the useful question about
any reference is not "was it permitted" but "what actually changed because we
read it, and can that be stated precisely".

## The proprietary desktop build

Covered in detail in `docs/shell-architecture.md` and `ATTRIBUTION.md`. Not
redistributed, excluded by `.gitignore`, present only under `analysis/raw/`.
Behaviour was observed from it; nothing was copied. Where behaviour could not be
observed it is marked `[HINT]` in `parity/ledger.csv` rather than guessed, and
the reason is written down in `docs/reference-findings.md` -- chiefly that the
reference renders a remote UI, so its renderer bundles contain no CSS and no
fonts at all, and spacing cannot be measured from it.

## An Apache-2.0 open-source local-first notes application

Supplied for study alongside the proprietary build. Its licence was **verified
from the distributed archive** rather than taken on trust: the `LICENSE` file is
the Apache License 2.0 text and `package.json` declares `"license":
"Apache-2.0"`. That licence is on this project's allowed list, so use would have
been permitted with attribution.

What was taken, precisely:

- **Pseudo-properties.** The idea that every row has `title`, `created` and
  `updated` whether or not the schema declares them. This was the one genuine
  gap it exposed: without them a table cannot be sorted by when a page was last
  touched, and the workaround would have been a real column every database has
  to carry forever. Implemented independently in
  `packages/commands/src/view-query.ts`.
- **A filter operator vocabulary restricted per property type.** Offering "is
  greater than" on a checkbox either compares by code point -- which looks like it
  works and means nothing to the person using it -- or refuses at the last moment.
- **Grouping that emits a column for every declared option, including empty
  ones.** An empty column is the only place a "nothing here yet" state can live.

Also studied for the interface, and acted on:

- **Interaction states as alpha overlays rather than solid colours.** This was
  the most useful thing in the whole exercise. A solid hover token needs one value
  per surface and is wrong the moment a surface is tinted; an overlay composites
  correctly on whatever is behind it. See `tools/fix-interaction-tokens.mjs`.
- **Two-layer shadows.** A tight contact shadow and a wide ambient one. A single
  value reads as a sticker rather than a lifted surface.
- **A dedicated code background.** Previously faked with the selected-row token,
  which is right for a row and far too light for a code panel.

What was not taken: any code, any asset, any font, any icon, and no distinctive
interface string. Nothing was transcribed. That project stores pages as Markdown
files with an IndexedDB index and drives a Tiptap editor; this project stores a
document in SQLite, drives its own contenteditable block editor, and exposes every
mutation as a named command. The architectures are different and the shared ideas
are the small, publicly-obvious ones -- pseudo-properties, per-type operators,
empty groups.

The reference is not a dependency, appears in no `package.json`, and contributes
no build input. `THIRD_PARTY_NOTICES.md` lists dependencies only and so does not
name it.

If that ever stops being true -- if a line is ever transcribed, or the project
becomes a dependency -- this file is where it must be recorded, and
`THIRD_PARTY_NOTICES.md` as well.