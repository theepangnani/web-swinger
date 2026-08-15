# Web-Swinger

A 3D web-swinging game prototype. Vite + vanilla TypeScript + Three.js, with a
custom fixed-step Verlet physics loop instead of a rigid-body engine.

**Everything is procedural.** There are no image, model, audio or font assets —
building facades, road surfaces, spider emblems and the characters themselves
are generated from `<canvas>` 2D contexts and Three.js primitives at runtime.
The game works with no network access after `npm install`.

## Running it

Requires **Node.js 20 or newer**. The test harness and `_bundle.mjs` use modern
syntax that Node 12–16 cannot parse; if you see `SyntaxError: Unexpected token
'?'`, you are on an old Node, not looking at a real error.

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

Other scripts:

```bash
npm run typecheck   # tsc --noEmit, strict mode
npm test            # the six verification suites (see Tests)
npm run verify      # typecheck + test, the pre-commit sweep
npm run build       # typecheck + production bundle into dist/
npm run preview     # serve the built bundle
```

### If `node` is not on PATH

This happens on Windows machines with more than one Node install. Check which
one you are actually getting before debugging anything else:

```bash
node --version      # must be >= 20
```

If the command is missing or reports an old version, invoke the right binary
directly rather than fighting the PATH — e.g. from Git Bash:

```bash
export PATH="/c/Users/<you>/nodejs:$PATH"
```

Tools can also be run without `npx`:

```bash
node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/vite/bin/vite.js build
```

## Tests

There is no test framework — no Jest, no Vitest, nothing to configure. Each
suite is a plain Node script that bundles the real TypeScript through esbuild
and asserts against it. Three.js builds geometry and materials without a GL
context, so most of the game is reachable from Node; the parts that genuinely
need WebGL get a stub from the test.

```bash
npm test                # all six, in parallel
npm test rematch        # just the suites whose filename matches
```

| Suite | What it protects |
| --- | --- |
| `static-checks.cjs` | Source-text invariants across every `.ts` file: DOM ids the HUD binds to, config keys that must exist, patterns that have regressed before. |
| `campaign.mjs` | Walks all 39 chapters. No chapter may be skipped, stall, or complete early. Includes the surplus-crime and legacy-save-migration cases. |
| `books.mjs` | Story shape: every book ends on a boss, difficulty climbs, the last book fields everyone. |
| `rematch.mjs` | A chapter can only ever field the villain it named — the boss-marathon regression. |
| `numeric.mjs` | The day/night clock keeps running past one cycle, and the world never goes pitch dark. |
| `joints.mjs` | Villain limb geometry sits exactly where it was authored. |

Several of these exist because of a specific bug and are written to fail if it
comes back. `rematch.mjs` and the chapter-credit block in `campaign.mjs` were
both confirmed by restoring the old behaviour and watching them fail — a
regression test that has never failed has not been shown to work.

## Controls

| Action | Keyboard / Mouse | Gamepad |
| --- | --- | --- |
| Move / air-steer | `W` `A` `S` `D` | Left stick |
| Look | Mouse | Right stick |
| Web swing | Hold `Space` | `R2` |
| Jump (grounded / on a wall) | `Space` | `R2` |
| Reel in / pay out (while swinging) | `W` / `S` or `↑` / `↓` | D-pad up / down |
| Shoot web / web-strike attack | Left click | `X` / `A` |
| Wall crawl | Hold `Shift` against a wall | `L1` |
| Special ability | `E` | `Y` / `Triangle` |
| Swap hero | `Q` | `Select` / `Share` |
| Mute spoken barks | `M` | — |

Click the canvas once to capture the pointer.

## Architecture

```
src/
├── main.ts                  Boot, WebGL probe, fatal-error reporting
├── Game.ts                  Orchestrator: renderer, lights, fixed-step loop
├── Camera.ts                Third-person chase camera
├── core/
│   ├── Config.ts            Every tunable value in the game
│   ├── Input.ts             Keyboard + mouse + gamepad → one action set
│   └── MathUtils.ts         clamp/lerp/damp, seeded PRNG
├── world/
│   ├── City.ts              Procedural grid + broadphase + collision
│   ├── Districts.ts         Per-district skyline character
│   ├── OsmData.ts           Optional real-map footprints (public/city)
│   ├── DayNight.ts          Keyframed sky/fog/sun/exposure over one clock
│   ├── Civilians.ts         Street crowd, stepped only near the player
│   └── Textures.ts          Canvas-generated facades, roofs, asphalt
├── player/
│   ├── Player.ts            Verlet body + movement state machine
│   ├── PlayerState.ts       Shared state enum
│   ├── PlayerModel.ts       Procedural rig, posed per state
│   ├── CharacterRig.ts      Shared skeleton the models are built on
│   ├── GltfCharacter.ts     Optional glTF character path
│   ├── Gadgets.ts           Web-bombs, tripwires and the rest
│   ├── WebRibbon.ts         Rope mesh
│   └── WebSystem.ts         Anchor search, pendulum constraint
├── enemies/
│   ├── EnemySystem.ts       The six villains, arenas, projectile pools
│   ├── VillainParts.ts      Procedural villain body builder
│   ├── VillainPose.ts       Per-villain posing and attack animation
│   ├── CombatTarget.ts      What the player can lock on to
│   ├── ThugSystem.ts        Street crime encounters
│   └── ThugModel.ts         Procedural thug body
├── game/
│   ├── GameMode.ts          Books, chapters, campaign progression
│   ├── SaveGame.ts          localStorage persistence + schema
│   ├── Progression.ts       XP, unlocks
│   ├── Heroes.ts            Peter / Miles definitions
│   ├── Suits.ts             Suit definitions and unlock rules
│   ├── SuitTextures.ts      Canvas-generated suit materials
│   ├── Ally.ts              Partner AI for team-up chapters
│   ├── Quests.ts            Objective tracker
│   ├── RimLight.ts          Character rim lighting
│   └── SpiderEmblem.ts      Shared canvas-drawn spider decal
├── audio/
│   ├── Voice.ts             Contextual barks via speechSynthesis
│   ├── VoiceClips.ts        Pre-rendered clip table
│   └── Sfx.ts               WebAudio-synthesised effects
├── fx/
│   ├── SpeedLines.ts        Additive screen-space streak overlay
│   └── Beacons.ts           Objective markers
└── ui/
    ├── HUD.ts               DOM overlay binding
    ├── Settings.ts          Persisted user settings
    └── SettingsPanel.ts     Settings UI

tests/                       Verification suites (see Tests above)
scripts/
├── fetch-osm.py             Regenerates public/city/osm-city.json
└── make-voices.mjs          Regenerates public/voice clips
```

