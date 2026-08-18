/**
 * The Character Controller's two scripts, as source.
 *
 * They are written into the user's project rather than shipped as components,
 * and that is the point of the feature: a player controller is the one piece of
 * a game nobody's is the same. Every project changes the jump curve, adds a
 * dodge, swaps crouch for slide. Delivering it as a component would make all of
 * that a feature request; delivering it as ~250 lines of typed, commented
 * source in `scripts/` makes it an edit.
 *
 * The templates are strings here (not files copied at build time) so the editor
 * bundle carries them and a project can be seeded on any platform, including a
 * browser build with no filesystem to copy from.
 *
 * Both files are plain `.ts` against the engine's own typings: every field is
 * an `@attribute`, so the whole controller is tunable in the Inspector without
 * opening the code at all, and the code is there the moment tuning is not
 * enough.
 */

export const CHARACTER_CONTROLLER_FILE = "CharacterController.ts";
export const CHARACTER_CAMERA_FILE = "CharacterCamera.ts";

export const CHARACTER_CONTROLLER_SOURCE = `import { Script, attribute } from "engine";

/**
 * Ground movement for a player character.
 *
 * Drives the entity's Character Controller component (Rapier's kinematic
 * controller: it walks, climbs steps, slides along walls) from the Player
 * action map — Move / Jump / Sprint / Crouch, which are already bound to
 * WASD + gamepad + touch out of the box.
 *
 * Pairs with CharacterCamera on the same entity: the camera owns the yaw, and
 * this script asks it which way "forward" is. Neither needs the other to
 * exist, though — with no camera script the movement falls back to the active
 * camera's facing, so this works on a fixed-camera or top-down game too.
 *
 * Everything below is an Inspector field. The three worth knowing:
 *   - Ground/Air Accel are how *responsive* the character is, not how fast:
 *     lower is heavier. Set them very high for an arcade feel.
 *   - Coyote Time keeps a jump alive for a moment after walking off a ledge —
 *     the single change that makes platforming stop feeling unfair.
 *   - Jump Buffer remembers a jump pressed just before landing, so hammering
 *     the button while falling still jumps the instant you touch down.
 */
export default class CharacterController extends Script {
  @attribute({ type: "number", default: 4.5, min: 0, step: 0.1, label: "Walk Speed" })
  walkSpeed = 4.5;

  @attribute({ type: "number", default: 7.5, min: 0, step: 0.1, label: "Sprint Speed" })
  sprintSpeed = 7.5;

  @attribute({ type: "number", default: 2.2, min: 0, step: 0.1, label: "Crouch Speed" })
  crouchSpeed = 2.2;

  @attribute({ type: "number", default: 5.2, min: 0, step: 0.1, label: "Jump Speed" })
  jumpSpeed = 5.2;

  @attribute({ type: "number", default: 0, min: 0, max: 4, step: 1, label: "Air Jumps" })
  airJumps = 0;

  @attribute({ type: "number", default: 0.12, min: 0, max: 1, step: 0.01, label: "Coyote Time" })
  coyoteTime = 0.12;

  @attribute({ type: "number", default: 0.12, min: 0, max: 1, step: 0.01, label: "Jump Buffer" })
  jumpBuffer = 0.12;

  @attribute({ type: "number", default: 16, min: 0.1, step: 0.5, label: "Ground Accel" })
  groundAccel = 16;

  @attribute({ type: "number", default: 4, min: 0.1, step: 0.5, label: "Air Accel" })
  airAccel = 4;

  @attribute({ type: "number", default: 14, min: 0, step: 0.5, label: "Turn Speed" })
  turnSpeed = 14;

  /** "movement" turns the body the way you are going (third person);
   *  "camera" keeps it facing where you look (first person, aiming). */
  @attribute({ type: "select", default: "auto", options: ["auto", "movement", "camera"], label: "Body Facing" })
  facing = "auto";

  @attribute({ type: "boolean", default: true, label: "Can Sprint" })
  canSprint = true;

  @attribute({ type: "boolean", default: true, label: "Can Crouch" })
  canCrouch = true;

  /** Standing height is read on start; crouching resizes the capsule to this
   *  fraction of it and refuses to stand up under a ceiling. */
  @attribute({ type: "number", default: 0.55, min: 0.2, max: 1, step: 0.05, label: "Crouch Height" })
  crouchHeight = 0.55;

  @attribute({ type: "text", default: "Move", label: "Move Action" })
  moveAction = "Move";

  @attribute({ type: "text", default: "Jump", label: "Jump Action" })
  jumpAction = "Jump";

  @attribute({ type: "text", default: "Sprint", label: "Sprint Action" })
  sprintAction = "Sprint";

  @attribute({ type: "text", default: "Crouch", label: "Crouch Action" })
  crouchAction = "Crouch";

  // ---- runtime state (not authored) ----
  /** Horizontal velocity we are steering; the controller owns the vertical. */
  private vx = 0;
  private vz = 0;
  private sinceGrounded = 999;
  private sinceJumpPressed = 999;
  private jumpsUsed = 0;
  private standHeight = 1;
  private standRadius = 0.3;
  crouching = false;
  /** 1 while standing, the crouch fraction while crouched. The camera reads
   *  it to drop the eye line — a first-person crouch that does not lower the
   *  view is indistinguishable from no crouch at all. */
  stance = 1;
  /** True on the frame the character touched down — read it from another
   *  script for landing effects. */
  landed = false;
  grounded = false;
  speed = 0;
  private animator: any = null;

  onStart() {
    const cc = this.entity.getComponent("charactercontroller");
    if (!cc) {
      console.warn("CharacterController: no Character Controller component on " + this.entity.name);
      return;
    }
    this.standHeight = cc.props.height;
    this.standRadius = cc.props.radius;
    this.crouching = false;
    // The default body's Animation component lives on its own "Body" child,
    // not on this entity — found once rather than every frame. Stays null on
    // a rig using the plain capsule fallback (no body, nothing to drive), so
    // every call below is optional-chained.
    this.animator = this.entity.findComponents("animation")[0] ?? null;
  }

  onUpdate(dt: number) {
    const cc = this.entity.getComponent("charactercontroller");
    if (!cc || !this.input) return;

    const wasGrounded = this.grounded;
    this.grounded = cc.isGrounded();
    this.landed = this.grounded && !wasGrounded;
    this.sinceGrounded = this.grounded ? 0 : this.sinceGrounded + dt;
    if (this.grounded) this.jumpsUsed = 0;

    const move = this.readMove();
    const sprinting = this.canSprint && !this.crouching && this.input.isPressed(this.sprintAction);
    this.updateCrouch(cc);

    const target = this.crouching ? this.crouchSpeed : sprinting ? this.sprintSpeed : this.walkSpeed;
    const wantX = move.x * target;
    const wantZ = move.z * target;

    // Exponential approach, framerate independent: the same key held for the
    // same wall-clock time reaches the same speed at 30 fps and at 240.
    const accel = this.grounded ? this.groundAccel : this.airAccel;
    const t = 1 - Math.exp(-accel * dt);
    this.vx += (wantX - this.vx) * t;
    this.vz += (wantZ - this.vz) * t;
    this.speed = Math.hypot(this.vx, this.vz);

    cc.move([this.vx, 0, this.vz]);
    this.updateJump(cc, dt);
    this.updateFacing(move, dt);
    this.updateAnimator();
  }

  /** Feeds the default body's locomotion graph — Speed in m/s (the same units
   *  this.speed already is, so no conversion) and whether the controller is
   *  on the ground. See characterModelData.js for the states these drive:
   *  Grounded alone is enough now that the jump is pause-then-land rather
   *  than a rise/fall split, so there is no vertical-velocity parameter to
   *  feed. */
  private updateAnimator() {
    this.animator?.setNumber("Speed", this.speed);
    this.animator?.setBool("Grounded", this.grounded);
  }

  /** Movement intent in world XZ, length 0..1. */
  private readMove() {
    const input = this.input;
    if (!input) return { x: 0, z: 0 };
    const raw = input.readValue(this.moveAction) as { x: number; y: number };
    let x = raw && typeof raw === "object" ? raw.x : 0;
    let z = raw && typeof raw === "object" ? raw.y : 0;
    // The Player map's Move action is camera-space by default, in which case
    // the manager has already rotated it into world XZ. When it is world-space
    // (top-down games flip that switch) we do the rotation here instead, so
    // both settings drive the character the way the player expects.
    const action = input.getAction(this.moveAction);
    if (action && action.space !== "camera") {
      const yaw = this.viewYaw();
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const fx = -sin;
      const fz = -cos;
      const rx = cos;
      const rz = -sin;
      const sx = x;
      const sz = z;
      x = rx * sx + fx * sz;
      z = rz * sx + fz * sz;
    }
    const length = Math.hypot(x, z);
    if (length > 1) {
      x /= length;
      z /= length;
    }
    return { x, z };
  }

  private updateJump(cc: any, dt: number) {
    const input = this.input;
    if (!input) return;
    if (input.wasPressedThisFrame(this.jumpAction)) this.sinceJumpPressed = 0;
    else this.sinceJumpPressed += dt;

    const buffered = this.sinceJumpPressed <= this.jumpBuffer;
    if (!buffered || this.crouching) return;

    // Coyote time: a jump is still allowed for a moment after leaving the
    // ground, as long as we did not leave it BY jumping.
    if (this.grounded || (this.sinceGrounded <= this.coyoteTime && this.jumpsUsed === 0)) {
      cc.jump(this.jumpSpeed);
      // The controller only honours jump() while grounded, so a coyote jump
      // sets the velocity directly.
      if (!this.grounded) {
        const v = cc.getVelocity();
        cc.setVelocity([v[0], this.jumpSpeed, v[2]]);
      }
      this.jumpsUsed = 1;
      this.sinceJumpPressed = 999;
      this.sinceGrounded = 999;
    } else if (this.jumpsUsed <= this.airJumps && this.jumpsUsed > 0) {
      const v = cc.getVelocity();
      cc.setVelocity([v[0], this.jumpSpeed, v[2]]);
      this.jumpsUsed += 1;
      this.sinceJumpPressed = 999;
    }
  }

  private updateCrouch(cc: any) {
    if (!this.canCrouch || !this.input) return;
    const held = this.input.isPressed(this.crouchAction);
    if (held === this.crouching) return;

    const radius = this.standRadius;
    const crouched = this.standHeight * this.crouchHeight;
    if (held) {
      this.crouching = true;
      this.stance = this.crouchHeight;
      // The offset follows the height because the rig's origin is at the feet:
      // shrinking around a fixed centre would lift the character off the floor.
      cc.setCapsule({ height: crouched, offset: [0, crouched / 2 + radius, 0] });
      return;
    }
    // Standing up into a ceiling would push the capsule through it, so ask
    // physics first: a sphere the character's own girth, swept up through the
    // height we are about to regain. Sitting under a table has to keep you
    // there rather than teleporting you on top of it.
    const physics = this.engine.physics;
    const grow = this.standHeight - crouched;
    if (physics && grow > 0) {
      const origin = this.entity.getWorldPosition(new this.THREE.Vector3());
      origin.y += crouched + radius; // centre of the crouched capsule's top cap
      const blocked = physics.spherecast(origin, radius * 0.95, [0, 1, 0], grow + 0.05, {
        exclude: this.entity,
      });
      if (blocked) return; // still under something — stay down
    }
    this.crouching = false;
    this.stance = 1;
    cc.setCapsule({ height: this.standHeight, offset: [0, this.standHeight / 2 + radius, 0] });
  }

  /** Turns the body. In "camera" mode it matches where you look (first person
   *  and over-the-shoulder aiming); in "movement" mode it swings toward where
   *  you are going, which is what a third-person character does. */
  private updateFacing(move: { x: number; z: number }, dt: number) {
    const mode = this.facing === "auto" ? (this.cameraScript()?.view === "first" ? "camera" : "movement") : this.facing;
    const object = this.entity.object3D;
    let want: number;
    if (mode === "camera") {
      want = this.viewYaw();
    } else {
      if (Math.hypot(move.x, move.z) < 0.01) return;
      want = Math.atan2(-move.x, -move.z);
    }
    if (this.turnSpeed <= 0) {
      object.rotation.y = want;
      return;
    }
    // Shortest way round, then an exponential approach like the speed above.
    let delta = want - object.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    object.rotation.y += delta * (1 - Math.exp(-this.turnSpeed * dt));
  }

  /** The camera script on this entity, when there is one. */
  private cameraScript(): any {
    return this.entity.getScript("CharacterCamera") as any;
  }

  /** Yaw the player considers "forward": the camera script's, else the
   *  rendering camera's, else the body's own. */
  private viewYaw(): number {
    const camera = this.cameraScript();
    if (camera && typeof camera.yaw === "number") return camera.yaw;
    const active = this.engine.camera as any;
    if (active) {
      const direction = active.getWorldDirection(new this.THREE.Vector3());
      if (Math.abs(direction.x) + Math.abs(direction.z) > 1e-4) {
        return Math.atan2(-direction.x, -direction.z);
      }
    }
    return this.entity.object3D.rotation.y;
  }

  /** Teleports the character and clears the momentum it was carrying — use
   *  this for respawns and doors rather than writing the position directly,
   *  which the physics body would fight for a frame. */
  warpTo(x: number, y: number, z: number) {
    this.vx = 0;
    this.vz = 0;
    this.entity.getComponent("charactercontroller")?.teleport([x, y, z]);
    // A camera with follow damping turned up would otherwise fly across the
    // level to catch up, through everything in between.
    this.cameraScript()?.snap?.();
  }
}
`;

