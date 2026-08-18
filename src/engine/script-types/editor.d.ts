/**
 * Type declarations for the `editor` bare specifier — the in-editor scripting
 * surface (Unity's `UnityEditor` namespace, roughly). At runtime the specifier
 * is rewritten to `scriptRuntime/editorRuntime.js`; see `scriptRuntime.js`.
 *
 * Everything here is editor-only. Importing the module in a shipped game is
 * safe and free; CALLING `Editor.*` outside the editor throws, which is what
 * `isEditor()` is for.
 *
 * Kept deliberately in sync with `src/editor/api/index.js` — `scripts/
 * run-script-types-test.mjs` fails the build if a namespace or method exists
 * there and not here, because a facade method with no declaration is invisible
 * to autocomplete and therefore, in practice, does not exist. The op-level
 * descriptions live in the registry (they are what an MCP client reads); this
 * file describes the ergonomic facade a person writes against.
 *
 * ## What lives here vs in "engine"
 *
 * The editor-only *hooks* a script implements — `onEditorUpdate`,
 * `onDrawGizmos`, `onDrawGizmosSelected` — are declared on `Script` in
 * `engine.d.ts`, because that is where autocomplete looks when you type `on…`
 * inside a class body. Everything you *import* to build an editor script is
 * here. So a typical editor script imports from both:
 *
 *     import { Script } from "engine";
 *     import { Editor, executeInEditMode, menuItem } from "editor";
 */
declare module "editor" {
  import type { Gizmos, Entity } from "engine";

  // Re-exported so a script can annotate its own gizmo hook without a second
  // import: `onDrawGizmos(g: Gizmos)` works off either module.
  export type { Gizmos };

  /** Serializable snapshot of an entity, as returned by the op layer. */
  export interface EntityInfo {
    id: string;
    name: string;
    parentId: string | null;
    childIds: string[];
    tags: string[];
    transform: { position: number[]; rotation: number[]; scale: number[] };
    components: Array<{ type: string; props: Record<string, unknown> }>;
  }

  export interface ComponentTypeInfo {
    type: string;
    label: string;
    tags: string[];
    defaults: Record<string, unknown>;
    schema: Array<{ key: string; label?: string; type?: string; options?: unknown[] }>;
  }

  export interface EntitySpec {
    name?: string;
    parentId?: string;
    transform?: { position?: number[]; rotation?: number[]; scale?: number[] };
    components?: Array<{ type: string; props?: Record<string, unknown> }>;
  }

  /** A live entity handle — the same object a gameplay script gets from `this.entity`. */
  type LiveEntity = Entity;

  /** Descriptor of one registered editor operation. */
  export interface OpInfo {
    name: string;
    group: string;
    description: string;
    params: Record<string, { type?: string; description?: string; required?: boolean; default?: unknown }>;
    readOnly: boolean;
    undoable: boolean;
  }

  /** MCP-shaped tool descriptor. */
  export interface ToolInfo {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }

  /**
   * What `callTool` resolves to instead of throwing.
   *
   * NOT a discriminated union (`{ok: true, result} | {ok: false, error}`), and
   * that is deliberate. This project — and every project the editor scaffolds,
   * and the in-app code editor — compiles with `strict: false`, and without
   * `strictNullChecks` TypeScript cannot narrow the NEGATIVE branch of such a
   * union: `if (r.ok) {…} else { r.error }` reports "Property 'error' does not
   * exist" on the else. A union that only works in the branch nobody writes the
   * error handling in is worse than two optional fields.
   */
  export interface ToolCallResult {
    ok: boolean;
    /** Present when `ok` is true. */
    result?: unknown;
    /** The op's own error message. Present when `ok` is false. */
    error?: string;
  }

  /**
   * Results the op layer returns as ad-hoc objects.
   *
   * Typed loosely ON PURPOSE, and only where the shape genuinely varies by
   * provider, effect or file type. Everything with a fixed shape below is
   * written out in full — an `any` you have to go and read the source to use is
   * exactly the docs-lookup this surface exists to avoid.
   */
  type OpResult = Record<string, any>;

  // ---- viewport -------------------------------------------------------------

  /** A PNG returned by an op. The MCP layer turns `__image` into an image block. */
  export interface ImageResult {
    __image: { base64: string; mimeType: string };
    width: number;
    height: number;
  }

  export interface ScreenshotOptions {
    /** Image width in pixels (max 2048). Default 720. */
    width?: number;
    /** Image height in pixels (max 2048). Default 480. */
    height?: number;
    /** `"editor"` is the viewport you are moving; `"game"` is the scene's active camera. */
    camera?: "editor" | "game";
    /** Include editor-only overlays (grid, light helpers, selection box). */
    overlays?: boolean;
  }

  export interface CameraInfo {
    position: number[];
    target: number[];
  }

