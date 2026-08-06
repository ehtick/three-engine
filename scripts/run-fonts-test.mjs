/**
 * Headless checks over the font pipeline's pure logic: SFNT metadata parsing,
 * the generated family names project fonts are registered under, and the
 * Google Fonts request builder.
 *
 * The font file used here is *synthesized in this file* rather than checked in
 * as a fixture. That is deliberate: a real `.ttf` would make the test depend on
 * a binary nobody can read in a diff, and — more to the point — building the
 * tables by hand is the only way to be sure the parser is reading the fields it
 * claims to, at the offsets the spec says they live at. A checked-in font that
 * happens to parse proves much less.
 *
 * The parts that need a browser (`FontFace` registration, canvas rasterization
 * for the Text tool) are covered by `npm run smoke:texture`.
 *
 * Usage: npm run test:fonts
 */
import { parseFontMetadata, fontFormatOf, fontDisplayName } from "../src/engine/ui/fontMeta.js";
import { fontFamilyFor, fontStackFor } from "../src/engine/ui/fontAsset.js";
import { parseVariant, familySpec, previewFamilyName } from "../src/editor/fontLibrary.js";
import { fontShorthand } from "../src/editor/texture/text.js";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// --- a hand-built SFNT -------------------------------------------------------

/** UTF-16BE bytes, which is how Windows-platform name records are encoded. */
function utf16be(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    out[i * 2] = text.charCodeAt(i) >> 8;
    out[i * 2 + 1] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/** A `name` table holding `[nameId, string]` pairs on platform 3, language 0x409. */
function nameTable(entries) {
  const count = entries.length;
  const strings = entries.map(([, text]) => utf16be(text));
  const stringOffset = 6 + count * 12;
  const total = stringOffset + strings.reduce((sum, s) => sum + s.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0); // format
  view.setUint16(2, count);
  view.setUint16(4, stringOffset);
  let at = 0;
  entries.forEach(([nameId], index) => {
    const record = 6 + index * 12;
    view.setUint16(record, 3); // platform: Windows
    view.setUint16(record + 2, 1); // encoding: UCS-2
    view.setUint16(record + 4, 0x0409); // language: en-US
    view.setUint16(record + 6, nameId);
    view.setUint16(record + 8, strings[index].length);
    view.setUint16(record + 10, at);
    bytes.set(strings[index], stringOffset + at);
    at += strings[index].length;
  });
  return bytes;
}

/** A `cmap` with one format-4 subtable covering the given inclusive ranges. */
function cmapTable(ranges) {
  const segments = [...ranges, [0xffff, 0xffff]];
  const segCount = segments.length;
  const subtableLength = 16 + segCount * 8;
  const bytes = new Uint8Array(4 + 8 + subtableLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0); // version
  view.setUint16(2, 1); // one subtable
  view.setUint16(4, 3); // platform: Windows
  view.setUint16(6, 1); // encoding: BMP
  view.setUint32(8, 12); // offset to the subtable
  const at = 12;
  view.setUint16(at, 4); // format
  view.setUint16(at + 2, subtableLength);
  view.setUint16(at + 4, 0); // language
  view.setUint16(at + 6, segCount * 2);
  const endBase = at + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  segments.forEach(([start, end], index) => {
    view.setUint16(endBase + index * 2, end);
    view.setUint16(startBase + index * 2, start);
    view.setUint16(deltaBase + index * 2, 1);
    view.setUint16(rangeBase + index * 2, 0);
  });
  return bytes;
}

function headTable({ unitsPerEm = 1000, macStyle = 0 } = {}) {
  const bytes = new Uint8Array(54);
  const view = new DataView(bytes.buffer);
  view.setUint16(18, unitsPerEm);
  view.setUint16(44, macStyle);
  return bytes;
}

function maxpTable(glyphs) {
  const bytes = new Uint8Array(6);
  new DataView(bytes.buffer).setUint16(4, glyphs);
  return bytes;
}

function os2Table({ weight = 400, widthClass = 5, fsType = 0, italic = false } = {}) {
  const bytes = new Uint8Array(78);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, weight);
  view.setUint16(6, widthClass);
  view.setUint16(8, fsType);
  view.setUint16(62, italic ? 1 : 0); // fsSelection: ITALIC
  view.setInt16(68, 800); // sTypoAscender
  view.setInt16(70, -200); // sTypoDescender
  return bytes;
}

function postTable({ italicAngle = 0, monospaced = false } = {}) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setInt32(4, Math.round(italicAngle * 65536));
  view.setUint32(12, monospaced ? 1 : 0);
  return bytes;
}