export const CHARACTER_CAMERA_SOURCE = `import { Script, attribute } from "engine";

/**
 * First- and third-person camera for a player character.
 *
 * Lives on the SAME entity as CharacterController and drives the first Camera
 * it finds in the entity's subtree — so the rig is just "Player → Camera" and
 * nothing has to be wired by hand.
 *
 * It owns the look angles. The character script reads "yaw" off this
 * instance, which is what keeps "forward" and "where the camera points" the
 * same thing in both views.
 *
 * Third person is a RIGID orbit: the camera sits "distance" behind a pivot at
 * the character's shoulder and is there the same frame the mouse moves. None
 * of the look is smoothed, and that is deliberate. An earlier version eased the
 * camera's final world position toward its target, which meant a flick of the
 * mouse turned the view instantly while the camera slid sideways into its new
 * orbit position for another tenth of a second — so the character swam across
 * the screen on every turn. Interpolating a camera's ORIENTATION and its
 * POSITION by different amounts is what makes a third-person camera feel wrong,
 * and the cheapest way to get both to agree is to smooth neither.
 *
 * Two things are still allowed to lag, and both are about the WORLD rather than
 * the mouse: "damping", off by default, trails the pivot when the character
 * moves; and the wall-avoidance distance, which snaps in and eases out. A
 * sphere cast pulls the camera in when a wall would be between it and the
 * player — the one piece of a follow camera that cannot be done with transforms
 * alone.
 */
export default class CharacterCamera extends Script {
  @attribute({ type: "select", default: "third", options: ["first", "third"], label: "View" })
  view = "third";

  @attribute({ type: "number", default: 2.4, min: 0.01, step: 0.1, label: "Sensitivity" })
  sensitivity = 2.4;

  @attribute({ type: "boolean", default: false, label: "Invert Y" })
  invertY = false;

  @attribute({ type: "number", default: -80, min: -89, max: 0, step: 1, label: "Min Pitch" })
  minPitch = -80;

  @attribute({ type: "number", default: 75, min: 0, max: 89, step: 1, label: "Max Pitch" })
  maxPitch = 75;

  /** First person: where the eyes are, measured from the entity origin. */
  @attribute({ type: "number", default: 1.6, min: 0, step: 0.05, label: "Eye Height" })
  eyeHeight = 1.6;

  /** Third person: the point the camera orbits, relative to the character. */
  @attribute({ type: "vec3", default: [0.4, 1.5, 0], label: "Shoulder Offset" })
  shoulder: [number, number, number] = [0.4, 1.5, 0];

  @attribute({ type: "number", default: 4, min: 0.1, step: 0.1, label: "Distance" })
  distance = 4;

  /**
   * Seconds of lag on the PIVOT while the character moves. 0 — the default —
   * is a rigid camera: the character holds still on screen and the world moves
   * past, which is what nearly every third-person game does.
   *
   * It never touches the orbit. Turning the camera is instant however high this
   * is: the mouse is an input, not an object with mass.
   */
  @attribute({ type: "number", default: 0, min: 0, max: 1, step: 0.01, label: "Follow Damping" })
  damping = 0;

  @attribute({ type: "boolean", default: true, label: "Avoid Walls" })
  avoidWalls = true;

  @attribute({ type: "number", default: 0.25, min: 0.01, step: 0.05, label: "Camera Radius" })
  cameraRadius = 0.25;

  /** Click the viewport to capture the mouse. Off for click-to-move or UI
   *  driven games, where a captured cursor is a nuisance. */
  @attribute({ type: "boolean", default: true, label: "Lock Cursor" })
  lockCursor = true;

  /** Action that flips first/third person. Empty disables the toggle — call
   *  "setView()" from your own code instead. */
  @attribute({ type: "text", default: "", label: "Toggle View Action" })
  toggleAction = "";

  @attribute({ type: "text", default: "Look", label: "Look Action" })
  lookAction = "Look";

  /** Extra FOV while sprinting, in degrees. 0 disables the kick. */
  @attribute({ type: "number", default: 6, min: 0, max: 40, step: 1, label: "Sprint FOV Kick" })
  sprintFov = 6;

  // ---- runtime state ----
  yaw = 0;
  pitch = 0;
  private cameraEntity: any = null;
  private baseFov = 0;
  private currentDistance = 0;
  /** The shoulder point the camera orbits. Identical to the character's own
   *  shoulder unless "damping" is turned up. */
  private pivot: any = null;
  private unlisten: (() => void) | null = null;

  onStart() {
    this.cameraEntity = this.findCamera();
    if (!this.cameraEntity) {
      console.warn("CharacterCamera: no Camera in " + this.entity.name + "'s children — add one.");
      return;
    }
    this.yaw = this.entity.object3D.rotation.y;
    this.currentDistance = this.distance;
    const camera = this.cameraEntity.getComponent("camera");
    this.baseFov = camera ? (camera.props.fov as number) : 60;

    if (this.lockCursor && this.input) {
      // Pointer lock is only granted from a user gesture, so it is requested
      // on the first click rather than here.
      const canvas = this.engine.renderer as any;
      const element = canvas && canvas.domElement ? canvas.domElement : null;
      const onClick = () => this.input?.requestPointerLock();
      element?.addEventListener("click", onClick);
      this.unlisten = () => element?.removeEventListener("click", onClick);
    }
  }

  onDestroy() {
    this.unlisten?.();
    this.unlisten = null;
    this.input?.exitPointerLock();
  }

  onUpdate(dt: number) {
    if (!this.cameraEntity) return;
    this.readLook();
    if (this.toggleAction && this.input?.wasPressedThisFrame(this.toggleAction)) {
      this.setView(this.view === "first" ? "third" : "first");
    }
    if (this.view === "first") this.applyFirstPerson();
    else this.applyThirdPerson(dt);
    this.applyFov(dt);
  }

  /** Switches view. Safe to call from a menu, a cutscene, or a pickup. */
  setView(view: string) {
    this.view = view === "first" ? "first" : "third";
  }

  private readLook() {
    if (!this.input) return;
    const look = this.input.readValue(this.lookAction) as { x: number; y: number };
    if (!look || typeof look !== "object") return;
    // Look is a per-frame DELTA (mouse movement / stick deflection), so it is
    // deliberately NOT scaled by dt — a mouse that moved 100 px turns the same
    // amount however long the frame took.
    this.yaw -= look.x * this.sensitivity * 0.01;
    this.pitch += (this.invertY ? look.y : -look.y) * this.sensitivity * 0.01;
    const min = (this.minPitch * Math.PI) / 180;
    const max = (this.maxPitch * Math.PI) / 180;
    this.pitch = Math.max(min, Math.min(max, this.pitch));
  }

  private applyFirstPerson() {
    const object = this.cameraEntity.object3D;
    const controller = this.entity.getScript("CharacterController") as any;
    const stance = controller && typeof controller.stance === "number" ? controller.stance : 1;
    object.position.set(0, this.eyeHeight * stance, 0);
    // The body is turned to the yaw by CharacterController, so the camera only
    // owns the pitch. Writing the yaw here too would double it.
    object.rotation.set(this.pitch, this.yaw - this.entity.object3D.rotation.y, 0, "YXZ");
  }

  private applyThirdPerson(dt: number) {
    const THREE = this.THREE;
    const object = this.cameraEntity.object3D;

    // The pivot is the only thing follow damping is allowed to touch. Damping
    // the camera's FINAL position instead lags the orbit, which is the one
    // thing that has to be exact — see the note on the class.
    const anchor = this.entity.getWorldPosition(new THREE.Vector3());
    const controller = this.entity.getScript("CharacterController") as any;
    const stance = controller && typeof controller.stance === "number" ? controller.stance : 1;
    anchor.y += this.shoulder[1] * stance;
    if (!this.pivot) this.pivot = anchor.clone();
    else if (this.damping > 0) this.pivot.lerp(anchor, 1 - Math.exp(-dt / this.damping));
    else this.pivot.copy(anchor);

    // The sideways (x) and forward (z) halves of the shoulder offset ride the
    // CAMERA's frame, not the body's, so an over-the-shoulder view does not
    // swing around when the character turns to run in a new direction. Applied
    // after the damping, so they track the mouse exactly.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const pivot = this.pivot.clone();
    pivot.x += cos * this.shoulder[0] - sin * this.shoulder[2];
    pivot.z += -sin * this.shoulder[0] - cos * this.shoulder[2];

    // Pivot → camera. The camera looks along -direction, so a positive pitch
    // (looking up) puts it BELOW the shoulder, hence the negated Y.
    const direction = new THREE.Vector3(
      sin * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      cos * Math.cos(this.pitch),
    );
    let wanted = this.distance;
    if (this.avoidWalls && this.engine.physics) {
      const hit = this.engine.physics.spherecast(pivot, this.cameraRadius, direction, this.distance, {
        exclude: this.entity,
      });
      if (hit) wanted = Math.max(0.1, hit.distance - this.cameraRadius * 0.5);
    }
    // Snapping IN and easing OUT: a camera that eases into a wall clips
    // through it for a few frames, while easing back out is invisible.
    this.currentDistance = wanted < this.currentDistance
      ? wanted
      : this.currentDistance + (wanted - this.currentDistance) * (1 - Math.exp(-6 * dt));

    // Placed from THIS frame's yaw and pitch, with nothing in between.
    const world = pivot.addScaledVector(direction, this.currentDistance);
    // The camera hangs off a body CharacterController turned a few lines ago,
    // so its placement is computed in world space and converted down. Both
    // conversions refresh the parent's matrix themselves, which matters: three
    // only recomputes world matrices at render time, and cancelling LAST
    // frame's body rotation out of THIS frame's camera is a wobble that appears
    // only while turning.
    const parent = object.parent;
    object.position.copy(parent ? parent.worldToLocal(world) : world);
    const worldQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"),
    );
    if (parent) {
      const parentQuaternion = parent.getWorldQuaternion(new THREE.Quaternion());
      worldQuaternion.premultiply(parentQuaternion.invert());
    }
    object.quaternion.copy(worldQuaternion);
  }

  /** Puts the camera where it belongs immediately, skipping any follow lag.
   *  Call it after a teleport — CharacterController.warpTo already does. */
  snap() {
    this.pivot = null;
    this.currentDistance = this.distance;
  }

  private applyFov(dt: number) {
    if (!this.sprintFov) return;
    const camera = this.cameraEntity.getComponent("camera");
    if (!camera) return;
    const controller = this.entity.getScript("CharacterController") as any;
    const sprinting = controller ? controller.speed > controller.walkSpeed + 0.1 : false;
    const want = this.baseFov + (sprinting ? this.sprintFov : 0);
    const current = camera.props.fov as number;
    const next = current + (want - current) * (1 - Math.exp(-8 * dt));
    // setProp is an EDITOR-FACING write: it fires "hierarchy-changed", which
    // the editor answers by re-mirroring every entity in the scene for React
    // and re-running the Inspector's fields — fine for a value that changes
    // occasionally, ruinous for one written every frame. The exponential above
    // never lands on "want" exactly, so an unguarded call here fires forever —
    // ~120 hierarchy-changed events a second for the rest of Play, at under a
    // hundredth of a degree of actual visual change each time. Reported as
    // "fps drops the moment we move" because the drop only bites once the
    // moving character is SELECTED (the Inspector then has a full page of
    // fields to reconcile) — a stationary, unselected character pays the same
    // storm invisibly. Guarded exactly like CameraComponent guards its own
    // per-frame pose write to camera.fov for the same reason.
    if (Math.abs(next - current) > 0.01) camera.setProp("fov", next);
  }

  /** First Camera component in this entity's subtree. */
  private findCamera(): any {
    const cameras = this.entity.findComponents("camera");
    return cameras.length ? cameras[0].entity : null;
  }
}
`;
