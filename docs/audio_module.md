# Audio modules — design

**Written 2026-08-05.** Two modules, one goal: a game's sound can be *found*, *shaped* and
*shipped* without leaving the editor.

> **Status (2026-08-05).** `audio-library` is complete. `audio-editor` **phases 1 and 2 are
> complete, and the first half of phase 3** — Ogg/Opus export, the seamless loop maker, the
> variation generator, mono-ize and the size report. Verified by `npm run test:audio` (180
> headless checks), `npm run smoke:audio` (62, the real editor behind the Tauri shim),
> `npm run smoke:editor-api` (83), `npm run test:mcp` (20), `check:types` and `build`.
>
> **The remaining format limitation:** WAV and Ogg/Opus can be written; mp3, flac and m4a
> are still decode-only, because the browser decodes them and will not encode them. Editing
> one of those saves as a sibling `.wav` and says so rather than pretending. Editing a `.ogg`
> — which is what every Freesound import is — now saves **in place**.

- **`audio-library`** — search and import free game SFX / ambience from Freesound and
  Wikimedia Commons straight into the project.
- **`audio-editor`** — a multitrack waveform editor: Audacity's editing model, plus the
  things Audacity has no reason to do and a game engine badly needs.

They are separate modules for the same reason `polyhaven` and `texture-editor` are: one is
an importer you enable when you want a catalogue, the other is a tool you enable when you
want to make something. Neither ships inside an exported game.

What they author is *not* in either module. `.audio` sidecars, `SoundComponent`,
`ListenerComponent` and `AudioSystem` are core engine and already exist — a shipped game
plays a sound without a project having enabled a tool called "Audio Editor".

---

## Part 1 — `audio-library`

### Why these two sources

Researched, not assumed:

| Source | Auth | Catalogue | Verdict |
|---|---|---|---|
| **Freesound** | account + short form | ~600k, the definitive SFX/ambience library | **primary** |
| **Wikimedia Commons** | **none** | strong on nature/city/animal ambience, thin on designed SFX | **shipped — works with zero setup** |
| **Internet Archive** | **none** | huge; results are whole items, often packs | **shipped — see the caveat below** |
| Pixabay | instant key | good audio on the site | **verified: no audio API.** Only `/api/` (images) and `/api/videos/` exist |
| Kenney | none | ~10 CC0 audio packs | **verified: client-rendered.** The pack page HTML has no links or data attributes to parse |
| OpenGameArt | none | game-focused | no API, and the site explicitly warns against scraping |
| BBC SFX | none | 33k | RemArc licence is personal/education/research only — not shippable |
| Sonniss GDC | none | pro libraries, commercial-safe | multi-GB torrents; nothing to browse per sound |
| Lots of Sounds / Magnific | key | CC0 | commercial API startups — see the standing no-paid-services rule |

**Measured, not assumed.** Commons alone does not cover designed game SFX:
`footsteps` 24 hits, `door creak` 9, `forest ambience` 5. It is a genuine ambience source
and a poor SFX one, which is why Freesound stays primary.

**The Internet Archive caveat, recorded because it will resurface.** It is keyless,
CORS-open and enormous, but its licences are *declared by uploaders and verified by
nobody*. Filtering strictly to declared CC0 returns, in the first rows, "Game Over _
Pacman", "Game Over Atari" and "NPC Half-Life 2 Sound Effects" — ripped commercial audio
wearing a CC0 tag. The user was shown this and chose to include the provider unrestricted,
so it is presented like any other: the badge reports what the item claims. Anything taken
from that tab needs its provenance checked by a human before it ships.

### Freesound facts that shape the code

- **Token auth reaches search + previews. Originals need OAuth2.** We ship token-only: the
  imported file is the `hq-mp3`/`hq-ogg` preview, which is 128–192 kbps — what a shipped
  game would compress to anyway. This is a deliberate scope decision, not an oversight;
  the OAuth2 code flow can be added later behind the same credential UI.
- Search filters on `license:"Creative Commons 0"`, duration, channels, samplerate, and
  60+ content descriptors. The `fields` parameter must list everything we want in one
  request — the docs are emphatic about this, and per-result lookups would burn the quota.
- **60 requests/minute, 2000/day.** One request per user action. Never prefetch, debounce
  the search box, and page on demand.