  /**
   * World-space extents of an entity's renderable content, children included.
   * `empty` is true when there is no geometry under it — check it before using
   * the rest, which is absent in that case.
   */
  export interface BoundsInfo {
    id: string;
    empty: boolean;
    /** Why there are no bounds. Only present when `empty`. */
    reason?: string;
    center?: number[];
    radius?: number;
    min?: number[];
    max?: number[];
    size?: number[];
  }

  export interface ConsoleEntry {
    level: string;
    message: string;
    time?: number;
  }

  // ---- authoring ------------------------------------------------------------

  export interface MaterialFields {
    /** Base colour as hex, e.g. `"#c0392b"`. */
    color?: string;
    /** 0 = mirror, 1 = fully matte. */
    roughness?: number;
    /** 0 = dielectric, 1 = metal. */
    metalness?: number;
    /** Absolute path to a base-colour texture. */
    map?: string;
    /** Emissive colour as hex. Use with `emissiveIntensity` for light sources. */
    emissive?: string;
    emissiveIntensity?: number;
    /** Below 1 also turns on transparency. */
    opacity?: number;
  }

  export interface PrefabInfo {
    path: string;
    name: string;
  }

  export interface ModuleInfo {
    id: string;
    name: string;
    enabled: boolean;
    description?: string;
  }

  // ---- assets ---------------------------------------------------------------

  export interface AssetEntry {
    path: string;
    name: string;
    isDir: boolean;
    size: number | null;
  }

  export interface AssetListOptions {
    directory?: string;
    ext?: string;
    depth?: number;
  }

  // ---- sound ----------------------------------------------------------------

  export type AudioProvider = "freesound" | "commons" | "archive";

  export interface AudioSearchOptions {
    /** Default `"freesound"`. `commons` and `archive` need no API key. */
    provider?: AudioProvider;
    /** `"sfx"` (under 15s), `"ambience"` (15s and up), or `"any"`. Default `"sfx"`. */
    kind?: "sfx" | "ambience" | "any";
    /** Freesound only. Default `"relevance"`. */
    sort?: "relevance" | "downloads" | "rating" | "newest" | "shortest" | "longest";
    /** Only public-domain sounds that need no credit. */
    cc0Only?: boolean;
    /** Only mono files — stereo does not spatialise on a 3D sound. Freesound only. */
    monoOnly?: boolean;
    /** 1-based page number. */
    page?: number;
  }

  export type AudioEditOperation =
    | "delete"
    | "silence"
    | "trim"
    | "duplicate"
    | "reverse"
    | "trimSilence"
    | "insertSilence";

  export interface AudioEditOptions {
    /** Range start in seconds. Omit for the start of the track. */
    startSeconds?: number;
    /** Range end in seconds. Omit for the end of the track. */
    endSeconds?: number;
    /** Track index from `tracks()`. Default 0. */
    track?: number;
    /** Default true. Cutting off a zero crossing leaves a click. */
    snapToZeroCrossing?: boolean;
    /** For `insertSilence`: how much to insert at `startSeconds`. */
    seconds?: number;
    /** For `trimSilence`: what counts as silence. Default -60. */
    thresholdDb?: number;
  }

  export interface AudioExportOptions {
    /** Default `"ogg"` — typically 15-20x smaller than WAV, and what a web build should ship. */
    format?: "ogg" | "wav";
    /** Defaults to the source path with the new extension. */
    targetPath?: string;
    /** Ogg only. 64000 mono SFX, 96000 default, 128000 music. */
    bitrate?: number;
    /** WAV only: 16, 24 or 32. */
    bitDepth?: number;
    /** Report the sizes without writing anything. */
    estimateOnly?: boolean;
  }

  // ---- asset libraries ------------------------------------------------------

  /** Poly Haven, ambientCG, Sketchfab, itch.io. `status()` reports which are usable. */
  export type LibraryProvider = string;

  export type LibraryAssetType = "texture" | "model" | "hdri" | "pack";

  export interface LibrarySearchOptions {
    /** Default `"texture"`. Sketchfab is models only; itch.io is packs. */
    type?: LibraryAssetType;
    /** 1-100. Default 20. */
    limit?: number;
  }

  export interface LibraryImportOptions {
    /** Must match the type the id was found under. */
    type?: LibraryAssetType;
    /** Provider-specific: Poly Haven `"1k"`/`"2k"`/`"4k"`, ambientCG `"1K-JPG"`. */
    resolution?: string;
    /** itch.io only: which upload of the pack to fetch. */
    uploadId?: number;
  }

  // ---- images ---------------------------------------------------------------

  export interface TextureCreateOptions {
    /** Pixels. Default 512. */
    width?: number;
    /** Pixels. Default 512. */
    height?: number;
    /** CSS colour to fill with. Omit for a transparent canvas. */
    background?: string;
  }

