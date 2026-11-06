# Requirements from the operator

These are acceptance criteria, taken from the operator's own brief and recorded
here as the checklist the project is measured against. Each maps to one or more
`parity/ledger.csv` rows.

## R1 — Nested pages to any depth, with favorites, trash and restore
Pages nest without limit. A page can be favorited, moved to trash and restored.
Restoring returns it to its original parent, or to the top level when the parent
no longer exists. Trash has a retention policy (default 30 days, configurable)
and permanent deletion.

## R2 — Delete from the sidebar without opening the page
Every page and database row in the sidebar has a three-dot menu. The menu
contains other actions (duplicate, rename, move) **and a clearly labelled
"Move to Trash" action that is visually distinct** — danger styling with an
icon — so a page can be deleted without being opened. A confirmation or an undo
toast follows.

## R3 — Settings that work and persist
At minimum: theme, interface text size, accent colour, page width and zoom.
These must behave correctly (including page text-size behaviour and settings
dropdowns) and persist across restarts.

## R4 — Databases
Table, board, calendar, gallery and list views. Common field types. Filtering,
sorting, and status changes.

## R5 — Markdown and CSV import and export
Import a page tree from Markdown; import a CSV as a database with inferred
types. Export pages to Markdown and databases to CSV.

## R6 — Page history
Automatic versions of a page, listable, previewable and restorable. Restoring
creates a new version rather than destroying old ones.

## R7 — A real installer with a setup wizard
Not a silent one-click installer. A guided wizard with a licence page, an
install-location choice and shortcut options. Release artifacts also include a
source archive and a short project overview document.

## R8 — Feel like the real product, and be open source from the ground up
The target is "as if it were 1:1" in behaviour and feel. The entire codebase,
assets, docs and build are open source under a permissive licence from the first
commit.

## R9 — Clean-room provenance
No vendor source code, assets or marks. Asset attribution recorded. No network
dependency. Fully offline and local-first.