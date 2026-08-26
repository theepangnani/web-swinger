# Recorded voice lines (optional)

The game speaks every bark through the browser's built-in speech synthesiser.
That works offline with no assets, and each character gets its own installed
voice plus its own pitch and pace — but it is still a synthesiser, and it
sounds like one.

This folder is the escape hatch. Drop real audio files here with a manifest and
every line that has a recording plays the recording instead. Anything you do
not record falls back to synthesis, so a partial pack is completely fine —
record the villains first if you only do some.

## The easy way: generate the whole pack, free and offline

```
node scripts/make-voices.mjs --list     # what to download
node scripts/make-voices.mjs            # render everything
```

That script drives **[Piper](https://github.com/rhasspy/piper)** — MIT
licensed, runs entirely on your own machine, no account, no API key, no
per-character cost, and a large catalogue of English voices that sound like
people. It reads the lines straight out of `src/audio/Voice.ts`, gives each
character a different voice, applies that character's pitch and pace, and
writes both the audio and `manifest.json` for you.

You need two downloads first, both free:

1. **The Piper binary** — <https://github.com/rhasspy/piper/releases> —
   unpacked into `tools/piper/`.
2. **Voice models** — <https://huggingface.co/rhasspy/piper-voices> — the
   `.onnx` and `.onnx.json` pair for each voice, into `tools/piper/voices/`.
   Run `--list` to see exactly which ones and whether they are present.

**ffmpeg** is optional but worth having: it is what drops Venom and Sandman
into their register rather than leaving every villain at the same pitch.

Re-running only renders lines that are missing, so adding a line to
`Voice.ts` costs one render rather than the whole pack.

## The manual way

1. Render the lines to audio (`.mp3`, `.ogg` and `.wav` all work). Any
   text-to-speech service will do, or record them yourself.
2. Put the files anywhere under `public/voice/`.
3. Create `public/voice/manifest.json`:

```json
{
  "PETER": {
    "swing_start": ["peter/swing-1.mp3", "peter/swing-2.mp3", "peter/swing-3.mp3"],
    "hurt":        ["peter/hurt-1.mp3"]
  },
  "MILES": {
    "swing_start": ["miles/swing-1.mp3"]
  },
  "VENOM": {
    "idle": ["venom/taunt-1.mp3", "venom/taunt-2.mp3"]
  }
}
```

The game finds the manifest at boot and shows "Recorded voice pack loaded."
No rebuild is needed — `public/` is served as-is.

## Speaker keys

Exactly as they appear in the subtitle:

`PETER` · `MILES` · `VENOM` · `BLACK CAT` · `ELECTRO` · `GREEN GOBLIN` ·
`SANDMAN` · `SYMBIOTE PETER`

The campaign's written scenes add speakers who never throw a punch. They only
ever have a `story` bank:

`MJ` · `MAY` · `YURI` · `JAMESON` · `GANKE` · `RIO` · `DANIKA`

## Event keys

Hero events — used for `PETER` and `MILES`:

| Key | When it fires |
| --- | --- |
| `swing_start` | starting a swing |
| `swing_chain` | several swings in a row |
| `high_speed` | above 78 m/s |
| `big_fall` | falling fast with no line out |
| `hard_landing` | heavy touchdown |
| `wall_crawl` | grabbing a wall |
| `strike_hit` | a hit connects |
| `combo` | 3+ combo |
| `villain_down` | an enemy goes down |
| `hurt` | taking damage |
| `low_health` | below 30% health |
| `ability` | Symbiote Surge / Venom Blast |
| `swap` | swapping hero |
| `all_clear` | city cleared |
| `idle` | nothing has happened for a while |
| `ally_join` | the partner arrives |
| `ally_engage` | the partner breaks off to fight |
| `ally_downed` | the partner goes down |
| `ally_revived` | the partner gets back up |
| `ally_kill` | the partner finishes someone |
| `ally_banter` | partner small talk |
| `ally_ability` | the partner uses their signature move |

The `ally_*` lines are spoken by whichever hero is fighting *alongside* you, so
record them for both PETER and MILES.

**All villain taunts live under the single key `idle`.** Put as many lines in
that array as you like.

### `story`

Every speaker also has a `story` bank: the scripted campaign dialogue from
`src/game/Story.ts` — chapter openings, halfway lines, closings, boss arrivals
and defeats, the police radio and the Bugle. It is the largest bank by a wide
margin and the one worth recording first, because those lines are authored for
an exact moment rather than fired at random.

Lines written for whichever hero you are playing appear in **both** the `PETER`
and `MILES` story banks, at the same index in each. Record them for both, or
one hero plays the scene in silence.

## How lines are picked

The game chooses a line index first and then looks for a recording at that
index, so the audio always matches the subtitle on screen. If a speaker has
four written lines and you supply two files, indices wrap — so supply the same
number of files as there are lines, or accept that some repeat.

The written lines themselves are in `src/audio/Voice.ts`, in the `PETER`,
`MILES` and `TAUNTS` tables, and in `src/game/Story.ts` for everything under
`story`. `VOICE_LINES` exports all of them in exactly the order the manifest
indexes, which is why `scripts/make-voices.mjs` reads that export rather than
keeping its own copy of the script.

## Notes

- Keep clips short. Barks are frequent and only one plays at a time; a new
  line cuts off the previous one.
- Volume follows the in-game **Bark volume** setting.
- Nothing here is committed by default — the folder is empty apart from this
  file, and its absence is the normal case.
