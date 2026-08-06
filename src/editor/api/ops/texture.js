/**
 * Texture editor operations: make an image, look at it, change it, pack it.
 *
 * The Texture Editor panel is a canvas over a plain data structure — a document
 * of layers, saved as a flattened image plus a `.tex` sidecar — and every
 * operation it offers is a pure function over a pixel buffer (`texture/adjust`,
 * `texture/filters`, `texture/channels`, `texture/transform`). That is what
 * makes this file thin: the ops call the same functions the panel's menus call,
 * on a document loaded from disk and saved back, so an agent editing a texture
 * and a person editing a texture produce byte-identical results.
 *
 * ## Why the effect list is a tool of its own
 *
 * `texture.effects` returns the registry — ids, labels, parameters, ranges and
 * defaults — rather than this file's documentation restating it. The registry
 * is what the panel's dialogs are generated from, so a new adjustment appears
 * to an agent the moment it appears in the menus, with the same parameter
 * bounds. A hand-written list here would be wrong the first time anyone added
 * a filter.
 */
import { defineOp } from "../registry.js";
import { useProjectStore } from "../../store/projectStore.js";
import { useModulesStore } from "../../modules.js";

function requireModule() {
  if (!useModulesStore.getState().enabled.includes("texture-editor")) {
    throw new Error(
      'The "texture-editor" module is not enabled for this project. Enable it with module.setEnabled, or in the Modules panel.',
    );
  }
}

function requireProject() {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("No project is open.");
  return root;
}

/** The document at `path`, plus the modules needed to write it back. */
async function openDoc(path) {
  const file = await import("../../textureFile.js");
  const opened = await file.openTextureDocument(path);
  if (!opened?.doc) throw new Error(`Couldn't open "${path}" as an image.`);
  return { file, ...opened };
}

/** Every operation the panel's menus can apply, as one flat registry. */
async function effectRegistry() {
  const [adjust, filters] = await Promise.all([
    import("../../texture/adjust.js"),
    import("../../texture/filters.js"),
  ]);
  return [
    ...adjust.ADJUSTMENTS.map((spec) => ({ ...spec, group: "adjustment" })),
    ...filters.FILTERS.map((spec) => ({ ...spec, group: "filter" })),
  ];
}

/** "top-left" / "center" / "bottom-right" -> the 0..1 factors to place by. */
function anchorFactors(anchor) {
  const name = String(anchor ?? "center").toLowerCase();
  const x = name.includes("left") ? 0 : name.includes("right") ? 1 : 0.5;
  const y = name.includes("top") ? 0 : name.includes("bottom") ? 1 : 0.5;
  return [x, y];
}

const describeEffect = (spec) => ({
  id: spec.id,
  label: spec.label,
  group: spec.group,
  params: (spec.params ?? []).map((p) => ({
    key: p.key,
    label: p.label,
    default: p.default,
    ...(p.min !== undefined ? { min: p.min, max: p.max, step: p.step } : {}),
    ...(p.options ? { options: p.options } : {}),
    ...(p.color ? { color: true } : {}),
  })),
});

defineOp({
  name: "texture.info",
  readOnly: true,
  description:
    "Size, format and layer stack of an image in the project. A file that has never been edited here reports a single layer — the image itself — which is the honest answer rather than an error.",
  params: { path: { type: "string", required: true, description: "Absolute path to a .png/.jpg/.webp." } },
  async run({ path }) {
    const { doc, source, stale, warning } = await openDoc(path);
    return {
      path,
      width: doc.width,
      height: doc.height,
      source,
      // True when the sidecar's layers are older than the image on disk — the
      // image was overwritten by something else since it was last edited here.
      stale: !!stale,
      warning: warning ?? null,
      layers: doc.layers.map((layer, index) => ({
        index,
        id: layer.id,
        name: layer.name,
        visible: layer.visible !== false,
        opacity: layer.opacity ?? 1,
        blend: layer.blend ?? "normal",
        offset: layer.offset ?? [0, 0],
        hasMask: !!layer.mask,
      })),
    };
  },
});

