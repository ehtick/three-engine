// Reclaims disk from throwaway build output. Everything deleted here is
// regenerable by re-running a build or a harness — nothing here is a source of
// truth.
//
//   node scripts/clean.mjs artifacts   harness screenshots / diagnostic images
//   node scripts/clean.mjs dist        vite output (dist, dist-player)
//   node scripts/clean.mjs rust        the Cargo build cache (src-tauri/target)
//   node scripts/clean.mjs all         all of the above
//
// `rust` is the big one — a Tauri debug + release cache runs to several GB —
// but it also costs a full recompile afterwards, so it is opt-in rather than
// part of a bare `npm run clean`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

let freed = 0;
const locked = [];

// On Windows a running `tauri dev` keeps tauri-app.exe (and its .pdb) open, and
// rmSync aborts the whole tree on the first EPERM. Delete depth-first and skip
// what is held open so the rest of the several-GB cache still goes.
function removeTree(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isDirectory()) {
    let removed = 0;
    for (const name of fs.readdirSync(target)) removed += removeTree(path.join(target, name));
    try {
      fs.rmdirSync(target);
    } catch {
      // Non-empty because a child was skipped; the child already reported it.
    }
    return removed;
  }
  try {
    fs.rmSync(target, { force: true });
    return stat.size;
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY") {
      locked.push(path.relative(root, target));
      return 0;
    }
    throw err;
  }
}

function remove(target, label) {
  if (!fs.existsSync(target)) return;
  const size = removeTree(target);
  freed += size;
  console.log(`  removed ${label} (${human(size)})`);
}

// Harness screenshots land next to the harness that wrote them, so sweep
// scripts/ by extension rather than deleting a directory wholesale — the .mjs
// harnesses themselves live there too.
function cleanArtifacts() {
  console.log("artifacts:");
  let count = 0;
  let size = 0;
  for (const name of fs.readdirSync(path.join(root, "scripts"))) {
    if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
    const file = path.join(root, "scripts", name);
    size += fs.statSync(file).size;
    fs.rmSync(file);
    count += 1;
  }
  freed += size;
  if (count) console.log(`  removed ${count} image(s) from scripts/ (${human(size)})`);
  remove(path.join(root, "artifacts"), "artifacts/");
  if (!count) console.log("  nothing to remove");
}

function cleanDist() {
  console.log("dist:");
  remove(path.join(root, "dist"), "dist/");
  remove(path.join(root, "dist-player"), "dist-player/");
}

function cleanRust() {
  console.log("rust:");
  remove(path.join(root, "src-tauri", "target"), "src-tauri/target/");
  console.log("  next `npm run tauri dev` will recompile the whole crate graph");
}

const modes = process.argv.slice(2);
const wanted = modes.length ? modes : ["artifacts"];
const all = wanted.includes("all");

if (all || wanted.includes("artifacts")) cleanArtifacts();
if (all || wanted.includes("dist")) cleanDist();
if (all || wanted.includes("rust")) cleanRust();

const unknown = wanted.filter((m) => !["all", "artifacts", "dist", "rust"].includes(m));
if (unknown.length) {
  console.error(`unknown target(s): ${unknown.join(", ")}`);
  process.exitCode = 1;
}

if (locked.length) {
  console.log(`\n${locked.length} file(s) held open by a running process, left in place:`);
  for (const file of locked.slice(0, 5)) console.log(`  ${file}`);
  if (locked.length > 5) console.log(`  ...and ${locked.length - 5} more`);
  console.log("close the editor / `tauri dev` and re-run to finish");
}

console.log(`freed ${human(freed)}`);