/** Assembles named tables into a `.ttf`-flavoured SFNT container. */
function buildSfnt(tables, { tag = 0x00010000 } = {}) {
  const names = Object.keys(tables);
  const headerSize = 12 + names.length * 16;
  const align = (n) => (n + 3) & ~3;
  let offset = headerSize;
  const placed = names.map((name) => {
    const data = tables[name];
    const record = { name, data, offset };
    offset = align(offset + data.length);
    return record;
  });
  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, tag);
  view.setUint16(4, names.length);
  placed.forEach((record, index) => {
    const at = 12 + index * 16;
    // Table tags are exactly four bytes — "OS/2" and "cmap" already are, and a
    // shorter name would silently misalign every following record.
    for (let i = 0; i < 4; i++) bytes[at + i] = record.name.padEnd(4, " ").charCodeAt(i);
    view.setUint32(at + 8, record.offset);
    view.setUint32(at + 12, record.data.length);
    bytes.set(record.data, record.offset);
  });
  return bytes;
}

const SAMPLE = buildSfnt({
  name: nameTable([
    [0, "Copyright 2026 Nobody"],
    [1, "Test Sans SemiBold"],
    [2, "Regular"],
    [13, "SIL Open Font License 1.1"],
    [14, "https://example.invalid/ofl"],
    [16, "Test Sans"],
    [17, "SemiBold"],
  ]),
  head: headTable({ unitsPerEm: 2048, macStyle: 0 }),
  maxp: maxpTable(412),
  "OS/2": os2Table({ weight: 600, widthClass: 3, fsType: 0 }),
  post: postTable({ monospaced: false }),
  cmap: cmapTable([
    [0x0020, 0x007e], // Latin + digits + punctuation
    [0x0410, 0x044f], // Cyrillic
  ]),
  glyf: new Uint8Array(8),
  fpgm: new Uint8Array(4),
});

