/**
 * Reads what a font file says about itself.
 *
 * The browser will happily load a `.ttf` through `FontFace` without telling you
 * anything about it — not its real family name, not whether it has the glyphs
 * your UI needs, not whether its licence permits embedding it in a shipped
 * game. All of that is sitting in the file's own tables, and all of it is what
 * you actually want to see before dropping a font into a HUD.
 *
 * So this parses the SFNT container directly: `name` for the human names,
 * `head`/`maxp`/`OS/2`/`post` for metrics and style, and `cmap` for coverage.
 * `.woff` is the same container with per-table zlib, which is unwrapped here.
 *
 * `.woff2` is deliberately NOT parsed. Its table directory is brotli-compressed
 * *and* transformed, so reading it means shipping a brotli decoder plus the
 * glyf/loca reconstruction — a lot of code to learn a family name the browser
 * can measure for us anyway. `parseFontMetadata` reports `{ format: "woff2" }`
 * with nothing else filled in, and callers fall back to measuring the loaded
 * FontFace (see `fontAsset.js`), which is where the numbers that matter for
 * layout come from regardless of format.
 *
 * Pure and dependency-free apart from `DecompressionStream` (present in both
 * browsers and Node 18+), so it runs under `npm run test:fonts`.
 */

/** Name-table IDs worth surfacing, by the key we expose them under. */
const NAME_IDS = {
  copyright: 0,
  family: 1,
  subfamily: 2,
  uniqueId: 3,
  fullName: 4,
  version: 5,
  postScriptName: 6,
  trademark: 7,
  manufacturer: 8,
  designer: 9,
  description: 10,
  vendorUrl: 11,
  designerUrl: 12,
  license: 13,
  licenseUrl: 14,
  // 16/17 are the "typographic" family/subfamily — the ones that describe the
  // real family for a face outside the four-style RIBBI grouping (e.g. "Inter"
  // / "SemiBold" rather than "Inter SemiBold" / "Regular"). Preferred when
  // present, which is why they get their own keys instead of overwriting 1/2.
  typographicFamily: 16,
  typographicSubfamily: 17,
};

/**
 * `usWidthClass` → the CSS `font-stretch` keyword it corresponds to. Reported
 * rather than applied: the editor shows it, and a condensed face is loaded as
 * its own family regardless (see `fontAsset.js`).
 */
const WIDTH_CLASSES = [
  null,
  "ultra-condensed",
  "extra-condensed",
  "condensed",
  "semi-condensed",
  "normal",
  "semi-expanded",
  "expanded",
  "extra-expanded",
  "ultra-expanded",
];

/**
 * Unicode blocks the editor reports coverage for.
 *
 * Not an exhaustive block list — the question this answers is "will my UI's
 * text actually render in this font", and for that a handful of scripts plus
 * "how many codepoints in total" says more than 300 block names would. Ranges
 * are inclusive.
 */
const COVERAGE_RANGES = [
  { name: "Latin", ranges: [[0x0041, 0x005a], [0x0061, 0x007a]] },
  { name: "Digits", ranges: [[0x0030, 0x0039]] },
  { name: "Latin Extended", ranges: [[0x00c0, 0x024f]] },
  { name: "Greek", ranges: [[0x0391, 0x03a9]] },
  { name: "Cyrillic", ranges: [[0x0410, 0x044f]] },
  { name: "Hebrew", ranges: [[0x05d0, 0x05ea]] },
  { name: "Arabic", ranges: [[0x0627, 0x064a]] },
  { name: "Devanagari", ranges: [[0x0905, 0x0939]] },
  { name: "Thai", ranges: [[0x0e01, 0x0e2e]] },
  { name: "Hiragana", ranges: [[0x3041, 0x3096]] },
  { name: "Katakana", ranges: [[0x30a1, 0x30fa]] },
  { name: "Hangul", ranges: [[0xac00, 0xd7a3]] },
  { name: "CJK", ranges: [[0x4e00, 0x9fff]] },
  { name: "Punctuation", ranges: [[0x2010, 0x2027]] },
  { name: "Currency", ranges: [[0x20a0, 0x20bf]] },
  { name: "Arrows", ranges: [[0x2190, 0x21ff]] },
  { name: "Math", ranges: [[0x2200, 0x22ff]] },
  { name: "Emoji", ranges: [[0x1f300, 0x1f5ff]] },
];

/** File signature → format name, for the four containers we accept. */
export function fontFormatOf(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "ttcf") return "ttc";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || tag === "typ1") return "ttf";
  const version = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (version === 0x00010000) return "ttf";
  return null;
}