  export interface TextureResizeOptions {
    /** `"resize"` resamples; `"canvas"` re-frames. Default `"resize"`. */
    mode?: "resize" | "canvas";
    filter?: "bilinear" | "nearest";
  }

  export interface TextureMetaPatch {
    /** srgb for colour maps, linear for data maps (normal, roughness, AO). */
    colorSpace?: "srgb" | "linear";
    wrap?: "repeat" | "clamp" | "mirror";
    [key: string]: unknown;
  }

  export interface TextureLayerOptions {
    name?: string;
    /** CSS colour to fill it with. Omit for a transparent layer. */
    fill?: string;
    /** 0-1. */
    opacity?: number;
    /** Blend mode id — `info()` lists the modes. */
    blend?: string;
  }

  export interface TextureLayerPatch {
    name?: string;
    visible?: boolean;
    opacity?: number;
    blend?: string;
    /** `[x, y]` pixel offset of this layer within the canvas. */
    offset?: number[];
  }

  export type TextureShape = "rect" | "ellipse" | "line" | "fill" | "flood" | "gradient";

  export interface TextureDrawOptions {
    /** Layer index or id. Defaults to the active layer. */
    layer?: number | string;
    /** CSS colour. Default `"#000000"`. */
    color?: string;
    /** 0-1. */
    opacity?: number;
    erase?: boolean;
    blend?: string;
    /** `[x, y, width, height]` for rect/ellipse/gradient. */
    rect?: number[];
    /** `[x, y]` start, for `"line"`. */
    from?: number[];
    /** `[x, y]` end, for `"line"`. */
    to?: number[];
    /** Line width, or outline width when `fill` is false. */
    width?: number;
    /** Fill the shape rather than outlining it. Default true. */
    fill?: boolean;
    /** Seed x, for `"flood"`. */
    x?: number;
    /** Seed y, for `"flood"`. */
    y?: number;
    /** Flood-fill colour tolerance, 0-1. */
    tolerance?: number;
    gradient?: "linear" | "radial";
    /** Second gradient stop. Defaults to transparent black. */
    colorTo?: string;
  }

  export interface AtlasPackOptions {
    /** Base name for the .png/.atlas pair. Default `"Atlas"`. */
    name?: string;
    /** Defaults to the folder of the first image. */
    directory?: string;
    /** Transparent pixels between regions, to stop bleeding. Default 2. */
    padding?: number;
    powerOfTwo?: boolean;
  }

  // ---- geometry (Edit Mode) -------------------------------------------------

  export type GeometryMode = "vert" | "edge" | "face";

  export type GeometrySelectAction =
    | "all" | "none" | "invert" | "grow" | "shrink" | "linked"
    | "index" | "box" | "trait" | "similar" | "random";

  export type GeometryTrait =
    | "nonManifold" | "loose" | "interior" | "boundary" | "sharp" | "sides" | "ungrouped";

  export interface GeometrySelectOptions {
    /** Defaults to the session's current mode. */
    mode?: GeometryMode;
    /** For action `"index"`: positions in the CURRENT element order, which the
     *  next operator invalidates. Prefer `box` / `trait` / `similar` / `linked`. */
    indices?: number[];
    /** For action `"box"`: `[x,y,z]` lower corner, in the mesh's local space. */
    min?: number[];
    /** For action `"box"`: `[x,y,z]` upper corner. */
    max?: number[];
    trait?: GeometryTrait;
    /** For action `"similar"`: normal, area, sides, material, length, direction… */
    similar?: string;
    /** Tolerance for `"similar"`. */
    threshold?: number;
    /** Fraction to keep, for `"random"`. */
    ratio?: number;
    /** Extend the current selection instead of replacing it. */
    add?: boolean;
  }

  export interface GeometryTransformOptions {
    /** `[x,y,z]` offset. */
    translate?: number[];
    /** `[x,y,z]` degrees. */
    rotate?: number[];
    /** `[x,y,z]` multipliers. */
    scale?: number[];
    /** `[x,y,z]` to transform around. Defaults to the selection's median. */
    pivot?: number[];
  }

  export type GeometryPrimitive =
    | "plane" | "cube" | "circle" | "uvsphere" | "icosphere"
    | "cylinder" | "cone" | "torus" | "grid";

  export interface GeometryPrimitiveOptions {
    /** `[x,y,z]` local-space position. */
    at?: number[];
    /** Shape parameters: `size`, `radius`, `segments`, `depth`, `subdivisions`,
     *  `rings`, `tube` — per primitive. Omitted values take Blender-like defaults. */
    options?: Record<string, number>;
  }

  export interface GeometryRemeshOptions {
    /** World-space voxel edge. Omit for the suggested size. */
    voxelSize?: number;
    /** 0 keeps a uniform grid; higher merges flat regions. */
    adaptivity?: number;
  }

  // ---- pipeline / build -----------------------------------------------------