defineOp({
  name: "texture.create",
  description:
    "Create a new image asset and write it to disk immediately, so it shows up in the Assets panel rather than existing only in an open tab. Returns its path.",
  params: {
    directory: { type: "string", required: true, description: "Absolute folder to create it in." },
    name: { type: "string", required: true, description: "Filename, e.g. 'Grate.png'. The extension decides the format." },
    width: { type: "number", default: 512, description: "Pixels." },
    height: { type: "number", default: 512, description: "Pixels." },
    background: {
      type: "string",
      description: "CSS colour to fill with, e.g. '#202020' or 'transparent'. Omit for a transparent canvas.",
    },
  },
  async run({ directory, name, width = 512, height = 512, background }) {
    requireModule();
    requireProject();
    const { createTextureAsset } = await import("../../textureFile.js");
    const { path } = await createTextureAsset(directory, name, { width, height, background });
    await useProjectStore.getState().refresh();
    return { path, width, height };
  },
});

defineOp({
  name: "texture.effects",
  readOnly: true,
  description:
    "Every adjustment and filter texture.process can apply, with each one's parameters, ranges and defaults. This is the panel's own registry, so it is never out of date with the menus.",
  params: {},
  async run() {
    return (await effectRegistry()).map(describeEffect);
  },
});

defineOp({
  name: "texture.process",
  description:
    "Apply one adjustment or filter from texture.effects to an image and save it. Applies to the whole flattened image; parameters you leave out take the registry default. Not undoable in the editor's history — it is a file write.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to the image." },
    effect: { type: "string", required: true, description: "An id from texture.effects, e.g. 'blur', 'levels', 'normalFromHeight'." },
    params: { type: "object", description: "Effect parameters. Omitted keys use the registry defaults." },
  },
  async run({ path, effect, params = {} }) {
    requireModule();
    const registry = await effectRegistry();
    const spec = registry.find((entry) => entry.id === effect);
    if (!spec) {
      throw new Error(`Unknown effect "${effect}". Available: ${registry.map((e) => e.id).join(", ")}`);
    }
    const { defaultParams } = await import("../../texture/adjust.js");
    const { file, doc } = await openDoc(path);
    const { flattenDocument, documentFromBuffer } = await import("../../texture/layers.js");
    const flat = flattenDocument(doc);
    const out = spec.apply(flat, { ...defaultParams(spec), ...params }) ?? flat;
    // The result replaces the stack: an agent applying a filter to a layered
    // document and getting back something that looks nothing like the preview
    // would be worse than being explicit that this flattens.
    await file.saveTextureDocument(path, documentFromBuffer(out, doc.layers[0]?.name ?? "Background"));
    return { path, effect, width: out.width, height: out.height, flattened: doc.layers.length > 1 };
  },
});

defineOp({
  name: "texture.resize",
  description:
    "Resample an image to a new size, or change the canvas around it without resampling. 'resize' scales the picture; 'canvas' keeps the pixels and grows/crops the area around an anchor.",
  params: {
    path: { type: "string", required: true },
    width: { type: "number", required: true, description: "Target width in pixels." },
    height: { type: "number", required: true, description: "Target height in pixels." },
    mode: { type: "string", default: "resize", enum: ["resize", "canvas"], description: "Resample, or re-frame." },
    anchor: {
      type: "string",
      default: "center",
      description: "Canvas mode only: where the existing pixels sit — center, top-left, bottom-right, etc.",
    },
    filter: { type: "string", default: "bilinear", enum: ["bilinear", "nearest"], description: "Resize sampling." },
  },
  async run({ path, width, height, mode = "resize", anchor = "center", filter = "bilinear" }) {
    requireModule();
    const { file, doc } = await openDoc(path);
    const { flattenDocument, documentFromBuffer } = await import("../../texture/layers.js");
    const { transformBuffer } = await import("../../texture/transform.js");
    const flat = flattenDocument(doc);

    let out;
    if (mode === "canvas") {
      // Same anchor arithmetic the panel's Canvas Size dialog does, inlined
      // rather than imported: that helper lives in a .jsx module, and pulling
      // React into an op module to reuse six lines is a bad trade.
      const [ax, ay] = anchorFactors(anchor);
      out = transformBuffer(flat, {
        width,
        height,
        offsetX: Math.round((width - flat.width) * ax),
        offsetY: Math.round((height - flat.height) * ay),
        filter: "nearest",
      });
    } else {
      out = transformBuffer(flat, {
        width,
        height,
        scaleX: width / flat.width,
        scaleY: height / flat.height,
        filter,
      });
    }
    await file.saveTextureDocument(path, documentFromBuffer(out, doc.layers[0]?.name ?? "Background"));
    return { path, width: out.width, height: out.height, mode };
  },
});