/** Inflates a zlib stream. Only reached for `.woff`, whose tables are deflated. */
async function inflate(bytes) {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  // A copy, because the stream takes ownership of what it is handed and the
  // caller's view is a window into a buffer holding the rest of the font.
  writer.write(bytes.slice());
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The SFNT table directory as `tag -> Uint8Array`, decompressing where the
 * container calls for it. Returns null when the bytes aren't a container we
 * can walk.
 */
async function readTables(bytes) {
  const format = fontFormatOf(bytes);
  if (!format || format === "woff2") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  const tagAt = (offset) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

  if (format === "woff") {
    const count = view.getUint16(12);
    for (let i = 0; i < count; i++) {
      const record = 44 + i * 20;
      if (record + 20 > bytes.length) break;
      const tag = tagAt(record);
      const offset = view.getUint32(record + 4);
      const compLength = view.getUint32(record + 8);
      const origLength = view.getUint32(record + 12);
      if (offset + compLength > bytes.length) continue;
      const slice = bytes.subarray(offset, offset + compLength);
      // WOFF stores a table uncompressed when deflating it didn't help, and
      // signals that by compLength === origLength rather than by a flag.
      tables.set(tag, compLength === origLength ? slice : await inflate(slice).catch(() => null));
    }
    return tables;
  }

  // A TrueType Collection is a header pointing at N ordinary SFNT headers.
  // Only the first face is read: the collection formats we meet in practice
  // (CJK system fonts) are variations of one design, and `FontFace` loads the
  // first face too, so reporting anything else would describe a face the rest
  // of the editor never uses.
  const sfntStart = format === "ttc" ? view.getUint32(12) : 0;
  const numTables = view.getUint16(sfntStart + 4);
  for (let i = 0; i < numTables; i++) {
    const record = sfntStart + 12 + i * 16;
    if (record + 16 > bytes.length) break;
    const tag = tagAt(record);
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > bytes.length) continue;
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  return tables;
}

/** Decodes one `name` record's bytes, which are UTF-16BE except on Mac. */
function decodeName(bytes, platformId) {
  if (platformId === 3 || platformId === 0) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  // Platform 1 (Macintosh) is MacRoman; the ASCII range — which is all these
  // names ever use in practice — is identical to Latin-1.
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Every string in the `name` table, keyed by our friendly names.
 *
 * A font carries the same name several times over, once per platform and
 * language. Windows/English wins where it exists because that is the encoding
 * every other tool reports, and anything else is taken only to fill a gap.
 */
function readNames(table) {
  const out = {};
  if (!table || table.length < 6) return out;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const count = view.getUint16(2);
  const stringOffset = view.getUint16(4);
  /** @type {Record<string, number>} */
  const bestScore = {};
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    if (record + 12 > table.length) break;
    const platformId = view.getUint16(record);
    const languageId = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = view.getUint16(record + 10);
    const key = Object.keys(NAME_IDS).find((name) => NAME_IDS[name] === nameId);
    if (!key) continue;
    const start = stringOffset + offset;
    if (start + length > table.length) continue;
    // Windows/US-English, then any Windows, then anything at all.
    const score = platformId === 3 && languageId === 0x0409 ? 3 : platformId === 3 ? 2 : 1;
    if ((bestScore[key] ?? 0) >= score) continue;
    const text = decodeName(table.subarray(start, start + length), platformId).trim();
    if (!text) continue;
    bestScore[key] = score;
    out[key] = text;
  }
  return out;
}

/** Reads a `cmap` subtable (format 4 or 12) into a callback per mapped range. */
function eachCmapRange(table, emit) {
  if (!table || table.length < 4) return false;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const numTables = view.getUint16(2);
  // Prefer a full-Unicode subtable (format 12) over the BMP-only format 4 —
  // otherwise a font whose emoji live above U+FFFF reads as having none.
  let best = null;
  for (let i = 0; i < numTables; i++) {
    const record = 4 + i * 8;
    if (record + 8 > table.length) break;
    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const offset = view.getUint32(record + 4);
    if (offset + 4 > table.length) continue;
    const format = view.getUint16(offset);
    if (format !== 4 && format !== 12) continue;
    const unicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicode) continue;
    const score = (format === 12 ? 2 : 1) + (platformId === 3 ? 0.5 : 0);
    if (!best || score > best.score) best = { offset, format, score };
  }
  if (!best) return false;

  if (best.format === 12) {
    const groups = view.getUint32(best.offset + 12);
    for (let i = 0; i < groups; i++) {
      const record = best.offset + 16 + i * 12;
      if (record + 12 > table.length) break;
      emit(view.getUint32(record), view.getUint32(record + 4));
    }
    return true;
  }

  const segCountX2 = view.getUint16(best.offset + 6);
  const segCount = segCountX2 / 2;
  const endBase = best.offset + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;
  for (let i = 0; i < segCount; i++) {
    if (rangeBase + i * 2 + 2 > table.length) break;
    const end = view.getUint16(endBase + i * 2);
    const start = view.getUint16(startBase + i * 2);
    if (start > end || start === 0xffff) continue;
    // A segment can still map to glyph 0 for individual codepoints via
    // idRangeOffset. Resolving that per codepoint would double the cost of
    // parsing for a coverage summary, so a segment counts as covered — the
    // over-report is a handful of codepoints on unusual fonts.
    emit(start, end);
  }
  return true;
}

