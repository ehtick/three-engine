# Fonts and the code editor

Two things that used to require leaving the editor now don't: picking and
importing a typeface, and reading or changing a script. This is the reference
for both, plus the Asset Inspector rework that surfaced them.

---

## Font assets

### What a font asset is

Any `.ttf`, `.otf`, `.woff` or `.woff2` under the project. The engine does not
decode glyph outlines — text rendering (both the SDF atlas and the canvas
raster path) goes through the platform's own text stack, so a font is *used* by
registering it as a `FontFace` and naming it in `ctx.font`.

### The generated family name

A project font is **not** registered under the family name in the file. It is
registered under a generated id: `ea-<file-stem>-<hash-of-path>`.

This matters more than it looks:

- Two files can declare the same family. Register both as "Inter" and the
  second shadows the first — text renders in a font the user did not pick,
  with nothing on screen to say why.
- A project font can collide with a font *installed on the developer's
  machine*. The editor then looks right and the exported game looks wrong on
  every other computer, which is the worst possible place to discover it.

The generated id is unique by construction, deterministic across machines and
sessions, and cannot collide with a system font. The file's real name is kept
as `displayName` for the UI to show.

```js
const { family } = await engine.assets.font("Fonts/Inter/Inter-Bold.ttf");
ctx.font = `700 32px "${family}"`;
```

`engine.assets.fontFamily(path)` returns the same string synchronously (before
the load resolves) so it can go straight into a cache key.

### Readiness is not optional

A glyph rasterized before its font loads bakes the **fallback** face into an
SDF atlas that is then cached for the session. The text stays wrong until a
reload, and reloading "fixes" it — a bug that is very hard to chase.

So: `ensureFontLoaded(path)` is the only supported way in, and `onFontLoaded`
exists for caches that must throw work away when a font arrives late.
`sdfFont.js` subscribes to exactly that and drops any atlas built against a
family that has just become available.

### Metadata

`fontMeta.js` parses the SFNT container directly — `name`, `head`, `maxp`,
`OS/2`, `post`, `cmap` — to report family and style names, weight and width
class, glyph and codepoint counts, which Unicode blocks are covered, and the
`fsType` embedding permission.

That last one is the one to care about before shipping: `fsType` bit 1 means
the font may not be embedded at all. Games ship their fonts, so the Inspector
warns about a restricted face rather than letting it reach a build.

`.woff` is unwrapped (its tables are individually zlib-compressed). **`.woff2`
is deliberately not parsed** — its table directory is brotli-compressed *and*
transformed, so reading it means shipping a brotli decoder plus glyf/loca
reconstruction to learn a family name the browser can measure anyway. A WOFF2
font works fine; it just reports `readable: false`. Import the TTF if the
metadata matters.

### Using a font

- **UI Text** — set `fontAsset` on the component. `fontFamily` stays as the
  fallback, so a label reads in *something* while the font loads and on a
  machine where the file is missing.
- **Texture Editor** — the Text tool's font dropdown lists every project font
  alongside four generic system stacks. Local fonts are not enumerable without
  a permission prompt, and a texture rendered with whatever happens to be
  installed looks different on someone else's machine — so the honest answer
  for anything specific is to import it.
- **Scripts** — `engine.assets.font(path)`, as above.

### Google Fonts, in-editor

**View → Fonts** browses the whole ~1,900-family catalog, renders specimens in
the real face, and imports the weights you pick into `<project>/Fonts/<Family>/`.

Two keyless endpoints, both proxied through Rust (the metadata host sends no
CORS headers):

| Endpoint | For |
| --- | --- |
| `fonts.google.com/metadata/fonts` | the browsing catalog — categories, subsets, weights, designers, popularity |
| `fonts.googleapis.com/css2` | `@font-face` rules whose `src` URLs are the actual binaries on `fonts.gstatic.com` |

The documented Web Fonts Developer API needs a Google Cloud key — a signup
before a single font can be searched — and is not necessary for either job.

Files arrive as **TrueType**, because `css2` serves whatever format it infers
from the User-Agent and the proxy's UA is not a browser it recognises. That is
the format we want: WOFF2 is smaller on the wire, but nothing can read a family
name, a licence or a glyph count out of it.

Everything in the catalog is open source (almost all OFL). The handful of
families flagged otherwise are shown with a warning rather than hidden.

---

## The code editor

Monaco, embedded. **View → Code**, or double-click any script in Assets.

### Why a real editor rather than a highlighter

A syntax-highlighted read-only view would have been a tenth of the code and the
wrong thing. The scripting surface is deliberately fully typed — `engine.d.ts`
is generated so a script never has to look anything up — and that investment
only pays off in an editor with a language service. Monaco carries
TypeScript's, so the in-app editor gives the same completions, hovers,
signature help and inline errors an external IDE would, against the same
declarations, from the same file.

"Open in IDE" is still there for when that is genuinely what you want. It is
just no longer the only way to read a file.

