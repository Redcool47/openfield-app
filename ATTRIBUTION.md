# Attribution

Every bundled asset, with its author, source and licence. The `attribution` CI
task fails when a file exists under `assets/` or `fonts/` that is not listed
here.

## Current state

**No third-party artwork, fonts or icons are bundled.** The project ships no
`assets/` or `fonts/` directory. This is deliberate rather than pending: until
the renderer exists there is nothing to bundle, and adding a placeholder icon
now would only mean replacing it later.

## Icons

Planned. The intended set is **Lucide** (ISC licence) or **Phosphor Icons**
(MIT licence), chosen at implementation time and recorded here before use. Both
are permissively licensed and allow derivative works without a share-alike
obligation.

The application's own logo and wordmark will be **original artwork authored for
this project**. It will not resemble, reproduce or parody any other product's
mark, and in particular will not use a monochrome square glyph with a letter cut
out of it.

## Fonts

Planned. The intended choices are all under the SIL Open Font License 1.1:

| Family | Author | Source | Licence |
|---|---|---|---|
| Inter | Rasmus Andersson | https://github.com/rsms/inter | OFL-1.1 |
| Source Serif 4 | Frank Grießhammer | https://github.com/adobe-fonts/source-serif | OFL-1.1 |
| JetBrains Mono | JetBrains | https://github.com/JetBrains/JetBrainsMono | OFL-1.1 |

Font *metrics* are what matter for layout parity; glyph shapes are not copied
from any other product. System font stacks are used as a fallback so the
application still works if the bundled fonts fail to load.

## Sample content

All starter pages, template text and empty-state strings are written for this
project. No content from any other product, real user account or example
dataset is included anywhere in this repository.

## Reference analysis material

The third-party desktop build supplied for behavioural study is **not** part of
this repository, is not redistributed, and is excluded by `.gitignore`. Only
original interface notes and evidence identifiers derived from it are committed,
as described in `docs/shell-architecture.md`. No code, string, font, image or
other asset from that build appears in this repository or in any build produced
from it.
## Trailer media

`trailer/sfx/` holds three recorded sound effects used by the showcase video.
They come from the Pixabay sound-effects library and are used under the
**Pixabay Content License**, which permits commercial use without attribution:

| File | Used for | Source | Licence |
|---|---|---|---|
| `click-soft.mp3` | a mouse press on a sidebar row or view tab | pixabay.com/sound-effects/ | Pixabay Content License |
| `whoosh-short.mp3` | the cut between two shots | pixabay.com/sound-effects/ | Pixabay Content License |
| `chime.mp3` | the closing card | pixabay.com/sound-effects/ | Pixabay Content License |

They are not part of the application, are not shipped in any installer, and are
not redistributed as a library. The earlier synthesised tones were replaced
because they sounded like test signals rather than like a desk.

## Application icon

### The mark in use

`apps/desktop/build/logo.png` is **operator-supplied artwork**, supplied directly
by the project owner as the intended application mark. It is used verbatim:
`win.icon` embeds it in the executable and installer, and `dev.mjs` copies it
into `dist/build/` so the window icon resolves at runtime. No pixel of it is
modified.

### The generated fallback

`apps/desktop/build/icon.png` and `icon.ico` are generated, not sourced. Run
`node tools/make-icon.mjs` to reproduce them byte-for-byte from the drawing code
in that file; `--preview` additionally writes each embedded size separately for
review.

Original artwork by this project. It is deliberately not a cube with a letter cut
out of it, a stylised N, or a document silhouette with a folded corner; those
read as relatives of other workspace products, or are used by everything. The
colours are taken from `design/tokens.json` so the icon belongs to the same system
as the running application. No third-party asset, font or icon set is bundled.