- The API sends `Access-Control-Allow-Origin: *`; **its media host does not**. Irrelevant
  here — every request goes through Rust (`fetch_freesound_text` / `fetch_freesound_bytes`,
  host-locked to `freesound.org` + `cdn.freesound.org` so a key can't leak to an arbitrary
  URL), exactly as `fetch_itchio_text` does.

### Licensing is a feature, not a footnote

Freesound sounds are CC0, CC-BY, CC-BY-NC or Sampling+. Mixing a CC-BY sound into a game
without crediting it is a licence breach that nobody notices until shipping day. So:

- The licence is shown on every result, and there's a **"CC0 only"** filter for people who
  never want to think about it.
- Every import appends to `Audio/CREDITS.md` — one line per sound with title, author,
  licence and source URL. Re-importing rewrites its own entry rather than duplicating.
- `CREDITS.md` is a scene-independent file, so `exportGame` must ship it explicitly.

### Layout

```
src/modules/audio-library/index.js        module definition (no components)
src/editor/audioLibrary.js                providers + search + import + credits
src/editor/panels/AudioLibraryPanel.jsx   the panel
src-tauri/src/lib.rs                      fetch_freesound_{text,bytes}
```

Imports land in `<project>/Audio/<Provider>/`, as ordinary assets. Panel registration has
**three** touch points — `EditorShell.jsx`, `MenuBar.jsx` and `QuickSearch.jsx` — and
missing the third makes Ctrl+K unable to find it.

---

## Part 2 — `audio-editor`

### The four decisions that shape everything else

#### 1. The audio file stays the asset; the document is a sidecar

`Audio/impact.wav` remains exactly what every `SoundComponent` already references. Beside
it sits `Audio/impact.wav.aud`, hidden in the Assets grid, holding the track stack. Saving
mixes down to the audio file *and* writes the sidecar. **A file with no sidecar opens as a
single track**, so every already-imported sound is editable on day one with no migration.

Identical in shape to `.tex`, and it inherits the same plumbing: hidden by
`assetLoader.withoutSidecars`, followed through rename/move/delete in `assetOps`, never
exported.

`.aud` is a **binary container**, for the same reason `.tex` is — base64-in-JSON inflates
33% and a two-minute stereo ambience is 20 MB of samples:

```
magic "AUDDOC1" | u32 headerLen | headerLen bytes of JSON | track0 wav | track1 wav | ...
```

The header names each track (`{name, offset, length, muted, solo, gain, pan, start,
effects[]}`); the payloads are ordinary WAV files, concatenated. Anything that can read a
WAV can recover the work if the editor ever refuses to open the file.

#### 2. The DSP core is pure, and knows nothing about Web Audio, canvas or React

Everything that decides *what the samples become* lives in `src/editor/audio/` and operates
on a plain `{ sampleRate, channels: Float32Array[] }`. No `AudioContext`, no
`OfflineAudioContext`, no `AudioBuffer`.

Two reasons, and the second is the one that matters. The first is testability: the whole
core runs under `node`, which is how this repo tests everything. The second is that
**Web Audio is not an offline processor**. `OfflineAudioContext` renders in 128-sample
quanta with implementation-defined smoothing on every `AudioParam`, node creation order
affects the result, and it will not tell you what it did. A normalize that depends on
Chromium's version is not a normalize. We write the filters.

Web Audio appears at exactly two edges: **decode** (`decodeAudioData`, so we accept every
format the browser does — mp3, ogg, flac, m4a) and **playback**. Both convert to and from
the plain form at the boundary. WAV we decode ourselves so the test suite has a
format that needs no browser.

#### 3. Float32 throughout, dither only on the way out

Samples are `Float32Array` in `[-1, 1]`, never clamped mid-chain. Intermediate clipping is
the classic way a chain of correct-looking operations produces a wrong result: normalize
after a compressor should be able to see the +1.4 peak the compressor left behind. Clamping
and (for 16-bit output) TPDF dither happen once, in the encoder.

#### 4. One panel, tracks down the left, timeline across

Not modes like the texture editor — audio has one natural view. Track headers (name, mute,
solo, gain, pan, effect chain) on the left, waveform lanes on the right sharing one
horizontal zoom + scroll + playhead + selection.

### What it does that Audacity doesn't

This is the part that justifies building it rather than telling people to install Audacity:

