"""
Renders a batch of lines through Microsoft's neural voices.

Driven by `make-voices-neural.mjs`, which owns the casting and the manifest —
this half only takes a job list and turns it into files. It exists as a
separate script because `edge-tts` is a Python library and paying its import
cost once for six hundred lines is the difference between a minute and twenty.

    python scripts/edge-render.py jobs.json

Each job is {text, voice, rate, pitch, out}. Anything already on disk is left
alone by the caller, so this only ever sees work that actually needs doing.
"""

import asyncio
import json
import os
import sys

try:
    import edge_tts
except ImportError:  # pragma: no cover - the caller checks first and explains
    print("edge-tts is not installed. pip install edge-tts", file=sys.stderr)
    raise SystemExit(2)

# Microsoft's endpoint is free and unmetered, which is not a reason to hammer
# it. Eight in flight keeps six hundred lines inside a minute.
CONCURRENCY = 8
ATTEMPTS = 3


async def render(job, semaphore, progress):
    async with semaphore:
        for attempt in range(1, ATTEMPTS + 1):
            try:
                speech = edge_tts.Communicate(
                    job["text"],
                    job["voice"],
                    rate=job.get("rate", "+0%"),
                    pitch=job.get("pitch", "+0Hz"),
                )
                os.makedirs(os.path.dirname(job["out"]), exist_ok=True)
                # Written to a temporary name and moved into place, so an
                # interrupted run never leaves a half-written clip that the
                # next run would skip as already rendered.
                partial = job["out"] + ".part"
                await speech.save(partial)
                os.replace(partial, job["out"])
                progress["done"] += 1
                done, total = progress["done"], progress["total"]
                print(f"\r  {done}/{total} rendered", end="", flush=True)
                return None
            except Exception as error:  # noqa: BLE001 - reported, not swallowed
                if attempt == ATTEMPTS:
                    progress["failed"] += 1
                    return f'{job["out"]}: {error}'
                await asyncio.sleep(attempt * 1.5)
        return None


async def main():
    if len(sys.argv) < 2:
        print("usage: edge-render.py <jobs.json>", file=sys.stderr)
        raise SystemExit(2)

    with open(sys.argv[1], encoding="utf-8") as handle:
        jobs = json.load(handle)

    if not jobs:
        print("  nothing to render")
        return

    progress = {"done": 0, "failed": 0, "total": len(jobs)}
    semaphore = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(render(job, semaphore, progress) for job in jobs))
    print()

    errors = [r for r in results if r]
    for error in errors[:10]:
        print(f"  FAILED {error}", file=sys.stderr)
    if len(errors) > 10:
        print(f"  ... and {len(errors) - 10} more", file=sys.stderr)
    # A non-zero exit is what stops the caller writing a manifest that points
    # at clips which were never produced.
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    asyncio.run(main())
