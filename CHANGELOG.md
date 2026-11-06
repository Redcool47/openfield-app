# Changelog

Versions follow `version` in `package.json`. Before 0.2.0 the project was not
released, so no release notes were kept for it; the dated diary in
[`PROGRESS.md`](PROGRESS.md) is the record of that work.

## Unreleased

### Added

- Text colour in the editor: `mark.color.set` applies any of nine named hues as
  text or as a background wash without leaving the keyboard, from the selection
  bar. Contrast is checked for every hue on every surface.
- A showcase film under `trailer/`, now recorded from the running application
  rather than composited from stills: `node trailer/record.mjs` films the real
  window through Playwright, cuts seven all-intra shots, and `trailer/index.html`
  plays them back with captions, a drawn pointer and one real click per beat.
  The last beat is quick find, keyboard only, opening a page by name. Nothing in
  the film is a mockup. 28.5 s.
- Recorded sound for that film: three Pixabay samples (`trailer/sfx/`, listed in
  `ATTRIBUTION.md`) replace the earlier synthesised tones.
- An original workspace mark in the sidebar — a field of four plots drawn as
  inline SVG. No asset file, no icon font, no borrowed artwork.

### Fixed

- A row added from a database table did not appear in the table until the page
  was reopened; the table kept its own row list and nothing refreshed it.
- A space in a row title navigated to that row's page mid-word.
- The page title could not be focused with the mouse, because the rubber-band
  selection handler treated it as page margin.
- Opening a page showed its title as the "Untitled" placeholder for a few frames
  before the real title appeared: the title was written into the heading by a
  passive effect, so an empty heading painted first.
- Naming a database row renamed the page the table was on, and renaming a page
  copied its title into the first block so it appeared twice. `page.rename` now
  honours an explicit `id` and leaves the document alone.
- `/todo` found nothing in the slash menu; the plain word is now an alias of
  "To-do list".
- The sidebar's "New page" button created a page without opening it.
- The settings rail grew a horizontal scrollbar because the nested AI tab was
  full width plus a margin.
- The "Mentioned in" panel sat above the page title; it now sits below the page
  text, where a reader arrives after reading.

## 0.2.0 — 2026-10-21

### Changed

- Version 0.2.0, covering the desktop installer targets (NSIS, portable, zip).
- [`docs/packaging-notes.md`](docs/packaging-notes.md) records what a real
  silent install on Windows taught us, including the paths that silently
  install nothing.