- **Seamless loop maker** — analyses an ambience for the best loop points, crossfades the
  tail into the head, snaps to zero crossings, and previews the seam on repeat. Every
  looping ambient bed in every game needs this and it is miserable by hand.
- **Variation generator** — one footstep becomes eight, pitch- and gain-jittered, exported
  as a numbered set ready to drop into a `SoundComponent`'s entries.
- **Mono-ize for 3D** — a stereo file will not spatialise; `PannerNode` collapses it and the
  result is quietly wrong. The editor detects stereo files on a spatial sound and offers the
  fix, with a correlation-aware downmix rather than a naive `(L+R)/2` that can null.
- **Batch process** — apply a chain to every selected asset in the Assets panel.
- **Build-size honesty** — every export shows the byte cost, because audio is usually the
  largest thing in a web build and nothing else in the editor tells you.

### Phases

| Phase | Contents |
|---|---|
| **1 — document + editing** ✅ | plain-form model, WAV codec, windowed-sinc resampler, `.aud` container, waveform peak pyramid, panel with zoom/selection/playhead, transport + playback, cut/copy/paste/delete/trim/silence/duplicate/reverse/trim-silence, zero-cross snap, per-track gain/pan/mute/solo, mixdown, byte-budgeted undo/redo, save |
| **2 — processing** ✅ | amplify, normalize (peak + RMS/LUFS), fades + envelope tool, reverse, invert, DC offset, resample/speed, WSOLA tempo + pitch shift, biquad EQ, compressor/limiter/gate, delay/echo, reverb, chorus/flanger, FFT + spectral-subtraction noise reduction, generators (silence/tone/noise/chirp), preview dialogs |
| **3 — game tools** ◑ | **done:** Ogg/Opus export (WebCodecs encoder + a hand-written Ogg muxer), seamless loop maker, variation generator, mono-ize, size report, trim silence. **left:** loudness match, batch process, spectrogram, `.audio` sidecar authoring |
| **4 — integration** | Assets-panel waveform thumbnails + inline preview, drag from the library panel into the editor, open-in-editor from `SoundComponent`, Timeline panel handoff, `exportGame` wiring |

### Phase 3, part one — what it took

**Ogg/Opus.** `AudioEncoder` produces Opus *packets* and nothing in the browser will put
them in a container, so `ogg.js` writes one in plain JS (testable under node) and
`encodeOpus.js` is the thin WebCodecs edge — the third and last place a Web API appears in
`src/editor/audio/`, beside `decode.js` and `playback.js`. Three things were only findable
by encoding something and decoding it back in a real browser, and each was silent:

- **The encoder's lookahead is lost off the *end*.** A one-second tone came back 47688
  frames instead of 48000 — exactly 312 short — while being perfectly aligned at the start,
  which is what pinned the loss to the tail. `flush()` does not push the pipeline out, and
  it *drops* a partial trailing buffer rather than padding it: feeding exactly 312 extra
  frames changed nothing at all, same packet count and same byte count. The input has to be
  padded up to a whole 20 ms frame past `preSkip + frames`.
- **A trim that rewrites only the final packet cannot work.** Chromium's last chunk reports
  zero duration, so the last two packets share a granule; floor the rewrite at the previous
  packet's granule and the floor already equals the untrimmed value. Every packet is capped
  at the trim point instead — monotonic by construction, no floor needed.
- **`decodeAudioData` applies pre-skip but ignores end-trim.** The container was right and
  the decoder was permissive, handing back up to 20 ms of trailing silence. Harmless once —
  except the editor re-opens the files it writes, so an Ogg would grow a little on every
  save-and-reopen cycle and a loop would acquire the gap it was made to remove. `decode.js`
  reads the stream's own declared length (`opusStreamInfo`) and honours it.

Result: 48000 frames in, 48000 out, zero samples of drift — asserted in `smoke:audio` by
cross-correlating a decoded chirp against the original, which is also what verifies the
declared pre-skip of 312 rather than trusting it.

**The seamless loop maker.** The wrap is click-free *by construction*, not by search: the
crossfade uses the audio that really came next in the recording, so `out[last]` and `out[0]`
are two adjacent samples of the original. Nothing snaps to zero crossings because there is
no discontinuity for it to fix. What the correlation search is for is whether the crossfade
*sounds* like the recording continuing — a different question, and the one the score
answers (`match` × `levelMatch`, both reported, because "matches well but is 2 dB louder"
is fixable and "doesn't match" is not).

