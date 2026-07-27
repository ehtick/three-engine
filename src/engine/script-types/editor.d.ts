/**
 * Type declarations for the `editor` bare specifier — the in-editor scripting
 * surface (Unity's `UnityEditor` namespace, roughly). At runtime the specifier
 * is rewritten to `scriptRuntime/editorRuntime.js`; see `scriptRuntime.js`.
 *
 * Everything here is editor-only. Importing the module in a shipped game is
 * safe and free; CALLING `Editor.*` outside the editor throws, which is what
 * `isEditor()` is for.
 *
 * Kept deliberately in sync with `src/editor/api/index.js`. The op-level
 * descriptions live in the registry (they are what an MCP client reads); this
 * file describes the ergonomic facade a person writes against.
 */
declare module "editor" {
  import type { Object3D, Vector3, Matrix4, Color } from "three/webgpu";

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

  /** Anything the gizmo helpers accept as a point. */
  type Point = Vector3 | [number, number, number] | { x: number; y: number; z: number };

  /**
   * Immediate-mode wireframe drawing surface handed to `onDrawGizmos`.
   * Every call appends to a single batched line buffer that is cleared each
   * frame, so draw unconditionally and never clean up.
   */
  export interface Gizmos {
    /** Colour for subsequent draws. */
    color(value: string | number | Color): Gizmos;
    color(r: number, g: number, b: number): Gizmos;
    /** Transform applied to subsequent vertices; null clears it. */
    transform(matrix: Matrix4 | null): Gizmos;
    line(from: Point, to: Point): Gizmos;
    ray(origin: Point, direction: Point, length?: number): Gizmos;
    /** Axis-aligned wire box; `size` is the full extent. */
    box(center: Point, size?: number | Point): Gizmos;
    circle(center: Point, radius?: number, normal?: Point, segments?: number): Gizmos;
    /** Wire sphere drawn as three great circles. */
    sphere(center: Point, radius?: number, segments?: number): Gizmos;
    /** Small three-axis cross marking a position. */
    point(position: Point, size?: number): Gizmos;
    polyline(points: Point[], closed?: boolean): Gizmos;
  }

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

  export interface EditorApi {
    version: string;

    /** Every registered operation. */
    ops(): OpInfo[];
    /** The registry as MCP tool descriptors. */
    tools(options?: { readOnly?: boolean }): ToolInfo[];
    /** Call an operation by name. Throws on error. */
    call(name: string, args?: Record<string, unknown>): Promise<unknown>;
    /** Transport form of `call` — resolves rather than throwing. */
    callTool(
      toolName: string,
      args?: Record<string, unknown>,
    ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

    entities: {
      all(filter?: { tag?: string; nameContains?: string }): EntityInfo[];
      get(id: string): EntityInfo;
      /** The live runtime Entity — Object3D, components, methods. Editor-only;
       *  cannot cross a transport, so it has no op equivalent. */
      live(id: string): { id: string; name: string; object3D: Object3D } | null;
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
    };

    components: {
      types(): ComponentTypeInfo[];
      add(id: string, type: string, props?: Record<string, unknown>): EntityInfo;
      remove(id: string, type: string): EntityInfo;
      setProp(id: string, type: string, key: string, value: unknown): EntityInfo;
    };

    selection: {
      get(): { entityIds: string[]; entities: EntityInfo[]; assetPaths: string[]; assetPath: string | null };
      readonly ids: string[];
      /** Live Entity objects for the current selection. */
      readonly entities: Array<{ id: string; name: string; object3D: Object3D }>;
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
    };

    project: {
      get(): { rootPath: string | null; currentPath: string | null; meta: Record<string, unknown> };
      readonly rootPath: string | null;
    };

    assets: {
      list(options?: { directory?: string; ext?: string; depth?: number }): Promise<
        Array<{ path: string; name: string; isDir: boolean; size: number | null }>
      >;
      read(path: string): Promise<string>;
      write(path: string, contents: string): Promise<{ path: string }>;
      createScript(name?: string, directory?: string): Promise<{ path: string }>;
      openInIDE(path: string): Promise<{ opened: boolean }>;
      reveal(path: string): Promise<{ revealed: boolean }>;
    };

    menu: {
      /** Adds a menu entry at "TopMenu/Label". Returns an unregister function. */
      add(path: string, run: () => void, options?: { id?: string; order?: number }): () => void;
      list(): Array<{ id: string; menu: string; label: string; order: number; run: () => void }>;
      subscribe(fn: (items: Array<{ id: string; menu: string; label: string }>) => void): () => void;
    };

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
   */
  export function executeInEditMode<T extends Function>(target: T): T;
  export function executeInEditMode(): <T extends Function>(target: T) => T;

  /**
   * Method decorator adding a menu-bar entry bound to this script instance.
   * `"Tools/Rebuild Nav Mesh"` puts "Rebuild Nav Mesh" under a Tools menu; a
   * path with no slash defaults to Tools.
   */
  export function menuItem(path: string, options?: { order?: number }): MethodDecorator;

  /**
   * Registers a menu entry not bound to any entity — for project-wide tools.
   * Call it at module scope. Returns an unregister function.
   */
  export function registerMenuItem(
    path: string,
    run: () => void,
    options?: { id?: string; order?: number },
  ): () => void;
}