/** Which of `COVERAGE_RANGES` the font supports, plus a total codepoint count. */
function readCoverage(table) {
  const covered = [];
  let total = 0;
  const hits = new Set();
  const ok = eachCmapRange(table, (start, end) => {
    total += end - start + 1;
    for (const block of COVERAGE_RANGES) {
      if (hits.has(block.name)) continue;
      for (const [low, high] of block.ranges) {
        if (start <= high && end >= low) {
          hits.add(block.name);
          break;
        }
      }
    }
  });
  if (!ok) return null;
  for (const block of COVERAGE_RANGES) if (hits.has(block.name)) covered.push(block.name);
  return { blocks: covered, codepoints: total };
}

/**
 * Everything the font file itself declares.
 *
 * Never throws: a truncated or unrecognised file yields `{ format, readable:
 * false }` rather than an exception, because the inspector still has a
 * perfectly good preview to show for a font the browser can load but this
 * cannot dissect.
 *
 * @param {Uint8Array} bytes
 */
export async function parseFontMetadata(bytes) {
  const format = fontFormatOf(bytes);
  const base = { format, readable: false, bytes: bytes?.length ?? 0 };
  if (!format || format === "woff2") return base;
  let tables;
  try {
    tables = await readTables(bytes);
  } catch {
    return base;
  }
  if (!tables) return base;

  const names = readNames(tables.get("name"));
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const os2 = tables.get("OS/2");
  const post = tables.get("post");
  const at = (table) => new DataView(table.buffer, table.byteOffset, table.byteLength);

  const meta = {
    ...base,
    readable: true,
    ...names,
    // Typographic names describe the real family for faces outside the
    // regular/bold/italic/bold-italic grouping; fall back to the legacy pair.
    family: names.typographicFamily || names.family || null,
    subfamily: names.typographicSubfamily || names.subfamily || null,
    tables: [...tables.keys()].sort(),
    // A `.otf` with a `glyf` table would be lying about its outlines; going by
    // the table that is actually present is what every renderer does.
    outlines: tables.has("CFF ") || tables.has("CFF2") ? "cubic (CFF)" : tables.has("glyf") ? "quadratic (TrueType)" : null,
    variable: tables.has("fvar"),
    colorGlyphs: tables.has("COLR") || tables.has("sbix") || tables.has("CBDT"),
    hinted: tables.has("fpgm") || tables.has("prep"),
    kerning: tables.has("kern") || tables.has("GPOS"),
  };

  if (head && head.length >= 54) {
    const view = at(head);
    meta.unitsPerEm = view.getUint16(18);
    // macStyle bits 0 (bold) and 1 (italic) — the authoritative flags when
    // OS/2 is absent, which is common on older TrueType fonts.
    const macStyle = view.getUint16(44);
    meta.bold = (macStyle & 1) !== 0;
    meta.italic = (macStyle & 2) !== 0;
  }
  if (maxp && maxp.length >= 6) meta.glyphs = at(maxp).getUint16(4);
  if (post && post.length >= 8) {
    // Fixed 16.16; the sign is what matters (negative = leans right).
    meta.italicAngle = at(post).getInt32(4) / 65536;
    if (post.length >= 16) meta.monospaced = at(post).getUint32(12) !== 0;
  }
  if (os2 && os2.length >= 10) {
    const view = at(os2);
    meta.weight = view.getUint16(4);
    meta.width = WIDTH_CLASSES[view.getUint16(6)] ?? null;
    // fsType is the embedding permission bitfield. 2 = restricted (the font
    // may not be embedded at all), 4/8 = preview&print / editable. Games ship
    // their fonts, so a restricted face is a licensing problem the user needs
    // told about BEFORE it is in a build, not after.
    const fsType = view.getUint16(8);
    meta.embedding =
      fsType === 0 ? "installable" : fsType & 0x0002 ? "restricted" : fsType & 0x0008 ? "editable" : fsType & 0x0004 ? "preview & print" : "installable";
    meta.embeddable = !(fsType & 0x0002);
    if (os2.length >= 64) meta.italic = meta.italic || (view.getUint16(62) & 1) !== 0;
    if (os2.length >= 72) {
      // sTypoAscender/Descender/LineGap — the metrics a layout engine should
      // use, as opposed to the hhea pair browsers actually use on Windows.
      meta.typoAscender = view.getInt16(68);
      meta.typoDescender = view.getInt16(70);
    }
  }
  const coverage = readCoverage(tables.get("cmap"));
  if (coverage) {
    meta.coverage = coverage.blocks;
    meta.codepoints = coverage.codepoints;
  }
  return meta;
}

/**
 * The best single-line name for a font, given its parsed metadata and the file
 * it came from. Falls back to the filename stem, which is what a `.woff2`
 * always gets — and which is right often enough that it never reads as broken.
 */
export function fontDisplayName(meta, fileStem) {
  if (!meta?.readable) return fileStem;
  const family = meta.family ?? fileStem;
  const style = meta.subfamily && meta.subfamily.toLowerCase() !== "regular" ? ` ${meta.subfamily}` : "";
  return `${family}${style}`;
}