  export interface NavBakeOptions {
    /** Entity carrying the NavMesh component. Omit to use the only one. */
    id?: string;
    /** Where to write the .navmesh. Defaults to the component's current asset. */
    path?: string;
  }

  export interface TerrainOptions {
    /** World size of one side, in metres. Default 50. */
    size?: number;
    /** Heightmap resolution per side, in samples. Default 128. */
    resolution?: number;
    name?: string;
  }

  // ---- level design ---------------------------------------------------------

  export interface LevelCreateOptions {
    name?: string;
    /** Y of the first storey, in metres. Default 0. */
    elevation?: number;
    /** Snap step in metres. Default 1. */
    grid?: number;
    /** Distance between storeys. Default 3. */
    storeyHeight?: number;
    wallHeight?: number;
    wallThickness?: number;
    slabThickness?: number;
    /** Give every piece a mesh collider (needs `physics-rapier`). Default true. */
    collision?: boolean;
  }

  export type BlockoutShape = "floor" | "wall" | "stair" | "ramp" | "box" | "column" | "platform";

  export interface LevelPieceOptions {
    shape: BlockoutShape;
    /** Drag start [x, y, z]; Y is the storey elevation. */
    from?: [number, number, number];
    /** Drag end. Omit for a click-place (one grid cell, or a column). */
    to?: [number, number, number];
    /** Explicit world position; overrides from/to. */
    position?: [number, number, number];
    /** Explicit local size [x, y, z]: X length, Y height, Z depth. */
    size?: [number, number, number];
    rotationY?: number;
    floorId?: string;
    levelId?: string;
    /** Stairs: step count. 0 derives ~18 cm risers. */
    steps?: number;
    /** Stairs: open treads. */
    open?: boolean;
    /** Columns: 4 is a square pillar, 8+ reads as round. */
    sides?: number;
    color?: string;
    material?: string;
    collision?: boolean;
    name?: string;
  }

  export interface LevelOpeningOptions {
    kind?: "door" | "window" | "arch";
    /** Metres along the wall from its centre. */
    offset?: number;
    width?: number;
    height?: number;
    /** Height of the hole's bottom edge; 0 is a doorway. */
    sill?: number;
  }

  export interface LevelToolOptions {
    tool?: "select" | "floor" | "wall" | "stair" | "ramp" | "box" | "column" | "platform" | "opening" | "erase" | "";
    levelId?: string;
    floorId?: string;
    elevation?: number;
    grid?: number;
  }

  export interface CharacterCreateOptions {
    name?: string;
    /** Which view the camera starts in. Default "third". */
    view?: "first" | "third";
    /** World position of the character's FEET. */
    position?: [number, number, number];
    /** Capsule COLLIDER cylinder height; total height adds 2 × radius. Default
     *  1. The visible body (see `withMesh`) is scaled to match this. */
    height?: number;
    radius?: number;
    /** Give the rig a visible body: the default animated humanoid, or a
     *  capsule primitive if that model couldn't be set up. False adds
     *  neither — not "use the capsule instead of the model". Default true. */
    withMesh?: boolean;
    parentId?: string;
  }

  export type BuildTarget = "web" | "zip" | "desktop";

  // ---- version control ------------------------------------------------------

  export interface GitStatusInfo {
    /** False when the project is not a repository — check this before anything else. */
    isRepo: boolean;
    branch?: string | null;
    files?: Array<{ path: string; status: string; staged: boolean }>;
    [key: string]: unknown;
  }

  export interface GitCommitOptions {
    /** Stage everything first. */
    all?: boolean;
    amend?: boolean;
  }

  // ---- batch ----------------------------------------------------------------

  export interface BatchStep {
    /** Op name, e.g. `"entity.create"`. */
    op: string;
    /** `"$0"` anywhere in here resolves to the id step 0 returned. */
    args?: Record<string, unknown>;
  }

  export interface EditorApi {
    /** Semantic version of the API surface, for feature detection. MINOR bumps
     *  when ops are added. */
    version: string;

    // ---- raw registry access ------------------------------------------------

