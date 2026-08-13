/**
 * The asset-library browsers, as source-level contracts.
 *
 *   node scripts/run-library-test.mjs
 *
 * These panels talk to five live third-party APIs, so there is no honest way to
 * assert their *behaviour* offline — and hitting the real services from a test
 * would need five API keys and would fail on a train. What CAN be gated is
 * everything that has actually broken here before: a panel wired into two of
 * its three registration points, a provider added to the UI but not to the MCP
 * ops, a duplicated constant drifting from its source, and a credential
 * attached with the wrong header.
 *
 * ## The registration trap this exists for
 *
 * Adding an editor panel takes THREE separate edits — the lazy import plus the
 * component map plus the dock layout in `EditorShell.jsx` — and two more to be
 * reachable (`MenuBar.jsx`, `QuickSearch.jsx`). Miss the dock entry and the
 * panel opens to nothing; miss the menu entry and it exists but cannot be
 * found. Both failures look like "the feature wasn't built".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

let failures = 0;
let checks = 0;
const check = (name, fn) => {
  checks++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
};

const shell = read("src/editor/EditorShell.jsx");
const menuBar = read("src/editor/MenuBar.jsx");
const quickSearch = read("src/editor/QuickSearch.jsx");
const modulesIndex = read("src/modules/index.js");
const modulesPanel = read("src/editor/panels/ModulesPanel.jsx");
const libraryOps = read("src/editor/api/ops/library.js");
const polypizza = read("src/editor/polypizza.js");
const rust = read("src-tauri/src/lib.rs");

/** Every browser panel, and the module that gates it. */
const BROWSERS = [
  { panel: "polyhaven", component: "PolyHavenPanel", module: "polyhaven", menu: "Poly Haven" },
  { panel: "ambientcg", component: "AmbientCGPanel", module: "ambientcg", menu: "AmbientCG" },
  { panel: "sketchfab", component: "SketchfabPanel", module: "sketchfab", menu: "Sketchfab" },
  { panel: "polypizza", component: "PolyPizzaPanel", module: "polypizza", menu: "Poly Pizza" },
  { panel: "itchio", component: "ItchioPanel", module: "itchio", menu: "itch.io" },
  { panel: "audioLibrary", component: "AudioLibraryPanel", module: "audio-library", menu: "Audio Library" },
];

// ---------------------------------------------------------------------------
console.log("\nlibrary — every browser panel is reachable");
// ---------------------------------------------------------------------------

for (const browser of BROWSERS) {
  check(`${browser.panel} is wired into all five registration points`, () => {
    assert.ok(
      new RegExp(`const ${browser.component} = lazy\\(`).test(shell),
      "no lazy import in EditorShell",
    );
    assert.ok(
      new RegExp(`\\b${browser.panel}: withPanelSuspense\\(`).test(shell),
      "not in EditorShell's component map",
    );
    // The dock entry is the one whose absence produces an empty panel rather
    // than an error — nothing throws, the tab just has no content.
    assert.ok(
      new RegExp(`\\b${browser.panel}: \\{ title:`).test(shell),
      "no dock layout entry in EditorShell (panel would open empty)",
    );
    assert.ok(
      new RegExp(`openPanel\\("${browser.panel}"\\)`).test(menuBar),
      "not in the Window menu",
    );
    assert.ok(
      new RegExp(`\\["${browser.panel}", `).test(quickSearch),
      "not in QuickSearch",
    );
  });
}

