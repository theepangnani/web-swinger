# Character models

Drop a rigged character here as **`player.glb`** and the game uses it instead
of the built-in procedural rig, with real skeletal animation.

```
public/models/player.glb
```

Nothing else to configure. If the file is absent the game falls back to the
procedural character silently — that is the normal case.

## Why this exists

The built-in character is assembled from about thirty spheres and capsules.
It can be given correct proportions, colour zones and materials, but it will
never look like a sculpted mesh, because it isn't one. Loading a real model is
the only way to close that gap.

## What the loader expects

- **Format:** `.glb` (preferred) or `.gltf`. Both are standard glTF 2.0.
- **Scale:** anything. The model is measured and rescaled to 1.95 m, and its
  feet are dropped onto the physics capsule's base.
- **Facing:** the model should face **+Z**, the glTF convention.
- **Rig:** any skeleton. For the web line to fire from the hand, name a bone
  containing `hand` plus a right-side marker (`Right`, `_R`, `.R`, `R_`) —
  Mixamo's `mixamorigRightHand` matches automatically. Without one the web
  fires from a point near the chest.

## Animation clips

Clips are matched by **substring, case-insensitively**, so most exports work
untouched. First match wins:

| Used for | Clip name contains |
| --- | --- |
| Standing still | `idle`, `breathing`, `stand` |
| Running | `run`, `sprint`, `jog` |
| Airborne | `fall`, `falling`, `air`, `jump` |
| Swinging / gliding | `swing`, `flying`, `fly`, `glide` |
| Melee and web strike | `punch`, `attack`, `kick`, `strike` |
| Wall crawl / wall run | `crawl`, `climb` |
| Dodge | `roll`, `dodge`, `dive` |

Anything unmatched falls back to the idle clip. The run clip's playback rate
is scaled by actual ground speed so the feet don't slide.

A model with no animations at all still works — it just won't move its limbs.

## Where to get models you're allowed to use

You need something **licensed for reuse**. Ripped game assets are not, however
easy they are to find.

- **[Mixamo](https://mixamo.com)** — free rigged characters, and a large
  animation library you can retarget onto your own model. Free for commercial
  use with an Adobe account.
- **[Quaternius](https://quaternius.com)** — CC0 (public domain) rigged
  characters, animations included.
- **[Kenney](https://kenney.nl/assets)** — CC0 game assets.
- **[Sketchfab](https://sketchfab.com/search?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b)**
  — filter to CC0 / CC-BY and check the licence on each model.
- **[Poly Haven](https://polyhaven.com)** — CC0, though mostly environment art.

A good workflow: take a CC0 humanoid, upload it to Mixamo, apply the clips you
need (idle, run, falling, punch), download as `.glb`, rename to `player.glb`.

## Suits

Suit colours don't apply to a loaded model — it carries its own materials.
The skin picker still changes the hero name and abilities.