defineOp({
  name: "texture.setMeta",
  description:
    "Set import flags in an image's .meta sidecar — most importantly its colour space. A packed roughness/metal/AO map read as sRGB is wrong everywhere it is sampled, and the symptom ('my roughness looks washed out') points at the material rather than at this setting.",
  params: {
    path: { type: "string", required: true },
    colorSpace: { type: "string", enum: ["srgb", "linear"], description: "srgb for colour maps, linear for data maps." },
    flipY: { type: "boolean", description: "Flip vertically on load." },
    wrap: { type: "string", enum: ["repeat", "clamp", "mirror"], description: "Texture addressing mode." },
  },
  async run({ path, ...patch }) {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(clean).length) throw new Error("Nothing to set — pass at least one flag.");
    const { writeTextureMeta } = await import("../../textureFile.js");
    await writeTextureMeta(path, clean);
    const { refreshAssetFromDisk } = await import("../../projectWatcher.js");
    await refreshAssetFromDisk(path);
    return { path, ...clean };
  },
});

// ---- layers ----------------------------------------------------------------
//
// Layers are what make this an editor rather than an image filter. They are
// stored in the `.tex` sidecar beside the flattened PNG, so an agent that adds
// a layer here can come back and change its opacity tomorrow — and the game
// still just loads a PNG.

/** A layer by index or by id, with an error that says which ones exist. */
function resolveLayer(doc, layer) {
  if (layer === undefined || layer === null) {
    const active = doc.layers.find((l) => l.id === doc.activeId) ?? doc.layers[doc.layers.length - 1];
    return active;
  }
  const found = typeof layer === "number" ? doc.layers[layer] : doc.layers.find((l) => l.id === layer);
  if (!found) {
    throw new Error(
      `No layer "${layer}". This document has ${doc.layers.length}: ${doc.layers.map((l, i) => `${i}:${l.name}`).join(", ")}`,
    );
  }
  return found;
}

defineOp({
  name: "texture.addLayer",
  description:
    "Add a layer to an image. Layers composite bottom-up in the order texture.info reports, so a new layer goes on top by default. The saved PNG is always the flattened result — the layers live in the .tex sidecar next to it.",
  params: {
    path: { type: "string", required: true },
    name: { type: "string", default: "Layer", description: "Layer name." },
    fill: { type: "string", description: "CSS colour to fill it with. Omit for a transparent layer." },
    opacity: { type: "number", default: 1, description: "0-1." },
    blend: { type: "string", default: "normal", description: "Blend mode — see the modes in texture.info's output." },
  },
  async run({ path, name = "Layer", fill, opacity = 1, blend = "normal" }) {
    requireModule();
    const { file, doc } = await openDoc(path);
    const [{ addLayer }, { parseColor }] = await Promise.all([
      import("../../texture/layers.js"),
      import("../../texture/pixels.js"),
    ]);
    const layer = addLayer(doc, {
      name,
      width: doc.width,
      height: doc.height,
      fill: fill ? parseColor(fill, 255) : null,
      opacity,
      blend,
    });
    await file.saveTextureDocument(path, doc);
    return { path, id: layer.id, index: doc.layers.indexOf(layer), name: layer.name };
  },
});

defineOp({
  name: "texture.setLayer",
  description: "Change a layer's name, visibility, opacity, blend mode or offset, and save. Pass only what you are changing.",
  params: {
    path: { type: "string", required: true },
    layer: { type: "any", description: "Layer index or id. Defaults to the active layer." },
    name: { type: "string" },
    visible: { type: "boolean" },
    opacity: { type: "number", description: "0-1." },
    blend: { type: "string", description: "Blend mode id." },
    offset: { type: "array", description: "[x,y] pixel offset of this layer within the canvas.", items: { type: "number" } },
  },
  async run({ path, layer, ...patch }) {
    requireModule();
    const { file, doc } = await openDoc(path);
    const target = resolveLayer(doc, layer);
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) target[key] = value;
    }
    await file.saveTextureDocument(path, doc);
    return { path, id: target.id, name: target.name, visible: target.visible !== false, opacity: target.opacity ?? 1 };
  },
});