    /** Every registered operation. The escape hatch's index. */
    ops(): OpInfo[];
    /** The registry as MCP tool descriptors. */
    tools(options?: { readOnly?: boolean }): ToolInfo[];
    /** Call an operation by name. Throws on error. Use for anything the
     *  namespaces below don't wrap. */
    call(name: string, args?: Record<string, unknown>): Promise<unknown>;
    /** Transport form of `call` — resolves rather than throwing. */
    callTool(toolName: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
    /** Maps an MCP tool name (`entity_create`) back to its op name. */
    resolveToolName(toolName: string): string | null;

    // ---- scene --------------------------------------------------------------

    entities: {
      all(filter?: { tag?: string; nameContains?: string }): EntityInfo[];
      get(id: string): EntityInfo;
      /**
       * The LIVE runtime `Entity` — Object3D, components, methods. Editor-only;
       * it cannot cross a transport, so it has no op equivalent.
       *
       * Reach for it to READ (a matrix, a component's state). Use the op-backed
       * methods to CHANGE things, so the edit lands on the undo stack.
       */
      live(id: string): LiveEntity | null;
      create(spec?: EntitySpec): EntityInfo;
      delete(ids: string | string[]): { deleted: number };
      rename(id: string, name: string): EntityInfo;
      reparent(id: string, parentId?: string | null, index?: number | null): EntityInfo;
      duplicate(ids: string | string[]): EntityInfo[];
      setTransform(
        id: string,
        transform: { position?: number[]; rotation?: number[]; scale?: number[] },
      ): EntityInfo;
      setTags(id: string, tags: string[]): EntityInfo;
      /** World-space extents — unknowable from transforms alone. */
      getBounds(id: string): BoundsInfo;
    };

    components: {
      /** Every component type with its label, defaults and schema. Read this
       *  rather than guessing property names. */
      types(): ComponentTypeInfo[];
      add(id: string, type: string, props?: Record<string, unknown>): EntityInfo;
      remove(id: string, type: string): EntityInfo;
      setProp(id: string, type: string, key: string, value: unknown): EntityInfo;
    };

    selection: {
      get(): { entityIds: string[]; entities: EntityInfo[]; assetPaths: string[]; assetPath: string | null };
      readonly ids: string[];
      /** Live `Entity` objects for the current selection. */
      readonly entities: LiveEntity[];
      set(ids: string | string[]): { entityIds: string[] };
      clear(): { entityIds: string[] };
      selectAssets(paths: string | string[]): { assetPaths: string[] };
    };

    history: {
      get(): { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
      undo(): { canUndo: boolean; canRedo: boolean };
      redo(): { canUndo: boolean; canRedo: boolean };
    };

    play: {
      readonly isPlaying: boolean;
      start(): Promise<{ playing: boolean }>;
      stop(): Promise<{ playing: boolean }>;
    };

    scene: {
      get(): { name: string; path: string | null; dirty: boolean; rootIds: string[]; entityCount: number };
      save(): Promise<{ path: string | null }>;
      open(path: string): Promise<{ path: string | null }>;
      /** Fog, environment, tone mapping, shadows — the scene's look. */
      getSettings(): Promise<OpResult>;
      setSettings(patch: Record<string, unknown>, label?: string): Promise<OpResult>;
    };

    project: {
      get(): { rootPath: string | null; currentPath: string | null; meta: Record<string, unknown> };
      readonly rootPath: string | null;
    };

    // ---- sight --------------------------------------------------------------

    /** How a script sees what it built. Without these it is authoring blind. */
    viewport: {
      /** Resolves to a real PNG in `__image.base64`. */
      screenshot(options?: ScreenshotOptions): Promise<ImageResult>;
      getCamera(): CameraInfo;
      /** `position` is the eye, `target` the point to look at. */
      setCamera(position?: number[], target?: number[]): CameraInfo;
      /** Frame an entity (or the whole scene when `id` is omitted). */
      focus(id?: string, distance?: number): CameraInfo;
      /** Omit `enabled` to read the current setting rather than change it. */
      freezeWhenUnfocused(enabled?: boolean): { enabled: boolean };
    };

    /** Recent editor console output — how a script reads back its own errors. */
    console: {
      read(options?: { level?: "all" | "error" | "warn"; limit?: number }): { entries: ConsoleEntry[] };
    };

    // ---- authoring ----------------------------------------------------------

    assets: {
      list(options?: AssetListOptions): Promise<AssetEntry[]>;
      read(path: string): Promise<string>;
      write(path: string, contents: string): Promise<{ path: string }>;
      createScript(name?: string, directory?: string): Promise<{ path: string }>;
      openInIDE(path: string): Promise<{ opened: boolean }>;
      reveal(path: string): Promise<{ revealed: boolean }>;
      /** NOT undoable — these are files, not editor commands. */
      delete(paths: string | string[]): Promise<OpResult>;
      rename(path: string, name: string): Promise<OpResult>;
      move(paths: string | string[], directory: string): Promise<OpResult>;
      createFolder(path: string): Promise<OpResult>;
      /** Re-read files changed outside the editor. Omit `paths` to just re-list. */
      refresh(paths?: string | string[]): Promise<OpResult>;
      watchStatus(): OpResult;
      /** What can be done with this asset — the Inspector's own action list. */
      actions(path: string): Promise<{ path: string; actions: Array<{ id: string; label: string }> }>;
      /** Run one of the ids `actions()` returned, e.g. `"texture.material"`. */
      runAction(path: string, action: string): Promise<OpResult>;
    };

    materials: {
      /** `name` gets `.mat` appended if missing. */
      create(name: string, fields?: MaterialFields): Promise<{ path: string }>;
      get(path: string): Promise<OpResult>;
      /** Merges `patch` into the material, e.g. `{ roughness: 0.2 }`. */
      set(path: string, patch: MaterialFields & Record<string, unknown>): Promise<OpResult>;
    };

    prefabs: {
      list(): Promise<PrefabInfo[]>;
      instantiate(
        path: string,
        options?: { position?: number[]; parentId?: string },
      ): Promise<EntityInfo>;
      /** Saves the entity as a prefab. `folder` defaults to the project's prefab folder. */
      createFrom(id: string, folder?: string): Promise<{ path: string }>;
    };

    /** Engine modules. Enabling one changes what the project ships — ask first. */
    modules: {
      list(): Promise<ModuleInfo[]>;
      setEnabled(id: string, enabled: boolean): Promise<ModuleInfo>;
    };

    /** Typefaces: the project's, Google Fonts', and importing one. */
    fonts: {
      list(): Promise<OpResult>;
      inspect(path: string): Promise<OpResult>;
      search(
        query?: string,
        options?: { category?: string; limit?: number },
      ): Promise<OpResult>;
      /** `family` is the exact name, e.g. `"Press Start 2P"`. `weights` like `["400","700"]`. */
      import(family: string, weights?: string[]): Promise<{ family: string; files: string[] }>;
    };

    /**
     * Sound: the free libraries (search, import, licence ledger) and the editor
     * (inspect and edit a file's track stack without opening the panel).
     */
    audio: {
      /** Which providers are usable, and whether Freesound has a key. */
      status(): Promise<OpResult>;
      search(query: string, options?: AudioSearchOptions): Promise<OpResult>;
      /** Downloads into `<project>/Audio/<Provider>/` and records the licence. */
      import(id: string | number, provider?: AudioProvider): Promise<OpResult>;
      /** The attribution ledger — what this project owes whom. */
      credits(): Promise<OpResult>;

      info(path: string): Promise<OpResult>;
      tracks(path: string): Promise<OpResult>;
      /** Ranges are in seconds and default to the whole track. */
      edit(path: string, operation: AudioEditOperation, options?: AudioEditOptions): Promise<OpResult>;
      /** Every available effect and the params it reads. */
      effects(): Promise<OpResult>;
      process(
        path: string,
        effect: string,
        params?: Record<string, unknown>,
        options?: Record<string, unknown>,
      ): Promise<OpResult>;
      generate(path: string, generator: string, options?: Record<string, unknown>): Promise<OpResult>;
      /** Layer another sound on as a new track — how a designed effect is built. */
      addTrack(path: string, sourcePath: string, options?: Record<string, unknown>): Promise<OpResult>;
      setTrack(path: string, track: number, patch?: Record<string, unknown>): Promise<OpResult>;
      removeTrack(path: string, track: number): Promise<OpResult>;
      /** Find or make a seamless loop point. */
      loop(path: string, options?: Record<string, unknown>): Promise<OpResult>;
      /** Generate pitch/timing variants, so a footstep isn't the same sample twice. */
      variations(path: string, options?: Record<string, unknown>): Promise<OpResult>;
      export(path: string, options?: AudioExportOptions): Promise<OpResult>;
    };

    /**
     * The asset libraries — Poly Haven, ambientCG, Sketchfab, itch.io — behind
     * one search/import pair, so finding a rock texture does not mean learning
     * four vocabularies. Imports are NOT undoable.
     */
    library: {
      /** Which providers are configured and usable. */
      status(): Promise<OpResult>;
      search(
        provider: LibraryProvider,
        query?: string,
        options?: LibrarySearchOptions,
      ): Promise<OpResult[]>;
      /** `id` comes from a `search()` result. */
      import(provider: LibraryProvider, id: string | number, options?: LibraryImportOptions): Promise<OpResult>;
      /** Point the scene's environment at an imported HDRI. */
      setEnvironment(path: string): Promise<OpResult>;
    };

    /** Images: create, inspect, process, and pack into atlases. */
    textures: {
      info(path: string): Promise<OpResult>;
      /** `name`'s extension decides the format. Written to disk immediately. */
      create(directory: string, name: string, options?: TextureCreateOptions): Promise<{ path: string; width: number; height: number }>;
      /** Every available effect and the params it reads. */
      effects(): Promise<OpResult>;
      process(path: string, effect: string, params?: Record<string, unknown>): Promise<OpResult>;
      resize(path: string, width: number, height: number, options?: TextureResizeOptions): Promise<OpResult>;
      /** Colour space and wrap mode — the `.meta` flags that decide how it samples. */
      setMeta(path: string, patch: TextureMetaPatch): Promise<OpResult>;
      addLayer(path: string, options?: TextureLayerOptions): Promise<OpResult>;
      setLayer(path: string, layer: number | string, patch?: TextureLayerPatch): Promise<OpResult>;
      removeLayer(path: string, layer: number | string): Promise<OpResult>;
      /** How a texture gets authored rather than merely filtered. */
      draw(path: string, shape: TextureShape, options?: TextureDrawOptions): Promise<OpResult>;
      generate(path: string, generator: "noise" | "checker" | "stripes", options?: Record<string, unknown>): Promise<OpResult>;
      atlas: {
        /** One atlas is one draw call where the loose images were many. */
        pack(paths: string[], options?: AtlasPackOptions): Promise<OpResult>;
        get(path: string): Promise<OpResult>;
        set(path: string, patch: Record<string, unknown>): Promise<OpResult>;
        export(path: string, directory?: string): Promise<OpResult>;
      };
    };

    /** Edit Mode, driven from a script: begin, select, operate, commit. */
    geometry: {
      begin(entityId: string): Promise<OpResult>;
      status(): Promise<OpResult>;
      /** Call before every operator — one with nothing selected does nothing. */
      select(action: GeometrySelectAction, options?: GeometrySelectOptions): Promise<OpResult>;
      /** Every modelling operator and the params it reads. */
      operations(): Promise<OpResult[]>;
      /** `operation` is an id from `operations()`, e.g. `"extrude"`, `"bevel"`. */
      edit(operation: string, params?: Record<string, unknown>): Promise<OpResult>;
      /** Move/rotate/scale the selection in the mesh's local space; degrees. */
      transform(options?: GeometryTransformOptions): Promise<OpResult>;
      addPrimitive(kind: GeometryPrimitive, options?: GeometryPrimitiveOptions): Promise<OpResult>;
      /** Voxel remesh — destroys the existing topology by design. */
      remesh(options?: GeometryRemeshOptions): Promise<OpResult>;
      commit(keepOpen?: boolean): Promise<OpResult>;
      cancel(): Promise<OpResult>;
    };

    /**
     * Greybox level blockouts (the `level-design` module). `addPiece` takes
     * the two points of a drag — the same gesture the viewport tools use — so
     * a generated room is one call per wall rather than a page of trigonometry.
     */
    level: {
      list(): Promise<OpResult>;
      create(options?: LevelCreateOptions): Promise<OpResult>;
      addFloor(levelId: string, elevation: number): Promise<OpResult>;
      addPiece(options?: LevelPieceOptions): Promise<OpResult>;
      addOpening(entityId: string, options?: LevelOpeningOptions): Promise<OpResult>;
      removeOpening(entityId: string, index: number): Promise<OpResult>;
      /** Mesh colliders for every piece that lacks one. */
      addColliders(levelId: string): Promise<OpResult>;
      /** true = the pieces' assigned materials, false = the greybox palette. */
      setPreview(levelId: string, preview: boolean): Promise<OpResult>;
      /** Arms the viewport tools; pass `tool: ""` to disarm. */
      setTool(options?: LevelToolOptions): Promise<OpResult>;
    };

    /** The player rig: kinematic controller, an animated body, camera, and
     *  their scripts (the `character-controller` module). */
    character: {
      create(options?: CharacterCreateOptions): Promise<OpResult>;
    };

    /** Compression, baking, generation. */
    pipeline: {
      /** `"auto"` picks by file type: draco for .glb, basis for images. */
      compress(path: string, codec?: "auto" | "draco" | "basis"): Promise<OpResult>;
      compressAllTextures(): Promise<OpResult>;
      bakeNavMesh(options?: NavBakeOptions): Promise<OpResult>;
      createTerrain(options?: TerrainOptions): Promise<EntityInfo>;
    };

    /**
     * Version control. Every method maps to a button the Source Control panel
     * offers. Call `status()` first — it reports whether there is a repository
     * at all rather than throwing when there isn't.
     */
    git: {
      status(): Promise<GitStatusInfo>;
      init(options?: { lfs?: boolean }): Promise<OpResult>;
      /** Omit `paths` to stage everything. */
      stage(paths?: string | string[]): Promise<OpResult>;
      unstage(paths?: string | string[]): Promise<OpResult>;
      /** Destroys uncommitted work. Confirm with the user first. */
      discard(paths: string | string[]): Promise<OpResult>;
      commit(message: string, options?: GitCommitOptions): Promise<OpResult>;
      diff(options?: { path?: string; staged?: boolean }): Promise<OpResult>;
      log(options?: { limit?: number; path?: string }): Promise<OpResult>;
      show(commit: string): Promise<OpResult>;
      branches(): Promise<OpResult>;
      checkout(ref: string, options?: { create?: boolean }): Promise<OpResult>;
      deleteBranch(name: string, force?: boolean): Promise<OpResult>;
      merge(ref: string): Promise<OpResult>;
      abortMerge(): Promise<OpResult>;
      stash(options?: { message?: string }): Promise<OpResult>;
      stashPop(index?: number): Promise<OpResult>;
      stashList(): Promise<OpResult>;
      remotes(): Promise<OpResult>;
      addRemote(url: string, name?: string): Promise<OpResult>;
      fetch(options?: { prune?: boolean }): Promise<OpResult>;
      pull(options?: { rebase?: boolean }): Promise<OpResult>;
      push(options?: { force?: boolean; setUpstream?: boolean }): Promise<OpResult>;
      setIdentity(name: string, email: string, global?: boolean): Promise<OpResult>;
      /** Track binary patterns with LFS. Do this BEFORE the first add. */
      lfs(patterns?: string[]): Promise<OpResult>;
      github: {
        status(): Promise<OpResult>;
        login(token?: string): Promise<OpResult>;
        createRepo(name: string, options?: { private?: boolean; push?: boolean }): Promise<OpResult>;
      };
    };

    /** Building and publishing. NOT undoable. */
    build: {
      get(): Promise<OpResult>;
      set(patch: Record<string, unknown>): Promise<OpResult>;
      /** Overrides the configured target for this run only. */
      export(target?: BuildTarget): Promise<OpResult>;
      publish(): Promise<OpResult>;
      /** `lan` serves on the LAN address (with TLS), for testing on a phone. */
      preview(lan?: boolean): Promise<OpResult>;
      /**
       * The live, rebuild-on-every-edit server behind the viewport's Wi-Fi
       * button. Sticky per project: one left serving serves again on the next
       * editor launch, until it is stopped. Omit `enabled` to read the state.
       */
      serve(enabled?: boolean): Promise<OpResult>;
    };

    /**
     * Runs several ops as ONE undo step and one round trip. `"$0"` inside a
     * later step's args resolves to the id step 0 returned.
     *
     * Not atomic: the steps run in order and a failure part-way leaves the
     * earlier ones applied (collapsed into the single undo entry).
     */
    batch(label: string, steps: BatchStep[], options?: Record<string, unknown>): Promise<OpResult>;

    // ---- editor chrome ------------------------------------------------------

    /** The editor's own code editor. */
    code: {
      /** Show the user the file you are talking about. Does not modify it. */
      open(path: string): Promise<{ opened: string }>;
      /** Which files are open and which have unsaved edits — worth checking
       *  before writing to one. */
      openFiles(): Promise<{ files: string[]; active: string | null; unsaved: string[] }>;
    };

    menu: {
      /** Adds a menu entry at `"TopMenu/Label"`. Returns an unregister function. */
      add(path: string, run: () => void, options?: { id?: string; order?: number }): () => void;
      list(): Array<{ id: string; menu: string; label: string; order: number; run: () => void }>;
      subscribe(fn: (items: Array<{ id: string; menu: string; label: string }>) => void): () => void;
    };

    /** Writes to the editor's console panel, tagged with where it came from. */
    log(...args: unknown[]): void;
  }

  /** The editor. Throws on any access outside the editor — guard with {@link isEditor}. */
  export const Editor: EditorApi;

  /** True when running inside the editor. False in a built game. */
  export function isEditor(): boolean;

  /** Alias of {@link isEditor}, named after the underlying bridge. */
  export function hasEditorApi(): boolean;

  /**
   * Class decorator — Unity's `[ExecuteInEditMode]`. The script gets its
   * `onStart` / `onDestroy` lifecycle and an `onEditorUpdate(dt)` tick while
   * the editor is NOT playing.
   *
   * `onUpdate` still fires only while playing, so gameplay logic can't run
   * against the scene you are authoring by accident.
   *
   * Usable bare or called:
   *
   *     @executeInEditMode
   *     export default class Grid extends Script {}
   *
   *     @executeInEditMode()
   *     export default class Grid extends Script {}
   */
  export function executeInEditMode<T extends Function>(target: T): T;
  export function executeInEditMode(): <T extends Function>(target: T) => T;

  /**
   * Method decorator adding a menu-bar entry bound to this script instance, so
   * it can touch `this.entity`. Appears only while an entity carrying the
   * script is in the scene.
   *
   * `"Tools/Rebuild Nav Mesh"` puts "Rebuild Nav Mesh" under a Tools menu; a
   * path with no slash defaults to Tools.
   */
  export function menuItem(path: string, options?: { order?: number }): MethodDecorator;

  /**
   * Registers a menu entry not bound to any entity — for project-wide tools.
   * Call it at module scope. Returns an unregister function.
   *
   * The script still has to be assigned to a Script component slot somewhere in
   * the scene: nothing scans a folder, so a file no entity references is never
   * loaded and never registers anything.
   */
  export function registerMenuItem(
    path: string,
    run: () => void,
    options?: { id?: string; order?: number },
  ): () => void;
}