### Type declarations, in two tiers

- `engine.d.ts` and `editor.d.ts` are bundled into the app as raw strings
  (`projectTypes.js` already imports them to scaffold projects), so they are
  registered **synchronously**: the API you write against is known before the
  first keystroke.
- three's declarations are ~970 files vendored per-project on disk. They load
  in the background on first use, over a single batched `read_text_files` Rust
  call, and `three` resolves to `any` until they land.

That ordering is the point. Blocking startup on 12 MB of `@types/three` would
make opening a script feel broken; `Vector3` going from `any` to typed a second
later is invisible.

The compiler options are deliberately the same set `projectTypes.js` writes
into the project's `tsconfig.json`. **If those two drift, the in-app editor and
the user's IDE disagree about their own code** — one flags an error the other
doesn't — and there is no way to tell which is lying.

### Models are shared

One Monaco model per project file, shared between the Inspector's inline editor
and the Code panel. Two models would mean two copies of the text, two undo
stacks, and a save that silently discards whichever pane you weren't looking
at. One model means both panes are literally the same document.

Closing a Code tab disposes the model only if nothing else shows the file.

### Saving

Explicit — Ctrl+S or the button — and on unmount if the buffer is dirty. Not on
every keystroke: scripts are watched for hot reload, so an autosave would
recompile the game on a half-typed identifier several times a second.

On regaining focus the editor re-reads from disk and adopts on-disk changes
**only when the buffer is clean**. When both changed it says so and leaves the
choice to you.

### Vim mode

Optional, off by default, toggled from the editor toolbar and remembered in
`localStorage` (it describes the person, not the project). `monaco-vim`
attaches to the live editor instance, so toggling does not rebuild it — cursor,
scroll, selection and undo history all survive. The status line below the
editor shows the mode and the `:` prompt.

---

## Asset Inspector

Every asset type now has a preview and a list of what can be done with it.

### The action registry

`src/editor/assetActions.js` is the single source of truth. Actions used to be
scattered across the Assets context menu, ad-hoc Inspector buttons and the
double-click handler — three lists that disagreed — and nothing could answer
"what *can* I do with this file", which is exactly what someone selecting an
unfamiliar asset wants to know.

An action is `{ id, label, hint, icon, primary?, danger?, enabled?, available?, run() }`.
`icon` is a lucide icon **name**, not a component, so the module stays free of
React and can be imported by the headless API layer.

Actions that can't run right now (assign-to-selection with nothing selected)
render disabled with the reason, rather than disappearing — a control that
comes and goes teaches nothing about why.

### Coverage

| Type | Preview | Notable actions |
| --- | --- | --- |
| Texture | image + dimensions | edit, slice into sprites, create material |
| Model (`.glb`) | turntable render, mesh/tri counts, clips | unpack, Draco compress |
| Geometry (`.geom`) | cached thumbnail, vertex/tri counts | virtual-geometry settings |
| Material | node/edge counts, full pipeline state | open shader graph, assign to selection |
| Cube map | unfolded-cross face preview | set as scene environment |
| Audio | waveform, sample rate, peak dB, clipping | open in Audio Editor |
| Font | specimen at four sizes, coverage, licence | use on UI Text, use in Text tool |
| Sprite atlas | sheet with region rects overlaid | open Atlas Editor |
| Scene | entity count, component histogram, skybox | open, set as main scene |
| Timeline | track counts by kind, duration, fps | open Timeline |
| Prefab | entity count, components, variant lineage | open prefab, add to scene |
| Script | class/hooks/attributes + editable code | open in Code panel, attach to selection |
| Anything else | file facts | reveal, copy path, duplicate, open externally |

JSON-backed assets get a collapsed **Raw JSON** section that opens the real
editor. Nothing loads until you open it.

---

## MCP

Per the standing rule, all of this is drivable by an agent:

| Op | Does |
| --- | --- |
| `font.list` | project fonts with the CSS family each is registered under |
| `font.inspect` | a font's own metadata, including embedding permission |
| `font.search` | search the Google Fonts catalog |
| `font.import` | download a family's weights into the project |
| `asset.actions` | what can be done with an asset — ids for the next op |
| `asset.runAction` | run one of them |
| `code.open` | show a file in the code editor |
| `code.openFiles` | which files are open and which have unsaved edits |

`asset.actions` is the discovery half: an agent enumerates capabilities per
type instead of guessing them.

---

## Tests

```
npm run test:fonts          # SFNT parsing, family generation, css2 request building
npm run test:mcp-coverage   # every module has ops
npm run test:texture        # texture editor, incl. the Text tool's font shorthand
npm run test:ui             # SDF glyph pipeline
```

`test:fonts` synthesizes a font file byte by byte rather than checking one in —
building the tables by hand is the only way to be sure the parser reads the
fields it claims to at the offsets the spec says they live at. A checked-in
font that happens to parse proves much less.
