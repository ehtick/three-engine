// Gate: the Cloudflare Pages `_headers` generator (build/runtimeFiles.js).
// Only content-hashed URLs may be immutable, and no path may match two
// Cache-Control rules (Pages joins their values).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { pagesHeaders, PAGES_HEADERS_PATH } from "../src/editor/build/runtimeFiles.js";

/** Parses `_headers` text into [{ path, headers: [[name, value]] }]. */
function parse(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [] });
    else {
      const [name, ...rest] = line.trim().split(":");
      rules.at(-1).headers.push([name.trim(), rest.join(":").trim()]);
    }
  }
  return rules;
}

/** Pages' matcher: `*` is a greedy splat, everything else literal. */
const matches = (rule, url) =>
  new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(url);

const cacheFor = (rules, url) =>
  rules.filter((r) => matches(r.path, url)).flatMap((r) => r.headers.filter(([n]) => n === "Cache-Control").map(([, v]) => v));

test("hashed runtime chunks are immutable, stable-named game files revalidate", () => {
  const rules = parse(pagesHeaders({ files: ["_engine/player-AbCd1234.js", "_engine/rapier-Zz_9-xY0.wasm", "index.html"] }));
  assert.equal(PAGES_HEADERS_PATH, "_headers");
  const immutable = "public, max-age=31536000, immutable";
  assert.deepEqual(cacheFor(rules, "/_engine/player-AbCd1234.js"), [immutable]);
  assert.deepEqual(cacheFor(rules, "/Library/gi-static-bvh/v3/ab/abcdef.gbvh"), [immutable]);
  for (const url of ["/", "/index.html", "/scene.json", "/assets/color.png", "/assets/color.png.basis", "/assets/Player.js"]) {
    assert.deepEqual(cacheFor(rules, url), ["no-cache"], url);
  }
  // Unlisted: Pages' default (max-age=0, must-revalidate) — never immutable.
  assert.deepEqual(cacheFor(rules, "/scenes/Level2.scene"), []);
  assert.deepEqual(cacheFor(rules, "/draco/draco_decoder.wasm"), []);
});

test("no URL matches two Cache-Control rules", () => {
  const rules = parse(pagesHeaders({ files: ["_engine/a-12345678.js"] }));
  for (const url of ["/", "/index.html", "/scene.json", "/assets/x.png", "/_engine/a-12345678.js", "/Library/gi-static-bvh/x"]) {
    assert.ok(cacheFor(rules, url).length <= 1, url);
  }
});

test("negative control: an unhashed file under _engine withdraws the immutable rule", () => {
  const rules = parse(pagesHeaders({ files: ["_engine/player-AbCd1234.js", "_engine/draco_decoder.js"] }));
  assert.deepEqual(cacheFor(rules, "/_engine/player-AbCd1234.js"), []);
  assert.deepEqual(cacheFor(rules, "/_engine/draco_decoder.js"), []);
});

test("the real player template's _engine folder is fully hashed", { skip: !existsSync("dist-player/_engine") }, () => {
  const files = readdirSync("dist-player/_engine").map((f) => `_engine/${f}`);
  const rules = parse(pagesHeaders({ files }));
  assert.ok(rules.some((r) => r.path === "/_engine/*"), "immutable rule kept for dist-player/_engine");
});
