# Web-Swinger

A 3D web-swinging game prototype. Vite + vanilla TypeScript + Three.js, with a
custom fixed-step Verlet physics loop instead of a rigid-body engine.

**Everything you can see is procedural.** There are no image, model or font
assets — building facades, road surfaces, spider emblems and the characters
themselves are generated from `<canvas>` 2D contexts and Three.js primitives at
runtime, and every sound effect is synthesised in WebAudio. The one exception is
the spoken dialogue in `public/voice/`, which is generated too, just ahead of
time rather than at load: see [Voices](#voices). The game works with no network
access after `npm install`.

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
npm test                # all eight, in parallel
npm test rematch        # just the suites whose filename matches
```

| Suite | What it protects |
| --- | --- |
| `static-checks.cjs` | Source-text invariants across every `.ts` file: DOM ids the HUD binds to, config keys that must exist, patterns that have regressed before. |
| `campaign.mjs` | Walks all 39 chapters. No chapter may be skipped, stall, or complete early. Includes the surplus-crime and legacy-save-migration cases. |
| `books.mjs` | Story shape: every book ends on a boss, difficulty climbs, the last book fields everyone. |
| `story.mjs` | Chapter dialogue: every beat reaches the player, none is written for a villain or partner who is not in the scene, and nothing addresses Miles on a night you could be Peter. Also checks the voice pack, when one is installed: a manifest entry with no file behind it drops that one line back to sounding synthesised while the lines around it do not. |
| `voice.mjs` | The clip layer, against a stubbed `Audio`: a clip that fails *after* dispatch still reaches the synthesis fallback, a known-bad clip stops being retried, and the element cache stays bounded. |
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
│   ├── Story.ts             Chapter dialogue, the radio, the scene director
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
│   ├── Voice.ts             Barks, story lines, per-speaker delivery
│   ├── VoiceClips.ts        Pre-rendered clip table
│   └── Sfx.ts               WebAudio-synthesised effects
├── fx/
│   ├── SpeedLines.ts        Additive screen-space streak overlay
│   └── Beacons.ts           Objective markers
└── ui/
    ├── HUD.ts               DOM overlay binding
    ├── Settings.ts          Persisted user settings
    ├── SettingsPanel.ts     Settings UI
    └── Tips.ts              First-time prompts, shown once each

tests/                       Verification suites (see Tests above)
scripts/
├── fetch-osm.py             Regenerates public/city/osm-city.json
├── make-voices-neural.mjs   Renders the voice pack (Edge neural / ElevenLabs)
├── edge-render.py           The edge-tts half of the above
└── make-voices.mjs          Older offline renderer, via Piper
```

### Voices

Every one of the 584 spoken lines is a real recording, in `public/voice/`,
rendered from Microsoft's neural voices with a distinct voice cast for each of
the fifteen speakers. `VoiceClips` finds the pack at boot and plays it;
`speechSynthesis` remains the fallback for anyone without it.

That fallback is the reason the pack exists. `Voice.ts` does what it can with
the browser synthesiser — a different installed voice per character, per-speaker
pitch and rate, per-line jitter, a procedural sub-bass bed under the monsters —
but no amount of shaping stops a synthesiser sounding synthesised, and with
fifteen speakers the sameness is what you notice first.

```bash
npm run voices                                        # render the pack
node scripts/make-voices-neural.mjs --list            # who plays whom
node scripts/make-voices-neural.mjs --only VENOM      # re-cut one character
node scripts/make-voices-neural.mjs --engine eleven --dry-run
```

Rendering is resumable: a clip already on disk is skipped, so adding a line to
the game costs one render rather than 584, and an interrupted run is finished by
running it again. Clips are written to a temporary name and moved into place, so
an interruption never leaves a truncated file that the next run skips as done.

The casting is character work, not correction. Jameson is fast because Jameson
is fast; May is slow because she is not in a hurry; Symbiote Peter is cast as
*Peter* and then dropped a fifth and slowed, because the whole point of that
fight is that the line reads as Peter until you notice what it is saying.

`--engine eleven` renders through ElevenLabs instead, which is better and is
metered — the full pack is 22,285 characters, so more than two months of the
free tier. It needs `ELEVENLABS_API_KEY`; the cast is taken from whatever voices
your account actually has, matched by name the same way `Voice.ts` divides up
the browser's installed voices. A key scoped to text-to-speech only cannot list
voices, and the script says so and tells you what to do about it.

Barks themselves are driven from state transitions in `Game.updateBarks`,
throttled by a global cooldown plus a per-event cooldown, and never repeat the
previous line. Every line is mirrored to an on-screen subtitle, so the whole
system degrades cleanly when audio is unavailable or muted (`M`).

### Losing

You used to be unable to. Dying restored full health, granted triple
invulnerability, moved you to the tallest building in the middle of the map and
told no other system it had happened — so every boss was a bucket you emptied
across as many lives as it took, and a player could lose a fight badly without
registering that anything had gone wrong.

Going down now costs three things. Everyone still standing recovers a third of
their health, which is what turns attrition back into a fight you can lose.
Whoever put you there says so. And the call you were on is lost. You come back a
couple of streets from where you fell rather than across the map, because the
punishment should be the fight you have to do again, not the flight back to it.

Relief is scoped to the villains actually in that fight — free roam has the
whole roster live at once, and handing health to six bosses across the city
because a mugger got lucky is not a difficulty curve.

### Crime

Street crime is the thing the campaign asks for around sixty times, and it used
to be one encounter: some thugs, kill them all, no clock, no way to do it badly.
There are four kinds now, rotated rather than rolled so a run of the same one is
impossible:

| Kind | Who | Clock | Worth |
| --- | --- | --- | --- |
| `MUGGING` | 2–4, mostly enforcers | 45s | 1.0× |
| `SHAKEDOWN` | 4–6, mixed | 60s | 1.15× |
| `HEIST` | 4–6, gunner-heavy | 70s | 1.5× |
| `AMBUSH` | 3–5, brutes | none | 1.35× |

The clock starts when you arrive, not when the crime spawns — running it from
the moment a crime exists would fail calls on the far side of the map that you
were never told about. Run out and the crew is gone: no experience, no progress
toward the chapter, and Watanabe says so. The time remaining is always in the
tracker, including during boss chapters, where crimes still spawn and can still
be lost.

### Learning it

There are about twenty verbs — swing, reel, zip, glide, wall-run, charge jump,
sprint, punch, dodge, finisher, gadget, heal, surge, swap — and the game's
entire explanation of them was a panel in the corner and a second panel hidden
behind `L`. A player who does not read the corner never learns that dodging
exists.

`Tips.ts` introduces each one at the first moment it becomes the useful thing to
do: the first villain teaches the dodge, the first time health runs low teaches
healing, the first unspent point teaches the skill menu. Each fires once, ever.
Seen prompts live in their own storage key rather than in the campaign save,
because they record what the *player* has learned, not what the character has
done — starting a new game should not re-explain the controls to somebody who
has been playing for an hour. Erasing the save brings them back.

### The story layer

`GameMode.ts` is structure — how many crimes, which boss, what time of day.
`Story.ts` is what the city says while you do it, and it runs over the same
subtitle and speech pipeline as the barks.

Every chapter has an **opening exchange**, a **halfway line** partway through
its street work, a **closing exchange**, and a written line for each boss
arriving and each boss going down. Beats are keyed by chapter *title*, so
reordering the books cannot silently detach dialogue from the chapter it was
written for; `tests/story.mjs` enforces that those titles stay unique and that
no beat is written for a villain or partner the chapter never fields.

Inside a fight, a villain speaks when it **turns** — the first time they drop
below half health — and again when **you** are nearly down, which is a story
beat and a read on the fight at the same time. Where two of them share a
rooftop they talk to **each other** a few seconds in. Each book gets a closing
scene of its own, and the post-game siege, which used to run in total silence,
gets one segment per wave.

Around the campaign sits **the radio**: Watanabe calling crimes in, Jameson
ranting, and May, MJ, Ganke, Rio and Danika filling genuine calm. Radio
segments are gated on how far through the books you are, so the city is never
overheard discussing something you have not reached. Underneath that run four
**side threads** — F.E.A.S.T., Danika's podcast, MJ's Osborn piece, Harlem —
which advance on cleared crime rather than on chapters, so they are the one
part of the story you can outrun by rushing the books.

Three rules keep it from becoming noise:

- **Scenes queue, they do not interrupt.** Beating the last villain of a
  chapter fires that villain going down, then the chapter closing, then the
  next chapter opening. Played at once, you would see only the third.
- **Written dialogue outranks everything.** `Voice.hold` suppresses barks for
  as long as a line is on screen, and a bark's `force` flag does not get past
  it — a boss taunt landing inside a closing exchange reads as a bug.
- **Ambient chatter yields.** The radio, the side threads and villain
  cross-talk are all dropped outright whenever anything else is waiting, and
  only speak when no fight is within `CONFIG.story.calmRadius`. A scene that is
  refused is retried rather than marked as played — latching on the attempt
  instead of the result throws it away every time, since the queue is busiest
  exactly when these want to speak.

Story lines are folded into `VOICE_LINES` as a `story` event, so
`scripts/make-voices.mjs` renders them into a clip pack exactly like barks —
and `Voice.line` is handed the line's index inside its speaker bank, which is
what keeps a recording matched to the subtitle it belongs to.

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