**Mono-ize needed a document-level fix.** `setTrackPcm` only ever *widens* a document, so
mono-izing its only track left `channels: 2` and the mixdown wrote two identical channels —
the file stayed stereo and still would not spatialise, which is the entire point of the
operation. `auddoc.reconcileChannels` narrows, and effects declare `changesChannels` so
every caller knows to call it.

### Traps carried over from the texture editor

These cost real time there and apply verbatim here:

- **A preview dialog must not depend on its own callback** — hold it in a ref, or previewing
  re-renders the panel, which makes a fresh `onPreview`, which previews again, forever.
- **Apply must re-run from the pre-dialog snapshot**, and the undo state must be captured
  after restoring that snapshot, or undo returns to the last preview.
- **The document lives in a `useRef`**, not `useState` — a two-minute stereo track is 20 MB
  and mid-gesture edits must not bump React state.
- **Panel keyboard ownership uses the hover test**, not focus. Space is play/pause here, so
  `.audio-editor` must join EditorChrome's guard list beside `.texture-editor`.

### MCP / editor-API coverage

Both modules are drivable by an agent, in the same change as the UI (see the standing rule
in memory). Sixteen ops behind the `"editor"` specifier:

`audio.library.status` · `audio.library.search` · `audio.library.import` ·
`audio.library.credits` · `audio.info` · `audio.tracks` · `audio.edit` · `audio.addTrack` ·
`audio.setTrack` · `audio.removeTrack` · `audio.effects` · `audio.process` ·
`audio.generate` · `audio.loop` · `audio.variations` · `audio.export`

`audio.loop` takes `analyzeOnly` so an agent can see the candidate loop points and their
scores before committing to one, and reports the seam it actually produced rather than
claiming success. `audio.export` takes `estimateOnly` for the same reason — audio is usually
the largest thing in a web build, and the size belongs on screen before the choice, not
after it.

`audio.effects` returns the same registry the panel builds its dialogs from — every effect
with its parameter names, ranges, units and defaults — so an agent never has to guess a
parameter name and the tool schema cannot drift from the UI.

They act on **files**, not on the panel's open session, so an agent can edit a sound with
no tab open — and they route through the same `audioFile.js` + `src/editor/audio/` core the
panel does, so there is one implementation of what an edit means. Both halves are gated on
their own module being enabled: an op that quietly worked while the module was off would
make the project's module list a lie.

### Tests

- **`npm run test:audio`** — headless node, no browser. Licence classification and the
  CREDITS.md merge/parse round trip; then the DSP core against analytically-known signals:
  WAV round trips at 16/24/32-bit within that depth's quantisation step, a resample that
  preserves frequency *and* edge amplitude, a downsample that doesn't fold 10 kHz back into
  the band, an anti-phase stereo downmix that keeps its energy, constant-power pan, a
  mixdown that refuses to clip a hot sum, container round trips, and an undo stack that
  evicts by bytes while counting shared buffers once.

  The Ogg muxer is here too, because it is pure: packets round-tripped at every awkward
  length (0, 254, **255**, 256, 509, 510 — a packet whose length is an exact multiple of 255
  needs a trailing zero-length lacing segment or a demuxer reads it as continuing into the
  next one, and it is invisible at every other length); the table-driven CRC checked against
  a bitwise reference and pinned as the unreflected variant so nobody swaps in zlib's; a
  70 KB packet split across pages and reassembled; and the granule rules including the
  zero-duration-tail-packet case that defeated the first trim implementation.

  The loop maker is proved on a signal built with a known period, and its click measure on a
  quarter-cycle cut of a sine — a *half* cycle would have been a poor test, since a sine's
  half period ends back at zero and genuinely does loop cleanly.
- **`npm run smoke:audio`** — the real editor behind the Tauri shim: every op against real
  files, the sidecar decoded from node's side of the filesystem, and the panel opening a
  sound and actually painting a waveform (a blank canvas is what a broken peaks path looks
  like, and it reads as "an empty sound" rather than as a bug).

  It is also the only place the Opus encoder can be tested at all, node having no WebCodecs.
  It encodes a chirp, hands it back to the browser's own decoder, and **cross-correlates the
  result against the original** — which is what verifies the declared pre-skip (0 samples of
  drift) and catches audio lost off either end. A structural check on the container would
  have passed throughout every one of the three bugs described above.