defineOp({
  name: "texture.removeLayer",
  description: "Delete a layer and save. A document always keeps at least one layer.",
  params: {
    path: { type: "string", required: true },
    layer: { type: "any", required: true, description: "Layer index or id." },
  },
  async run({ path, layer }) {
    requireModule();
    const { file, doc } = await openDoc(path);
    if (doc.layers.length <= 1) throw new Error("A document must keep at least one layer.");
    const target = resolveLayer(doc, layer);
    const { removeLayer } = await import("../../texture/layers.js");
    removeLayer(doc, target.id);
    await file.saveTextureDocument(path, doc);
    return { path, removed: target.name, layers: doc.layers.length };
  },
});

// ---- drawing ----------------------------------------------------------------

defineOp({
  name: "texture.draw",
  description:
    "Draw a shape into an image: a filled or outlined rectangle or ellipse, a line, a flood fill, a gradient, or a solid fill of the whole layer. Coordinates are pixels from the top-left. This is how a texture gets authored rather than merely filtered — build it up from shapes on layers.",
  params: {
    path: { type: "string", required: true },
    shape: {
      type: "string",
      required: true,
      enum: ["rect", "ellipse", "line", "fill", "flood", "gradient"],
      description: "'fill' floods the whole layer; 'flood' is the paint bucket, seeded at (x, y).",
    },
    layer: { type: "any", description: "Layer index or id to draw on. Defaults to the active layer." },
    color: { type: "string", default: "#000000", description: "CSS colour." },
    opacity: { type: "number", default: 1, description: "0-1." },
    erase: { type: "boolean", default: false, description: "Erase instead of paint." },
    blend: { type: "string", default: "normal", description: "Blend mode for this stroke." },
    rect: {
      type: "array",
      description: "[x, y, width, height] for rect/ellipse/gradient.",
      items: { type: "number" },
    },
    from: { type: "array", description: "[x, y] start, for 'line'.", items: { type: "number" } },
    to: { type: "array", description: "[x, y] end, for 'line'.", items: { type: "number" } },
    width: { type: "number", default: 4, description: "Line width, or outline width when `fill` is false." },
    fill: { type: "boolean", default: true, description: "Fill the shape (rect/ellipse) rather than outlining it." },
    x: { type: "number", description: "Seed x, for 'flood'." },
    y: { type: "number", description: "Seed y, for 'flood'." },
    tolerance: { type: "number", default: 0.1, description: "Flood-fill colour tolerance, 0-1." },
    gradient: {
      type: "string",
      default: "linear",
      enum: ["linear", "radial"],
      description: "Gradient kind, for shape 'gradient'.",
    },
    colorTo: { type: "string", description: "Second gradient stop. Defaults to transparent black." },
  },
  async run(args) {
    requireModule();
    const { path, shape, layer, color = "#000000", opacity = 1, erase = false, blend = "normal" } = args;
    const { file, doc } = await openDoc(path);
    const target = resolveLayer(doc, layer);
    const buffer = target.buffer;
    const [draw, { parseColor, fillBuffer }] = await Promise.all([
      import("../../texture/draw.js"),
      import("../../texture/pixels.js"),
    ]);
    const rgba = parseColor(color, Math.round(255 * Math.max(0, Math.min(1, opacity))));

    if (shape === "fill") {
      fillBuffer(buffer, parseColor(color, 255));
    } else if (shape === "flood") {
      if (args.x === undefined || args.y === undefined) throw new Error("shape 'flood' needs `x` and `y`.");
      const stroke = draw.floodFill(buffer, Math.round(args.x), Math.round(args.y), {
        tolerance: args.tolerance ?? 0.1,
      });
      if (!stroke) throw new Error(`(${args.x}, ${args.y}) is outside this ${buffer.width}x${buffer.height} image.`);
      draw.applyStroke(buffer, stroke, { color: parseColor(color, 255), opacity, erase, blend });
    } else if (shape === "gradient") {
      const [x, y, w, h] = args.rect ?? [0, 0, buffer.width, buffer.height];
      const radial = (args.gradient ?? "linear") === "radial";
      draw.fillGradient(buffer, {
        type: args.gradient ?? "linear",
        // A radial gradient runs from the centre outward; a linear one across
        // the rect. Both read naturally from the same `rect`.
        x0: radial ? x + w / 2 : x,
        y0: radial ? y + h / 2 : y,
        x1: radial ? x + w : x + w,
        y1: radial ? y + h / 2 : y + h,
        from: parseColor(color, 255),
        to: args.colorTo ? parseColor(args.colorTo, 255) : [0, 0, 0, 0],
        opacity,
      });
    } else {
      const stroke = draw.createStroke(buffer.width, buffer.height);
      if (shape === "rect" || shape === "ellipse") {
        const [x, y, w, h] = args.rect ?? [];
        if (w === undefined) throw new Error(`shape '${shape}' needs \`rect\`: [x, y, width, height].`);
        const box = { x, y, width: w, height: h };
        const options = { fill: args.fill !== false, lineWidth: args.width ?? 4 };
        if (shape === "rect") draw.strokeRect(stroke, box, options);
        else draw.strokeEllipse(stroke, box, options);
      } else {
        const [x0, y0] = args.from ?? [];
        const [x1, y1] = args.to ?? [];
        if (x0 === undefined || x1 === undefined) throw new Error("shape 'line' needs `from` and `to`.");
        draw.strokeSegment(stroke, x0, y0, x1, y1, { radius: (args.width ?? 4) / 2 });
      }
      if (draw.strokeIsEmpty(stroke)) throw new Error("That shape covered no pixels — check the coordinates.");
      draw.applyStroke(buffer, stroke, { color: rgba, opacity, erase, blend });
    }

    // The layer-effect cache keys on this; without the bump a layer with a drop
    // shadow would keep compositing the pixels from before the stroke.
    target.rev = (target.rev ?? 0) + 1;
    await file.saveTextureDocument(path, doc);
    return { path, shape, layer: target.name, width: buffer.width, height: buffer.height };
  },
});