check("every browser module is registered in the module catalog", () => {
  for (const browser of BROWSERS) {
    const source = read(`src/modules/${browser.module}/index.js`);
    assert.ok(new RegExp(`id: "${browser.module}"`).test(source), `${browser.module} has no id`);
    const name = source.match(/const (\w+Module) =/)?.[1];
    assert.ok(name, `${browser.module} exports no *Module const`);
    assert.ok(
      modulesIndex.includes(`registerModuleDefinition(${name})`),
      `${name} is never registered in src/modules/index.js`,
    );
  }
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — the Assets category");
// ---------------------------------------------------------------------------

check("every asset browser sits under the Assets category", () => {
  for (const browser of BROWSERS) {
    const source = read(`src/modules/${browser.module}/index.js`);
    assert.ok(
      /category: "Assets"/.test(source),
      `${browser.module} is not categorised as Assets`,
    );
  }
});

check("the Modules panel knows the Assets category, and orders it", () => {
  const order = modulesPanel.match(/const CATEGORY_ORDER = \[([^\]]*)\]/);
  assert.ok(order, "CATEGORY_ORDER not found");
  const names = [...order[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.includes("Assets"), `Assets missing from CATEGORY_ORDER: ${names.join(", ")}`);
  // Anything absent from the list is silently swept into "Other" at the very
  // bottom — the failure mode the ordered list exists to prevent.
  assert.ok(names.at(-1) === "Other", "Other must stay last as the catch-all");
});

check("no asset browser is left behind in the Editor category", () => {
  // Texture and Audio EDITORS legitimately stay under Editor; the browsers
  // must not, or the split buys nothing.
  const stragglers = BROWSERS.filter((b) =>
    /category: "Editor"/.test(read(`src/modules/${b.module}/index.js`)),
  );
  assert.equal(stragglers.length, 0, `still under Editor: ${stragglers.map((b) => b.module).join(", ")}`);
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — MCP coverage tracks the panels");
// ---------------------------------------------------------------------------

check("every keyed browser is a library.* provider", () => {
  // itch.io and the audio library are the two exceptions with their own op
  // families; everything else must be reachable through library.search.
  for (const id of ["polyhaven", "ambientcg", "sketchfab", "polypizza", "itchio"]) {
    assert.ok(
      new RegExp(`^\\s*${id}: \\{ module:`, "m").test(libraryOps),
      `${id} is not in library.js PROVIDERS — the panel would have no MCP equivalent`,
    );
  }
});

check("polypizza has both a search and an import branch", () => {
  assert.ok(
    libraryOps.includes('if (provider === "polypizza") {'),
    "no polypizza branch",
  );
  // Two branches, one per op. A provider listed in PROVIDERS but handled in
  // only one of them fails at call time with a confusing fallthrough into
  // whichever provider the function ends on.
  const branches = libraryOps.match(/if \(provider === "polypizza"\) \{/g) ?? [];
  assert.equal(branches.length, 2, `expected search + import branches, found ${branches.length}`);
});

check("library.status reports the polypizza key", () => {
  assert.ok(/polypizza: !!polypizza\?\.getSavedToken/.test(libraryOps), "key not probed in status");
  assert.ok(/needsKey: true/.test(libraryOps.match(/polypizza: \{[^}]*\}/)[0]), "polypizza must be needsKey");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — Poly Pizza specifics");
// ---------------------------------------------------------------------------

const categoryEntries = [...polypizza.matchAll(/\{ id: "([a-z-]+)", code: (\d+), label: "/g)]
  .map((m) => ({ id: m[1], code: Number(m[2]) }));
const categoryIds = categoryEntries.map((c) => c.id);

check("the client declares all twelve Poly Pizza categories", () => {
  assert.equal(categoryIds.length, 12, `found ${categoryIds.length}: ${categoryIds.join(", ")}`);
  assert.ok(categoryIds.includes("people-characters"), "people-characters missing");
  assert.ok(categoryIds.includes("animals"), "animals missing");
});

check("category codes are positions in Poly Pizza's own array", () => {
  // The filter value is an INDEX, so the ORDER is theirs and load-bearing —
  // read out of their site bundle. Reordering this list to something more
  // sensible for our dropdown would silently repoint every category.
  assert.deepEqual(
    categoryEntries.map((c) => c.code),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "codes must be 0..11 in declaration order",
  );
  assert.equal(categoryEntries.find((c) => c.id === "weapons")?.code, 2);
  assert.equal(categoryEntries.find((c) => c.id === "people-characters")?.code, 9);
});

check("licence codes are numeric, and 'any' is expressed by omission", () => {
  // `License=CC0` is a ZodError ("expected number, received nan") and
  // `License=-1` is rejected too ("License must be 0 or 1"), so "any" has to be
  // the absence of the parameter — which is why `needsFilter` still exists.
  const block = polypizza.match(/export const LICENSES = \[[\s\S]*?\];/)[0];
  assert.ok(/\{ id: "CC0", code: 1,/.test(block), "CC0 must be code 1");
  assert.ok(/\{ id: "CC-BY", code: 0,/.test(block), "CC-BY must be code 0");
  assert.ok(/\{ id: "", code: -1,/.test(block), "'any' needs a sentinel that is never sent");
  assert.ok(
    /licenseCode !== undefined && licenseCode >= 0/.test(polypizza),
    "the -1 sentinel must be filtered out before the request, not sent",
  );
});

check("filter values are sent as numbers, never as names", () => {
  assert.ok(/params\.set\("Category", String\(categoryCode\)\)/.test(polypizza), "category sent by name");
  assert.ok(/params\.set\("License", String\(licenseCode\)\)/.test(polypizza), "licence sent by name");
  // ALL THREE are numeric, including the one that reads as a boolean: sending
  // "true" coerces to NaN and fails with the same ZodError as "CC0" did.
  assert.ok(/params\.set\("Animated", "1"\)/.test(polypizza), "Animated=true must be sent as 1");
  assert.ok(/params\.set\("Animated", "0"\)/.test(polypizza), "Animated=false must be sent as 0");
  assert.ok(
    !/params\.set\("Animated", "(true|false)"\)/.test(polypizza),
    "a boolean string for Animated is NaN to this API",
  );
  // The two that really are lowercase. Casing here is per-parameter.
  assert.ok(/params\.set\("limit",/.test(polypizza) && /params\.set\("page",/.test(polypizza),
    "limit/page must stay lowercase");
});

check("the ops' duplicated category list matches the client's", () => {
  const block = libraryOps.match(/const POLYPIZZA_CATEGORIES = \[([\s\S]*?)\];/);
  assert.ok(block, "POLYPIZZA_CATEGORIES not found in library.js");
  const opIds = [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...opIds].sort(),
    [...categoryIds].sort(),
    "library.js's copy has drifted from polypizza.js",
  );
});

check("the key-validation probe carries a filter", () => {
  // `/search` with no License/Animated/Category answers
  // 400 {"error":"No query parameters, must have License, Animated, or Category"}.
  // Validating with a bare `/search?limit=1` therefore rejected EVERY key,
  // valid or not, and the 400 read to the user as "your key is bad".
  const fn = polypizza.match(/export async function validateAndSaveToken[\s\S]*?\n\}/)[0];
  const probe = fn.match(/apiJson\("([^"]+)"/)?.[1];
  assert.ok(probe, "no validation request found");
  // Case-insensitive: the filter parameter names are PascalCase (`License`),
  // which is what the API's own 400 text calls them.
  assert.ok(
    /license=|category=|animated=/i.test(probe),
    `validation probe "${probe}" has no filter — the API will 400 it`,
  );
});

check("a filterless browse is refused locally, with the reason", () => {
  // Not left to the API: the failure is a fixed property of the endpoint, and
  // surfacing it as "Poly Pizza API 400: {…}" in the grid teaches nobody what
  // to do about it.
  assert.ok(/export const needsFilter =/.test(polypizza), "no needsFilter predicate");
  assert.ok(/export const FILTER_PROMPT =/.test(polypizza), "no explanatory message");
  assert.ok(
    /if \(!keyword && needsFilter\(\{[^}]*\}\)\) \{\s*throw new Error\(FILTER_PROMPT\);/.test(polypizza),
    "searchModels does not guard the filterless case",
  );
});

check("needsFilter is true only when nothing at all is set", () => {
  // Reimplemented from the source rather than imported: polypizza.js pulls in
  // assetLoader.js, which needs a browser. The predicate is four clauses; the
  // thing worth gating is that each one alone satisfies the API.
  const fn = polypizza.match(/export const needsFilter = [\s\S]*?;\n/)[0];
  for (const clause of ["query", "category", "license", "animated"]) {
    assert.ok(fn.includes(clause), `needsFilter ignores ${clause}`);
  }
  // `animated == null` (loose) so both null and undefined count as unset —
  // `!animated` would wrongly treat an explicit `false` as no filter.
  assert.ok(/animated == null/.test(fn), "animated must be checked for null, not falsiness");
});

check("the panel prompts instead of requesting when nothing is filtered", () => {
  const panel = read("src/editor/panels/PolyPizzaPanel.jsx");
  assert.ok(/const unfiltered = needsFilter\(filters\)/.test(panel), "panel does not detect it");
  assert.ok(/if \(!moduleOn \|\| !token \|\| unfiltered\)/.test(panel), "panel still fires the request");
  assert.ok(/\{unfiltered \? \(/.test(panel), "panel does not render the prompt");
  // The effect must re-run when the flag flips, or picking a category leaves
  // the prompt on screen forever.
  assert.ok(/\[moduleOn, token, filters, unfiltered\]/.test(panel), "unfiltered missing from deps");
});

check("the response mapping reads Poly Pizza's PascalCase field names", () => {
  // The API answers `ID`/`Title`/`Thumbnail`/`Download`/`Creator.Username`.
  // Reading camelCase produced a grid of "Untitled model" tiles over "3D"
  // placeholders — every field undefined, no error anywhere, because the
  // fallbacks made total failure look like a catalogue of unnamed models.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(fn, "normalise not found");
  for (const key of [
    "item.Title", "item.PublicID", "item.ResourceID", "item.Tris",
    "item.Animated", "item.Description", "item.Tags",
  ]) {
    assert.ok(fn.includes(key), `normalise never reads ${key}`);
  }
  assert.ok(/creator\.Username/.test(fn), "creator name is Creator.Username, not creator.name");
  // British spelling in the response, American in the request parameter.
  assert.ok(/item\.Licence/.test(fn), "the response field is `Licence`, not `License`");
  // `DPURL` is the creator's avatar image, not their profile page — linking to
  // it opens a jpg.
  assert.ok(!/creator\.DPURL/.test(fn), "DPURL is a display picture, not a profile URL");
});

check("thumbnail and download are derivable from ResourceID", () => {
  // Verified against the live CDN: `<ResourceID>.glb` and `<ResourceID>.jpg`.
  // The API's field names are not consistent across its endpoints, so the
  // derivation is what stops a missing `Thumbnail` becoming a grid of
  // placeholders again.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)[0];
  assert.ok(/\$\{CDN\}\/\$\{resource\}\.jpg/.test(fn), "no thumbnail fallback");
  assert.ok(/\$\{CDN\}\/\$\{resource\}\.glb/.test(fn), "no model fallback");
  assert.ok(/const CDN = "https:\/\/static\.poly\.pizza"/.test(polypizza), "CDN host not pinned");
});

check("the two ids are kept apart", () => {
  // PublicID addresses the page and /model/{id}; ResourceID names the files.
  // Neither derives from the other, so conflating them breaks either linking
  // or downloading — silently, since both are opaque strings.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)[0];
  assert.ok(/const id = first\(item\.PublicID/.test(fn), "id must come from PublicID");
  assert.ok(/const resource = first\(item\.ResourceID/.test(fn), "resource must come from ResourceID");
  assert.ok(/resourceId: resource/.test(fn), "resourceId is not carried on the record");
  assert.ok(/poly\.pizza\/m\/\$\{id\}/.test(fn), "the page link must use the public slug");
});

check("the mapping still accepts camelCase, since the wrapper is mixed", () => {
  // `results` came back lowercase while its contents are PascalCase, so there
  // is no single convention to commit to and both have to be read.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)[0];
  for (const key of ["item.title", "item.thumbnail", "item.download", "item.id"]) {
    assert.ok(fn.includes(key), `normalise dropped the camelCase fallback for ${key}`);
  }
  assert.ok(/const first = \(\.\.\.values\)/.test(polypizza), "no `first` helper");
  // `??`-chaining would pick the wrong branch on a legitimately falsy value;
  // `first` must test for undefined/null explicitly.
  assert.ok(
    /value !== undefined && value !== null/.test(polypizza),
    "`first` must skip only undefined/null, or an Animated:false is treated as missing",
  );
});

check("the search envelope and a single-model fetch are both unwrapped", () => {
  assert.ok(/first\(data\?\.results, data\?\.Results\)/.test(polypizza), "envelope key not tolerant");
  const fn = polypizza.match(/export async function fetchModel[\s\S]*?\n\}/)[0];
  assert.ok(
    /Array\.isArray\(envelope\)/.test(fn),
    "fetchModel must handle a single-result envelope, or every field comes back undefined",
  );
});

check("an empty query uses the browse endpoint, not an empty keyword path", () => {
  // `/search/` with no keyword is a 404, so "no query" has to be a DIFFERENT
  // endpoint rather than an empty path segment. This is the bug that makes an
  // unsearched panel show nothing at all.
  assert.ok(
    /keyword\s*\n?\s*\?\s*`\/search\/\$\{encodeURIComponent\(keyword\)\}/.test(polypizza),
    "keyword path not built conditionally",
  );
  assert.ok(/:\s*`\/search\?\$\{params\}`/.test(polypizza), "no bare /search fallback for empty queries");
});

check("an unticked Animated box does not filter to static-only", () => {
  // The API's `animated` is tri-state (true / false / absent) but the toolbar
  // control is a checkbox, whose "off" means "don't care" — not "only static".
  // Storing the checkbox's own `false` sent `animated=false` and hid every
  // animated model from the default view, which is exactly backwards.
  const panel = read("src/editor/panels/PolyPizzaPanel.jsx");
  assert.ok(
    /animated: null \}\)/.test(panel),
    "the initial filter state must be null (no filter), not false",
  );
  assert.ok(
    /event\.target\.checked \? true : null/.test(panel),
    "unchecking must clear the filter rather than invert it",
  );
  // And the client must still be able to express all three, or the ops lose a
  // filter the API offers.
  assert.ok(/animated === true/.test(polypizza) && /animated === false/.test(polypizza),
    "the client should keep the tri-state the API accepts");
});

check("the key is sent as x-auth-token, not an Authorization scheme", () => {
  // Bearer/Token both 401 exactly like no key at all, so getting this wrong
  // reads as a bad credential rather than a bad request.
  const command = rust.match(/async fn fetch_polypizza_text[\s\S]*?\n\}/);
  assert.ok(command, "fetch_polypizza_text not found in lib.rs");
  assert.ok(command[0].includes('.set("x-auth-token", value)'), "wrong header name");
  assert.ok(!/Authorization/.test(command[0]), "must not use an Authorization scheme");
});

check("the proxy refuses hosts other than api.poly.pizza", () => {
  const command = rust.match(/async fn fetch_polypizza_text[\s\S]*?\n\}/)[0];
  assert.ok(
    command.includes('host_str() != Some("api.poly.pizza")'),
    "no host allowlist — the key could be sent to an arbitrary URL",
  );
  assert.ok(command.includes('scheme() != "https"'), "no https requirement");
});

check("fetch_polypizza_text is registered on the invoke handler", () => {
  // A command that exists but is not in the handler list fails at runtime with
  // "command not found", which reads like a missing feature, not a typo.
  assert.ok(/\n\s+fetch_polypizza_text,/.test(rust), "not in the invoke_handler list");
});

check("the download path does not require the key", () => {
  // Model binaries are on a public CDN; sending the credential there would be
  // both unnecessary and a leak to a host the allowlist does not cover.
  const download = polypizza.match(/async function proxyBytes[\s\S]*?\n\}/)[0];
  assert.ok(download.includes('invoke("fetch_bytes"'), "should reuse the generic byte fetch");
  assert.ok(!/token/i.test(download), "no credential belongs on the CDN fetch");
});

check("a credential entry exists so the key can actually be entered", () => {
  const providers = modulesPanel.match(/const CREDENTIAL_PROVIDERS = \{[\s\S]*?\n\};/)[0];
  assert.ok(/polypizza: \[/.test(providers), "no CREDENTIAL_PROVIDERS entry");
  assert.ok(providers.includes('import("../polypizza.js")'), "entry does not load the client");
  for (const fn of ["getSavedToken", "clearSavedToken", "validateAndSaveToken", "openApiKeyPage"]) {
    assert.ok(
      new RegExp(`export (async )?function ${fn}|export const ${fn}`).test(polypizza),
      `polypizza.js does not export ${fn}, which the credential UI calls`,
    );
  }
});

check("attribution is written for every import", () => {
  // Most of this catalogue is CC-BY. An import that drops the credit line is a
  // licence violation shipped into someone's game.
  assert.ok(/ATTRIBUTION\.md/.test(polypizza), "no ATTRIBUTION.md written");
  assert.ok(/attribution \? `Required credit:/.test(polypizza), "API credit string not preserved verbatim");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — an agent can import AND use what it finds");
// ---------------------------------------------------------------------------

check("import returns the one file worth acting on, not just a pile", () => {
  // A GLB unpacks to a folder of .geom/.mat/textures plus a .prefab; a PBR set
  // is 4-7 images plus a .mat. Returning `paths` alone leaves the caller to
  // guess, and `paths[0]` is as likely to be a normal map as anything useful.
  assert.ok(/async function primaryAsset\(paths\)/.test(libraryOps), "no primary-asset resolution");
  assert.ok(/extensionOf\(path\) === "prefab"/.test(libraryOps), "prefab is not preferred");
  assert.ok(/extensionOf\(path\) === "mat"/.test(libraryOps), "material is not recognised");
  assert.ok(/\["hdr", "exr"\]\.includes/.test(libraryOps), "hdri is not recognised");
});

check("the prefab is FOUND, not constructed from the folder name", () => {
  // A name collision suffixes the FOLDER (`Big Tree 2/`) while the prefab keeps
  // the original stem (`Big Tree.prefab`), so `${folder}/${basename}.prefab`
  // silently misses on every re-import of the same model.
  assert.ok(/listProjectEntries\(folder, 2\)/.test(libraryOps), "folder is not listed");
  assert.ok(
    !/\$\{folder\}\/Model\.prefab|\$\{folder\}\/\$\{stem\}\.prefab/.test(libraryOps),
    "the prefab path must not be constructed by string-building",
  );
});

check("every provider branch goes through the shared finisher", () => {
  // A branch that returns its own ad-hoc object is a provider whose caller
  // silently loses `primary`, `next` and `instantiate`.
  const run = libraryOps.slice(libraryOps.indexOf('name: "library.import"'));
  const rawReturns = run.match(/return \{ paths: asPaths\(/g) ?? [];
  assert.equal(rawReturns.length, 0, `${rawReturns.length} provider branches bypass finish()`);
  const finishes = run.match(/return finish\(/g) ?? [];
  assert.ok(finishes.length >= 8, `expected every model/texture/hdri branch to finish(), found ${finishes.length}`);
});

check("each asset kind names the op that consumes it", () => {
  // The point of `next`: an agent that just imported an HDRI should not have to
  // know that the file alone lights nothing.
  assert.ok(/prefab\.instantiate/.test(libraryOps), "prefab has no follow-up op");
  assert.ok(/component\.setProp/.test(libraryOps), "material has no follow-up op");
  assert.ok(/scene\.setEnvironment/.test(libraryOps), "hdri has no follow-up op");
});

check("instantiate places the model and reports the entity", () => {
  assert.ok(/instantiate: \{/.test(libraryOps), "no instantiate parameter");
  assert.ok(/out\.entityId = entity\.id/.test(libraryOps), "the created entity is not reported");
  assert.ok(/instantiatePrefab\(primary, position, null\)/.test(libraryOps), "position is not honoured");
});

check("an instantiate that cannot apply says so rather than silently passing", () => {
  // Asking to spawn a texture is a caller mistake worth surfacing; returning a
  // success-looking result teaches the agent that it worked.
  assert.ok(/out\.instantiateSkipped/.test(libraryOps), "a skipped instantiate is silent");
});

check("every asset SOURCE tells an agent how to use what it imported", () => {
  // The rule this file enforces for models applies to the other two importers
  // too. The audio one is the sharpest case: a Sound component holds a LIST of
  // entries and the file lives on `entries[].audioAsset`, which no caller is
  // going to guess from a returned `path`.
  const audioOps = read("src/editor/api/ops/audio.js");
  assert.ok(/next:/.test(audioOps), "audio.library.import does not name a follow-up");
  assert.ok(/entries: \[\{ audioAsset:/.test(audioOps), "the sound entry shape is not spelled out");
  const fontOps = read("src/editor/api/ops/fonts.js");
  assert.ok(/next: "Use the family name/.test(fontOps), "font.import does not name a follow-up");
});

check("every asset browser module is reachable through an op family", () => {
  // The standing rule: a feature is not done until an agent can drive it.
  // library.* covers five providers; audio-library has its own family.
  const covered = { polyhaven: "library", ambientcg: "library", sketchfab: "library",
    polypizza: "library", itchio: "library", "audio-library": "audio.library" };
  for (const browser of BROWSERS) {
    assert.ok(covered[browser.module], `${browser.module} has no op family`);
  }
  const audioOps = read("src/editor/api/ops/audio.js");
  for (const op of ["audio.library.search", "audio.library.import", "audio.library.status"]) {
    assert.ok(audioOps.includes(op), `${op} is missing`);
  }
  for (const op of ["library.search", "library.import", "library.status"]) {
    assert.ok(libraryOps.includes(op), `${op} is missing`);
  }
});

check("itch.io is exempt, deliberately and in writing", () => {
  // Packs are archives of loose files, not one importable asset. The exemption
  // has to be stated or it reads as an oversight.
  const tail = libraryOps.slice(libraryOps.indexOf("itch.io packs are archives"));
  assert.ok(tail.startsWith("itch.io packs are archives"), "no rationale for itch.io having no primary");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — the interactive model preview");
// ---------------------------------------------------------------------------

const preview = read("src/editor/components/ModelPreview.jsx");

check("the preview renders the model, not the thumbnail", () => {
  const panel = read("src/editor/panels/PolyPizzaPanel.jsx");
  assert.ok(/<ModelPreview src=\{model\.downloadUrl\}/.test(panel), "detail pane shows no live model");
  // The thumbnail stays as the fallback for a record with no downloadable GLB.
  assert.ok(/model\.thumbnailUrl && <img/.test(panel), "no still fallback");
});

check("it is capped and skipped when invisible, like every other preview", () => {
  // An uncapped second swapchain presenting at 120Hz serialises against the
  // viewport's present and reads as viewport frame drops — see previewLoop.js.
  assert.ok(
    /renderer\.setAnimationLoop\(throttlePreviewFrame\(canvas,/.test(preview),
    "the preview loop is not throttled",
  );
});

check("everything the GLB allocated is freed when the model changes", () => {
  // A browser panel loads a new model on every click. three frees none of this
  // for you, so "does not dispose" becomes hundreds of megabytes in a session.
  assert.ok(/function disposeScene\(root\)/.test(preview), "no scene disposal");
  for (const call of ["geometry?.dispose", "material.dispose", "texture.dispose"]) {
    assert.ok(preview.includes(call), `disposeScene never calls ${call}`);
  }
  assert.ok(/renderer\?\.dispose\(\)/.test(preview), "renderer is never disposed");
  // Textures are shared between materials, so they are collected before being
  // disposed rather than disposed per-material.
  assert.ok(/const textures = new Set\(\)/.test(preview), "textures must be deduped before disposal");
});

check("an in-flight load that resolves after unmount disposes itself", () => {
  // The load is async and the user can click away mid-download. Without this
  // the GLB is parsed onto the GPU and then orphaned with nothing holding it.
  assert.ok(
    /if \(disposed\) \{\s*disposeScene\(gltf\.scene\);/.test(preview),
    "a late load leaks its whole scene",
  );
});

check("switching clips does not re-download the model", () => {
  // Routing the clip through the loading effect would re-fetch the GLB on
  // every change of the dropdown — the effect's dep list is what prevents it.
  assert.ok(/const playRef = useRef\(null\)/.test(preview), "no mixer escape hatch");
  assert.ok(/\}, \[clipIndex\]\);/.test(preview), "clip changes are not their own effect");
  assert.ok(/\}, \[src\]\);/.test(preview), "the load effect must depend on src alone");
});

check("the camera is framed from the model's own size", () => {
  // A fixed near/far pair z-fights on a 200-metre model and clips a
  // 2-centimetre one, and this catalogue contains both.
  assert.ok(/camera\.near = radius \/ 100/.test(preview), "near plane is not derived from bounds");
  assert.ok(/camera\.far = radius \* 40/.test(preview), "far plane is not derived from bounds");
});

check("dragging takes over from the idle spin, and pitch cannot gimbal-lock", () => {
  assert.ok(/if \(!view\.touched\) view\.yaw \+= dt \* IDLE_SPIN/.test(preview), "no idle turntable");
  assert.ok(/viewRef\.current\.touched = true/.test(preview), "dragging never stops the spin");
  assert.ok(/MAX_PITCH = Math\.PI \/ 2 - 0\.05/.test(preview), "pitch reaches the pole and gimbal-locks");
  assert.ok(/Math\.max\(-MAX_PITCH, Math\.min\(MAX_PITCH/.test(preview), "pitch is not clamped");
});

check("camera state lives in a ref, not in React state", () => {
  // A drag produces a pointermove per frame; re-rendering React at that rate
  // to move a camera costs more than the frame it drives.
  assert.ok(/const viewRef = useRef\(\{ yaw:/.test(preview), "view state is not a ref");
  assert.ok(!/setYaw|setPitch|setZoom/.test(preview), "camera state must not go through useState");
});

check("the clip selector only appears when there is a choice", () => {
  assert.ok(/clips\.length > 1 && \(/.test(preview), "a one-clip model should not get a dropdown");
  assert.ok(/clips\.length === 1 &&/.test(preview), "a single clip should still be named");
});

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