// --- format sniffing ---------------------------------------------------------
console.log("\nFormat detection");
{
  eq("a TrueType header is recognised", fontFormatOf(SAMPLE), "ttf");
  eq("an OTTO header reads as OpenType", fontFormatOf(new TextEncoder().encode("OTTO____")), "otf");
  eq("a wOFF header reads as WOFF", fontFormatOf(new TextEncoder().encode("wOFF____")), "woff");
  eq("a wOF2 header reads as WOFF2", fontFormatOf(new TextEncoder().encode("wOF2____")), "woff2");
  eq("a PNG is not a font", fontFormatOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  eq("an empty buffer is not a font", fontFormatOf(new Uint8Array(0)), null);
}

// --- metadata ----------------------------------------------------------------
console.log("\nSFNT metadata");
{
  const meta = await parseFontMetadata(SAMPLE);
  check("the tables parse", meta.readable === true, JSON.stringify(meta.format));
  // The typographic pair (16/17) has to win over the legacy pair (1/2), or a
  // weight ships under the family name "Test Sans SemiBold" and every style of
  // the family looks like a different family.
  eq("typographic family wins over the legacy name", meta.family, "Test Sans");
  eq("typographic subfamily wins too", meta.subfamily, "SemiBold");
  eq("unitsPerEm comes from head", meta.unitsPerEm, 2048);
  eq("glyph count comes from maxp", meta.glyphs, 412);
  eq("weight class comes from OS/2", meta.weight, 600);
  eq("width class maps to a CSS keyword", meta.width, "condensed");
  eq("outlines are read from the table that is present", meta.outlines, "quadratic (TrueType)");
  check("a font with fpgm reads as hinted", meta.hinted === true);
  check("a font with no fvar is not variable", meta.variable === false);
  eq("typo ascender is signed", meta.typoAscender, 800);
  eq("typo descender is signed", meta.typoDescender, -200);
  eq("the licence string survives", meta.license, "SIL Open Font License 1.1");

  // Coverage is what answers "will my Russian localisation render", so the
  // blocks have to come from cmap and not from a guess about the subfamily.
  check("Latin coverage is detected", meta.coverage.includes("Latin"));
  check("Cyrillic coverage is detected", meta.coverage.includes("Cyrillic"));
  check("CJK is correctly absent", !meta.coverage.includes("CJK"), meta.coverage.join(", "));
  eq("codepoints are counted across every segment", meta.codepoints, 0x7e - 0x20 + 1 + (0x44f - 0x410 + 1));

  // fsType bit 1 is the one that forbids embedding. Games ship their fonts, so
  // reading this wrong means shipping something you had no licence to ship.
  const restricted = await parseFontMetadata(
    buildSfnt({ name: nameTable([[1, "Locked"]]), "OS/2": os2Table({ fsType: 0x0002 }) }),
  );
  eq("fsType 2 reports as restricted", restricted.embedding, "restricted");
  check("restricted fonts are flagged unembeddable", restricted.embeddable === false);
  const installable = await parseFontMetadata(
    buildSfnt({ name: nameTable([[1, "Open"]]), "OS/2": os2Table({ fsType: 0 }) }),
  );
  check("fsType 0 is embeddable", installable.embeddable === true);

  // Nothing here may throw: the Inspector still has a preview to show for a
  // file this parser cannot dissect, and an exception would take the panel out.
  const garbage = await parseFontMetadata(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  check("garbage parses to unreadable rather than throwing", garbage.readable === false);
  const truncated = await parseFontMetadata(SAMPLE.slice(0, 40));
  check("a truncated font does not throw", truncated.readable === false || truncated.readable === true);
  const woff2 = await parseFontMetadata(new TextEncoder().encode("wOF2 not really"));
  eq("woff2 reports its format and nothing else", woff2.readable, false);
  eq("woff2 still names its format", woff2.format, "woff2");

  eq("display name joins family and style", fontDisplayName(meta, "ignored"), "Test Sans SemiBold");
  eq(
    "a Regular subfamily is not repeated in the display name",
    fontDisplayName({ readable: true, family: "Inter", subfamily: "Regular" }, "x"),
    "Inter",
  );
  eq("an unreadable font falls back to the file stem", fontDisplayName({ readable: false }, "MyFont"), "MyFont");
}

// --- generated family names --------------------------------------------------
console.log("\nProject font families");
{
  const a = fontFamilyFor("C:/proj/Fonts/Inter/Inter-Bold.ttf");
  const b = fontFamilyFor("C:/proj/Fonts/Other/Inter-Bold.ttf");
  check("a family name is generated from the file", a.startsWith("ea-Inter-Bold-"), a);
  // The whole reason for generating names: two files that both call themselves
  // "Inter" must not shadow each other, and neither may collide with a font
  // installed on the developer's machine.
  check("two same-named files in different folders differ", a !== b, `${a} vs ${b}`);
  eq("the same path always yields the same family", fontFamilyFor("C:/proj/Fonts/Inter/Inter-Bold.ttf"), a);
  eq(
    "separators do not change the identity",
    fontFamilyFor("C:\\proj\\Fonts\\Inter\\Inter-Bold.ttf"),
    a,
  );
  check("spaces and dots are stripped from the id", /^[A-Za-z0-9-]+$/.test(fontFamilyFor("a/My Font v2.0.otf")));
  eq("no path means no family", fontFamilyFor(""), null);

  eq(
    "the stack puts the project font first and keeps a fallback",
    fontStackFor("f/Inter.ttf", "serif"),
    `"${fontFamilyFor("f/Inter.ttf")}", serif`,
  );
  eq("no font asset leaves the CSS family alone", fontStackFor("", "monospace"), "monospace");
}

// --- Google Fonts request building -------------------------------------------
console.log("\nGoogle Fonts requests");
{
  eq("a plain weight parses", parseVariant("700"), { key: "700", weight: 700, italic: false, label: "Bold" });
  eq("an italic weight parses", parseVariant("400i"), { key: "400i", weight: 400, italic: true, label: "Italic" });
  eq("a non-400 italic gets a compound label", parseVariant("300i").label, "Light Italic");

  // css2 is strict about the axis tuple order and rejects — rather than
  // ignores — a malformed one, so this is the difference between an import
  // that works and a 400 with no explanation.
  eq("a single weight builds a wght spec", familySpec("Roboto", [parseVariant("700")]), "Roboto:wght@700");
  eq(
    "spaces in a family become plus signs",
    familySpec("Press Start 2P", [parseVariant("400")]),
    "Press+Start+2P:wght@400",
  );
  eq(
    "mixed italics switch to the ital,wght axis pair, ascending",
    familySpec("Inter", [parseVariant("700"), parseVariant("400i"), parseVariant("400")]),
    "Inter:ital,wght@0,400;0,700;1,400",
  );
  eq("no variants means the bare family", familySpec("Lato", []), "Lato");
  check(
    "preview families cannot collide with project ones",
    previewFamilyName("Inter") !== fontFamilyFor("Inter.ttf"),
    previewFamilyName("Inter"),
  );
}

// --- the Text tool's font string ---------------------------------------------
console.log("\nTexture Editor text");
{
  // CSS mandates style, weight, size, family in that order. Get it wrong and
  // the assignment is silently dropped — you get 10px sans-serif, which reads
  // as "the font failed to load" rather than "the shorthand is malformed".
  eq(
    "the shorthand is in CSS order",
    fontShorthand({ italic: true, bold: true, fontSize: 32, fontFamily: '"ea-x", sans-serif' }),
    'italic 700 32px "ea-x", sans-serif',
  );
  eq(
    "regular text still states its weight",
    fontShorthand({ italic: false, bold: false, fontSize: 12.6, fontFamily: "serif" }),
    "400 13px serif",
  );
  check("a zero size is clamped rather than emitted", fontShorthand({ fontSize: 0, fontFamily: "x" }).includes("1px"));
}

console.log(`\nFONTS-TEST ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