defineOp({
  name: "texture.generate",
  description:
    "Fill a layer with a procedural pattern — noise, a checkerboard, or stripes. The fast way to a usable placeholder, a roughness variation map, or a tiling test texture. Set colorSpace to 'linear' with texture.setMeta afterwards if the result is data rather than colour.",
  params: {
    path: { type: "string", required: true },
    generator: { type: "string", required: true, enum: ["noise", "checker", "stripes"], description: "Which pattern." },
    layer: { type: "any", description: "Layer index or id. Defaults to the active layer." },
    color: { type: "string", default: "#ffffff", description: "Primary colour." },
    colorTo: { type: "string", default: "#000000", description: "Secondary colour (checker/stripes)." },
    size: { type: "number", default: 32, description: "Cell size in pixels, for checker and stripes." },
    amount: { type: "number", default: 0.5, description: "Noise strength, 0-1." },
    monochrome: { type: "boolean", default: true, description: "Noise in grey rather than per-channel colour." },
    seed: { type: "number", default: 1, description: "Noise seed — the same seed gives the same texture." },
    vertical: { type: "boolean", default: false, description: "Stripes run vertically." },
  },
  async run({ path, generator, layer, color = "#ffffff", colorTo = "#000000", size = 32, amount = 0.5, monochrome = true, seed = 1, vertical = false }) {
    requireModule();
    const { file, doc } = await openDoc(path);
    const target = resolveLayer(doc, layer);
    const buffer = target.buffer;
    const { parseColor, fillBuffer } = await import("../../texture/pixels.js");

    if (generator === "noise") {
      const { noise } = await import("../../texture/filters.js");
      // Onto the layer's existing content, which is what makes "fill with grey,
      // then add noise" produce a usable roughness map in two calls.
      noise(buffer, { amount, monochrome, seed });
    } else {
      const a = parseColor(color, 255);
      const b = parseColor(colorTo, 255);
      const cell = Math.max(1, Math.round(size));
      fillBuffer(buffer, a);
      const { data, width, height } = buffer;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const on =
            generator === "checker"
              ? ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 1
              : (Math.floor((vertical ? x : y) / cell) & 1) === 1;
          if (!on) continue;
          const i = (y * width + x) * 4;
          data[i] = b[0];
          data[i + 1] = b[1];
          data[i + 2] = b[2];
          data[i + 3] = b[3];
        }
      }
    }

    target.rev = (target.rev ?? 0) + 1;
    await file.saveTextureDocument(path, doc);
    return { path, generator, layer: target.name, width: buffer.width, height: buffer.height };
  },
});

