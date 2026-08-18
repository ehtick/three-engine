/**
 * The Character Controller's default visible body, as pure data: clip names,
 * the measured native height, the attribution text, and the hand-authored
 * locomotion graph.
 *
 * Split from `characterModel.js` the same way `characterRigSpec.js` is split
 * from `characterRig.js` — that file's `?url` import of the vendored GLB is
 * Vite-only syntax Node can't resolve, so `npm run test:level` (which drives
 * `AnimatorRuntime` against `CHARACTER_LOCOMOTION_ANIM` for real, headlessly)
 * would fail on the import alone if this lived together with it.
 *
 * ## The source: Mixamo's Y Bot, merged from four separate downloads
 *
 * Mixamo always splits a character from its animations — "Y Bot.fbx" carries
 * the mesh + skeleton (plus a throwaway default clip), and each of
 * "Idle.fbx" / "Running.fbx" / "Jumping Up.fbx" / "Jumping Down.fbx" carries
 * NO mesh, just that SAME skeleton (identical bone names/hierarchy — every
 * Mixamo download of one character shares one rig) and one clip apiece, all
 * named "mixamo.com" by Mixamo's own export convention. `scripts/merge-ybot-
 * clips.mjs` combines them once, offline: load each animation-only FBX,
 * rename its clip, and attach all four to Y Bot's own root — three's mixer
 * binds a track to a scene node BY NAME, not by originating file, so this
 * needs no retargeting math, only the rename (so the four clips don't all
 * collide under Mixamo's shared placeholder name). That script also fixes
 * Mixamo's centimetre export scale (root-level ×0.01) so the vendored file
 * reads as a sane ~1.8 m in any viewer, though `characterRig.js` would have
 * scaled it correctly either way — it MEASURES the native height rather than
 * assuming metres. Re-run that script and replace `assets/CharacterModel.glb`
 * if the source FBX files are ever swapped for a different Mixamo character.
 *
 * Mixamo itself has been unreachable for new downloads since ~2025-06 (its
 * login flow points at a URL Adobe retired) — vendoring the merged result is
 * what makes this survive that outage, the same reasoning that applied to the
 * previous Poly Pizza-sourced default.
 *
 * ## Why the animator is hand-authored, not the one the import pipeline made
 *
 * Importing a rigged GLB through the asset library (`unpackGlb`) generates a
 * `.anim` controller, but a flat one: one state per clip, no transitions, no
 * blending — a starting point for a human to wire up in the Animator panel,
 * not something a script can drive. `characterRig.js` runs that SAME unpack
 * pipeline (so the model gets the same `.geom`/`.mat`/skinned-mesh treatment
 * any GLB import gets) and then overwrites the generated stub with
 * `CHARACTER_LOCOMOTION_ANIM` below. See `docs/LEVEL_DESIGN.md` for the
 * graph's shape and its limits.
 */

/**
 * The clip names as authored in the merged GLB — pass-through constants so a
 * rename in one place doesn't require re-reading the file.
 */
export const CHARACTER_MODEL_CLIPS = {
  idle: "Idle",
  run: "Running",
  jumpUp: "JumpUp",
  jumpDown: "JumpDown",
};

/**
 * The model's own height in its bind pose, in metres — measured live
 * (`entity.getBounds` on a freshly instantiated copy, animation paused), not
 * assumed. `characterRig.js` divides the rig's authored capsule height by this
 * to get the uniform scale that makes the visible body match the collider,
 * whatever height/radius the rig was created with.
 */
export const CHARACTER_MODEL_HEIGHT = 1.8047344162463095;

export const CHARACTER_MODEL_ATTRIBUTION = `# Character

Source: Mixamo (Adobe) — character "Y Bot", animations "Idle", "Running",
"Jumping Up", "Jumping Down".

Mixamo characters and animations are free to use in any project under
Adobe's Mixamo license (see https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html
at the time this was vendored). That license permits using the content in
your own projects and games; it does not clearly permit redistributing the
raw asset files on a stand-alone basis for others to use as a development
resource. This file is vendored here for use within THIS engine checkout and
the projects built from it — if you intend to publish or redistribute the
ENGINE itself (not just games built with it) with this asset bundled by
default, re-check Mixamo's current terms before doing so.

Vendored rather than fetched at Character Controller creation time because
Mixamo's own upload/download flow has been broken since ~2025-06 (its login
redirects to a retired Adobe URL) — see scripts/merge-ybot-clips.mjs for how
the four separate Mixamo downloads were combined into one file.
`;

