"""
Build demo/ -- the data behind the GitHub Pages gallery.

The gallery is the same app with no server: it reads these files instead of
calling Flask. Only what's allowlisted below is exported, so nothing else in
your .cache/ -- your own canvases -- can end up public by accident.

Every demo video is Creative Commons Attribution (CC BY) licensed on YouTube;
the gallery credits each creator and links to the original. Run this after
regenerating any of them:

    python export_demo.py
"""

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import app as A

# (video id, one-line reason it's in the gallery) -- one per mode.
CANVASES = [
    ("O1kyPh1HyHI", "study: an explainer, so a cram deck"),
    ("WxyjDNVv5IY", "howto: a recipe, so a cook-along with timers"),
    ("PzjfZVyGr5Y", "verdict: a review, so a buy/skip card"),
    ("Ey8Iu-S5o90", "story: a documentary, so a timeline"),
    ("DzJt1moTk4Y", "yap: a podcast interview, so claims to check"),
]
BEEFS = [("y8bTzpWbYGY", "mEenkoGjtw8")]
PURGE = ["WxyjDNVv5IY", "NieQHjCHnxg", "Hs6GkiSq21g", "y8bTzpWbYGY",
         "1tO1_M3FySU", "SnLScjMaPhA", "brNGT1OGP6M", "JAtsoLAE2oM"]
LICENSE = "CC BY"

OUT = Path("demo")


def utc(value) -> str:
    """Timestamps go out in UTC, so the files don't carry your local timezone."""
    parsed = A.parse_iso(value)
    return (parsed or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")


def public(payload: dict) -> dict:
    clean = {k: v for k, v in payload.items() if k not in {"cached", "outdated"}}
    if "created_at" in clean:
        clean["created_at"] = utc(clean["created_at"])
    return clean


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)

    canvases = []
    for video_id, why in CANVASES:
        canvas = A.read_json(A.canvas_cache_path(video_id))
        if not isinstance(canvas, dict):
            raise SystemExit(f"{video_id} ({why}) has no current-schema canvas -- generate it first.")
        canvas = {**public(canvas), "license": LICENSE}
        write(OUT / "canvases" / f"{video_id}.json", canvas)
        canvases.append((video_id, canvas))

        for voice in A.VOICES:
            voiced = A.read_json(A.voice_cache_path(video_id, voice, canvas))
            if isinstance(voiced, dict):
                write(OUT / "voices" / f"{video_id}.{voice}.json", public(voiced))

    index = [
        {**A.library_item(vid, canvas, Path(".")), "outdated": False, "created_at": canvas["created_at"]}
        for vid, canvas in canvases
    ]
    write(OUT / "index.json", {"items": index})

    records = [
        {"video_id": vid, "headline": canvas.get("headline", ""), "mode": canvas.get("mode"), **rec}
        for vid, canvas in canvases
        for rec in A.canvas_records(canvas)
    ]
    write(OUT / "records.json", records)

    beef_index, beef_times = [], []
    for a, b in BEEFS:
        key = "__".join(sorted([a, b]))
        beef = A.read_json(A.beef_cache_path(key))
        if not isinstance(beef, dict):
            raise SystemExit(f"beef {a} vs {b} isn't cached -- run it first.")
        beef = public(beef)
        write(OUT / "beef" / f"{key}.json", beef)
        beef_index.append({"key": key, "a": beef["a"]["video_id"], "b": beef["b"]["video_id"],
                           "headline": beef.get("headline"), "topic": beef.get("topic")})
        beef_times.append(beef["created_at"])
    write(OUT / "beef" / "index.json", beef_index)

    purge_key = hashlib.sha256(",".join(PURGE).encode()).hexdigest()[:12]
    purge = A.read_json(A.purge_cache_path(purge_key))
    if not isinstance(purge, dict):
        raise SystemExit("the demo purge isn't cached -- run it first.")
    purge = public(purge)
    write(OUT / "purge.json", purge)

    stats = A.compute_stats(
        [(vid, canvas, canvas["created_at"]) for vid, canvas in canvases],
        [], [], beef_times, [purge["created_at"]],
    )
    write(OUT / "stats.json", stats)

    files = sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*.json"))
    print(f"demo/ written: {len(files)} files")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