### Voice barks

`Voice.ts` speaks contextual one-liners through the browser's built-in
`speechSynthesis` — no audio files, so the game stays asset-free. Peter and
Miles get different pitch and rate; villains are pitched down.

Every line is original writing. Lines are also mirrored to an on-screen
subtitle, so the system degrades cleanly when speech synthesis is unavailable
or muted (`M`).

Barks are driven from state transitions in `Game.updateBarks`, throttled by a
global cooldown plus a per-event cooldown, and never repeat the previous line.

### Physics

Simulation runs at a fixed **120 Hz** (`CONFIG.physics.fixedDt`) with an
accumulator; rendering interpolates between the last two physics states, so the
game behaves identically on a 60 Hz and a 165 Hz display.

The player is a single Verlet point mass:

```
x' = 2x − x_prev + a·dt²
```

Velocity is never stored as the source of truth — it is always derived from the
two positions. That is what makes the constraint solver work: the web, the
collision push-out and impulses all just *move `pos`*, and the velocity change
falls out of the integrator for free.

### The pendulum

`WebSystem.solve` runs each substep while a line is attached:

1. **Slack check.** If `|anchor − pos| < restLength`, the line applies nothing.
2. **Analytic tension**, from the design spec:
   `T = m·g·cos(θ) + m·v_tangential² / restLength`
   where `cos(θ)` is exactly the `y` component of the normalised player→anchor
   vector. Applied as an acceleration toward the anchor.
3. **Positional relaxation.** Pulling `pos` back onto the sphere of radius
   `restLength` implicitly cancels the *radial* component of the implied
   velocity while leaving the tangential component untouched — angular
   momentum conservation, without integrating a stiff spring.

`CONFIG.web.stiffness < 1` makes the line elastic rather than rigid.

### The city as a collision structure

Every building is an axis-aligned box, so the whole world is queried
analytically — no BVH, no `THREE.Raycaster`, no per-frame allocation:

- `City.raycast` — slab intersection over a uniform grid broadphase, used for
  web anchors, camera occlusion, Electro's line-of-sight and rooftop height
  probes.
- `City.collideSphere` — closest-point push-out against pooled contacts.

Buildings are merged into one geometry per facade variant (~6 draw calls for
400+ towers) with per-building UV repeats, so window density stays constant in
world space regardless of tower proportions.

## Tuning

`src/core/Config.ts` holds every gameplay constant, grouped by system. Useful
knobs:

| Setting | Effect |
| --- | --- |
| `physics.gravity` | 26 by default. Real 9.81 feels floaty at city scale. |
| `web.stiffness` | 1.0 = rigid line, lower = springier. |
| `web.aimSpread` / `aimUpBias` | How forgiving the auto-aim cone is. |
| `move.swingPump` | Energy added on the downswing. Set to 0 for pure physics. |
| `camera.fovMax` | How hard the FOV opens at speed. |
| `city.seed` | Regenerates the entire skyline deterministically. |

## Performance

The frame budget is dominated by fragment work and by the shadow pass, so the
tuning is aimed there:

- **The city is merged per spatial chunk, not globally.** One merged mesh for
  the whole city has a bounding sphere covering everything, so the frustum test
  can never reject it and all 400+ towers are submitted every frame. Chunking
  into 4×4-block tiles restores culling for a few more draw calls — by far the
  largest single win.
- **Pixel ratio is capped at 1.5.** At 2× on a high-DPI display you are shading
  four times the fragments. MSAA is disabled above 1.25 since it is redundant
  once supersampling.
- **Shadows** use a 1024 map, `PCFShadowMap` (not `PCFSoft`, which costs many
  more taps), and a 95 m follow radius that keeps distant towers out of the
  pass entirely. Roof props, streetlamps and tree canopies receive shadow but
  do not cast — instanced meshes render *every* instance in the shadow pass,
  with no per-instance culling.
- **No per-frame raycasts for AI.** Thugs and villains get ground height from
  a broadphase column lookup (`City.groundHeightAt`). Previously each thug ran
  a full city raycast every frame — up to 18 per frame.
- **Civilians are only stepped within 220 m** of the player.

An FPS readout sits in the hero panel; it turns amber below 55 and red below
45. If the rate stays under 45 for three consecutive seconds, `Game` also drops
shadows and pixel ratio automatically.

## Game feel

Two things do more for impact than any amount of animation:

- **Hitstop** — landing a hit freezes the simulation for 20–80 ms while
  rendering continues. Weight scales with the blow; the third hit of a combo
  and the finisher hold longest.
- **Camera shake** — applied *after* positional smoothing, so it is never
  damped away. Also fires on hard landings.

Landing crouch, idle breathing and air-trick spin are layered on top of the
active pose rather than replacing it.