/**
 * A real locomotion state machine (`.anim` v2 — see `animGraph.js`), not the
 * flat per-clip stub `unpackGlb` would otherwise leave behind.
 *
 * "Locomotion" is a 1D blend tree over Idle / Running keyed on the `Speed`
 * parameter (metres/second — the same units `CharacterController.speed`
 * already reports, so the script passes it straight through with no
 * conversion). There is only one moving clip in this set — no separate walk
 * cycle — so Running is what plays across the controller's whole Walk→Sprint
 * range once `Speed` clears the threshold; retuning Walk/Sprint Speed in the
 * Inspector shifts where that blend-in happens, since the threshold is baked
 * into this asset and the speed is not.
 *
 * The jump is PAUSE-then-LAND, not a rise/fall pair keyed on velocity — an
 * earlier version tried splitting "JumpUp"/"JumpDown" on vertical speed
 * crossing zero and looping both so a long flight didn't freeze; the actual
 * complaint that produced was "JumpDown repeats through the whole jump",
 * because a fall commonly outlasts JumpDown's own 0.37s and looping a
 * LANDING-IMPACT clip mid-air looks like it keeps hitting the ground. The
 * fix is to stop trying to animate the fall at all:
 *
 *   Locomotion --(Grounded=false)--> JumpUp --(Grounded=true)--> JumpDown
 *                                                                    |
 *                                                     (clip finishes, blends)
 *                                                                    v
 *                                                              Locomotion
 *
 * "JumpUp" plays ONCE on leaving the ground and then PAUSES on its last frame
 * (`loop: false`, three's own `clampWhenFinished`) — a held launch/airborne
 * pose that covers however long the flight actually takes, rise AND fall
 * alike, instead of trying to represent a fall this pack has no clip for.
 * "JumpDown" is the landing IMPACT, entered only once `Grounded` goes back to
 * true, so it plays at the moment that makes sense for a clip named "jumping
 * down" — touching down — not stretched across an entire flight. It is also
 * one-shot, and safely so this time: it only ever needs to cover its own
 * fixed ~0.37s, not a variable-length fall, so there is nothing to loop away
 * from. Leaving JumpDown is exitTime-driven (no `Grounded`/`Speed` condition
 * at all) — once its clip finishes, it crossfades into whatever Locomotion
 * is doing at that moment, Idle or Running, which is the "blending with
 * further running" a landing recovery is supposed to do.
 *
 * The entry into JumpUp is `from: "__any__"` rather than `"state-locomotion"`
 * — a jump landed on and immediately re-triggered (bunny-hopping) should cut
 * to JumpUp again right away rather than waiting for JumpDown's crossfade to
 * finish first.
 */
export const CHARACTER_LOCOMOTION_ANIM = {
  version: 2,
  parameters: [
    { name: "Speed", type: "number", default: 0 },
    { name: "Grounded", type: "boolean", default: true },
  ],
  layers: [
    {
      id: "layer-base",
      name: "Base Layer",
      weight: 1,
      blend: "override",
      mask: null,
      states: [
        {
          id: "state-locomotion",
          name: "Locomotion",
          kind: "blend1d",
          blendParam: "Speed",
          syncTime: true,
          speed: 1,
          loop: true,
          x: 240,
          y: 140,
          children: [
            { clip: CHARACTER_MODEL_CLIPS.idle, threshold: 0, speed: 1 },
            { clip: CHARACTER_MODEL_CLIPS.run, threshold: 4.5, speed: 1 },
          ],
        },
        {
          id: "state-jumpup",
          name: "JumpUp",
          kind: "clip",
          clip: CHARACTER_MODEL_CLIPS.jumpUp,
          speed: 1,
          // Pauses on its last frame — see the class doc above. This holds
          // for the WHOLE flight, however long it actually takes.
          loop: false,
          x: 500,
          y: 60,
        },
        {
          id: "state-jumpdown",
          name: "JumpDown",
          kind: "clip",
          clip: CHARACTER_MODEL_CLIPS.jumpDown,
          speed: 1,
          // Safe to clamp: entered only at the landing instant, so it only
          // ever plays its own fixed ~0.37s, never a variable-length fall.
          loop: false,
          x: 500,
          y: 220,
        },
      ],
      startTransitions: [],
      transitions: [
        {
          id: "t-launch",
          from: "__any__",
          to: "state-jumpup",
          duration: 0.08,
          exitTime: null,
          conditions: [{ param: "Grounded", op: "==", value: false }],
        },
        {
          id: "t-land",
          from: "state-jumpup",
          to: "state-jumpdown",
          duration: 0.08,
          exitTime: null,
          conditions: [{ param: "Grounded", op: "==", value: true }],
        },
        {
          id: "t-recover",
          from: "state-jumpdown",
          to: "state-locomotion",
          duration: 0.2,
          // No conditions: this fires purely once JumpDown's own clip
          // finishes (see #conditionsPass — an empty `conditions` array
          // defaults `exitTime` to 1 on its own, spelled out here anyway so
          // the intent reads without having to know that default).
          exitTime: 1,
          conditions: [],
        },
      ],
    },
  ],
};
