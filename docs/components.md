# Components

Components are the serialized building blocks of an Engine scene. Attach them
to an entity with the editor or with `entity.addComponent(...)`. Every public
component has a matching TypeScript interface and class token in `engine.d.ts`.
For example:

```ts
import { MeshComponent } from "engine";

const mesh = entity.getComponent(MeshComponent);
mesh?.setProp("castShadow", true);
```

String lookups are typed too: `entity.getComponent("mesh")` resolves to
`MeshComponent | undefined`. Components supplied by an optional module remain
in the declaration map, but can only be attached after that module is enabled.

## Rendering and assets

| Type | Component | Purpose |
| --- | --- | --- |
| `mesh` | `MeshComponent` | Render geometry with authored material and shadow settings. |
| `model` | `ModelComponent` | Load a GLB/glTF model and expose its clips. |
| `skinnedmesh` | `SkinnedMeshComponent` | Import-created surface handle for an animated model. |
| `bone` | `BoneComponent` | Import-created attachment marker for a GLB bone. |
| `light` | `LightComponent` | Directional, point, spot, or ambient lighting. |
| `camera` | `CameraComponent` | The real render camera and virtual-camera blending brain. |
| `vcam` | `VirtualCameraComponent` | An authored camera shot with follow, aim, orbit, and priority. |
| `planar-reflection` | `PlanarReflectionComponent` | Exact flat-surface reflection for floors, pools, and mirrors. |
| `environment` | `EnvironmentComponent` | HDRI environment lighting and skybox. Requires `polyhaven`. |
| `objModel` | `ObjModelComponent` | AmbientCG OBJ/MTL model loader. Requires `ambientcg`. |
| `geometryModifiers` | `GeometryModifiersComponent` | Ordered, non-destructive modifier stack on a mesh. |
| `terrain` | `TerrainComponent` | Heightmap, splatmap, and scatter-painted terrain. Requires `terrain`. |
| `global-illumination` | `GlobalIlluminationComponent` | Radiance-cascade GI settings and runtime. Requires `gi`. |
| `postprocess` | `PostprocessComponent` | TSL screen-space post-processing graph on a camera. Requires `postprocessing`. |

## Effects and animation

| Type | Component | Purpose |
| --- | --- | --- |
| `animation` | `AnimationComponent` | Play and control a `.anim` state machine. |
| `timeline` | `TimelineComponent` | Play a `.timeline` sequence across scene entities. |
| `ik` | `IKComponent` | Two-bone inverse-kinematics correction for a model skeleton. |
| `particles` | `ParticleComponent` | Graph-driven particle emission and simulation. |
| `line` | `LineRendererComponent` | Render an authored line or polyline. |
| `trail` | `TrailRendererComponent` | Render a fading ribbon behind a moving entity. |
| `decal` | `DecalComponent` | Project a textured mark onto nearby geometry. |
| `impulsesource` | `ImpulseSourceComponent` | Authored source for camera shake impulses. |
| `spline` | `SplineComponent` | Editable local-space path with world-space queries. |
| `splineFollower` | `SplineFollowerComponent` | Move an entity along a spline. |
| `splineMesh` | `SplineMeshComponent` | Sweep a profile along a spline into render geometry. |

## Physics, navigation, and performance

| Type | Component | Purpose |
| --- | --- | --- |
| `rigidbody` | `RigidbodyComponent` | Rapier rigid body and velocity/force controls. Requires `physics-rapier`. |
| `collider` | `ColliderComponent` | Rapier collision shape and material settings. Requires `physics-rapier`. |
| `charactercontroller` | `CharacterControllerComponent` | Kinematic character movement and grounding. Requires `physics-rapier`. |
| `joint` | `JointComponent` | Rapier hinge, slider, spring, or fixed constraint. Requires `physics-rapier`. |
| `navmesh` | `NavMeshComponent` | Navigation mesh data and bake settings. Requires `navigation`. |
| `navagent` | `NavAgentComponent` | Pathfinding agent with avoidance. Requires `navigation`. |
| `navlink` | `NavLinkComponent` | Off-mesh jump, ladder, or drop connection. Requires `navigation`. |
| `lod` | `LodGroupComponent` | Select child levels from projected screen coverage. |
| `impostor` | `ImpostorComponent` | Octahedral billboard level for distant props. |
| `pool` | `PoolComponent` | Prewarm a prefab pool when play starts. |
| `instancer` | `InstancerComponent` | Hardware-instance repeated mesh/model geometry. |

## Audio, scripting, and UI

| Type | Component | Purpose |
| --- | --- | --- |
| `sound` | `SoundComponent` | Store and preview positional audio entries. |
| `listener` | `ListenerComponent` | Make an entity the active audio listener. |
| `script` | `ScriptComponent` | Attach one or more user script files. |
| `uiscreen` | `UiScreenComponent` | Root screen-space or world-space UI canvas. |
| `uielement` | `UiElementComponent` | Anchors, pivot, position, and size for UI layout. |
| `uiimage` | `UiImageComponent` | Styled UI rectangle, texture, border, and fill. |
| `uitext` | `UiTextComponent` | Raster or SDF UI text. |
| `uibutton` | `UiButtonComponent` | Pointer- and gamepad-interactive UI control. |
| `uilayout` | `UiLayoutComponent` | Flex-style row/column layout container. |
| `uiscroll` | `UiScrollComponent` | Clipped, wheel- and drag-scrollable viewport. |
| `uimask` | `UiMaskComponent` | Rectangular clip for descendant UI visuals. |

`BoneComponent` and `SkinnedMeshComponent` are import-only implementation
components. They are intentionally available in types for inspection and
lookup, but are normally created by the model importer rather than manually
added. The authoritative registered type strings are the `type` column above;
they are case-sensitive and match each component class's `static type`.