// ---- atlases ---------------------------------------------------------------

defineOp({
  name: "texture.atlas.pack",
  description:
    "Pack several images into one atlas: writes the packed image plus a .atlas descriptor naming every region. This is what SpriteComponent and the UI sample from, and one atlas is one draw call where the loose images were many.",
  params: {
    paths: { type: "array", required: true, description: "Absolute paths of the images to pack.", items: { type: "string" } },
    name: { type: "string", default: "Atlas", description: "Base name for the .png/.atlas pair." },
    directory: { type: "string", description: "Where to write them. Defaults to the folder of the first image." },
    padding: { type: "number", default: 2, description: "Transparent pixels between regions, to stop bleeding." },
    powerOfTwo: { type: "boolean", default: true, description: "Round the atlas up to a power-of-two size." },
  },
  async run({ paths, name = "Atlas", directory, padding = 2, powerOfTwo = true }) {
    requireModule();
    const { buildAtlasFromImages } = await import("../../atlasFile.js");
    const dir = directory ?? paths[0].replaceAll("\\", "/").split("/").slice(0, -1).join("/");
    const result = await buildAtlasFromImages(paths, { name, directory: dir, padding, powerOfTwo });
    await useProjectStore.getState().refresh();
    return result;
  },
});

defineOp({
  name: "texture.atlas.get",
  readOnly: true,
  description: "Read a .atlas descriptor: its image, size, every region's rect and pivot, and any sprite animations defined on it.",
  params: { path: { type: "string", required: true, description: "Absolute path to a .atlas file." } },
  async run({ path }) {
    const { readAtlas } = await import("../../atlasFile.js");
    const def = await readAtlas(path);
    return {
      path,
      image: def.image ?? null,
      size: def.size ?? null,
      regions: (def.regions ?? []).map((r) => ({ name: r.name, rect: r.rect, pivot: r.pivot ?? null, border: r.border ?? null })),
      animations: (def.animations ?? []).map((a) => ({ name: a.name, fps: a.fps ?? null, frames: (a.frames ?? []).length })),
    };
  },
});

defineOp({
  name: "texture.atlas.set",
  description:
    "Write a .atlas descriptor back — for renaming regions, adjusting pivots or nine-slice borders, and defining sprite animations. Read it with texture.atlas.get first and send back the whole document.",
  params: {
    path: { type: "string", required: true },
    regions: { type: "array", description: "Full region list: [{ name, rect: [x,y,w,h], pivot?, border? }].", items: { type: "object" } },
    animations: { type: "array", description: "Sprite animations: [{ name, fps, frames: [regionName…] }].", items: { type: "object" } },
  },
  async run({ path, regions, animations }) {
    const { readAtlas, writeAtlas } = await import("../../atlasFile.js");
    const def = await readAtlas(path);
    const next = {
      ...def,
      ...(regions ? { regions } : {}),
      ...(animations ? { animations } : {}),
    };
    await writeAtlas(path, next);
    return { path, regions: next.regions?.length ?? 0, animations: next.animations?.length ?? 0 };
  },
});

defineOp({
  name: "texture.atlas.export",
  description: "Write each region of an atlas out as its own image file — the reverse of packing, for handing sprites to something that cannot read the atlas.",
  params: {
    path: { type: "string", required: true, description: "Absolute path to a .atlas file." },
    directory: { type: "string", description: "Where to write the images. Defaults to a folder beside the atlas." },
  },
  async run({ path, directory }) {
    requireModule();
    const { readAtlas, exportRegions } = await import("../../atlasFile.js");
    const { atlasImagePath } = await import("../../../engine/sprite/atlasAsset.js");
    const { readImageBuffer } = await import("../../textureFile.js");
    const def = await readAtlas(path);
    // `def.image` is stored relative to the atlas; resolving it through the
    // atlas's own helper is what makes a hand-edited descriptor still work.
    const image = await readImageBuffer(atlasImagePath(def, path));
    const written = await exportRegions(path, def, image, { directory: directory ?? null });
    await useProjectStore.getState().refresh();
    return { exported: written };
  },
});
