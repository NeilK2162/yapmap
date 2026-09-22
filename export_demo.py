"""
Build demo/ -- the data behind the GitHub Pages gallery.

The gallery is the same app with no server: it reads these files instead of
calling Flask. Only what's allowlisted below is exported, so nothing else in
your .cache/ -- your own canvases, questions and transcripts -- can end up
public by accident.

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
# Extra languages worth showing off, as (video id, language).
TRANSLATIONS = [("O1kyPh1HyHI", "hinglish")]
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
    clean = {k: v for k, v in payload.items() if k not in {"cached", "outdated", "langs"}}
    for key in ("created_at", "at"):
        if key in clean:
            clean[key] = utc(clean[key])
    return clean


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def current_canvas(video_id: str, lang: str = A.DEFAULT_LANG) -> dict:
    canvas = A.read_json(A.canvas_cache_path(video_id, lang))
    if not isinstance(canvas, dict):
        raise SystemExit(f"{video_id} ({lang}) has no current-schema canvas -- generate it first.")
    return canvas


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)

    canvases = []
    langs_by_video = {vid: ["en"] for vid, _ in CANVASES}
    for video_id, lang in TRANSLATIONS:
        translated = {**public(current_canvas(video_id, lang)), "license": LICENSE}
        write(OUT / "canvases" / f"{video_id}.{lang}.json", translated)
        langs_by_video[video_id].append(lang)

    for video_id, why in CANVASES:
        canvas = {**public(current_canvas(video_id)), "license": LICENSE}
        write(OUT / "canvases" / f"{video_id}.json", canvas)
        canvases.append((video_id, canvas))

        for voice in A.VOICES:
            voiced = A.read_json(A.voice_cache_path(video_id, voice, canvas))
            if isinstance(voiced, dict):
                write(OUT / "voices" / f"{video_id}.{voice}.json", public(voiced))

        # The transcript, as the same timestamped blocks the app serves.
        snippets = A.read_json(A.transcript_cache_path(video_id), {}).get("snippets")
        if not snippets:
            raise SystemExit(f"{video_id} has no cached transcript -- open its canvas in the app once first.")
        blocks = A.transcript_blocks([(float(s), str(t)) for s, t in snippets], size=180)
        write(OUT / "transcripts" / f"{video_id}.json", {
            "video_id": video_id,
            "blocks": [{"t": round(t, 1), "text": text} for t, text in blocks],
        })

        answers = [public(item) for item in A.load_ask_history(video_id)]
        if answers:
            write(OUT / "ask" / f"{video_id}.json", answers)

    index = [
        {**A.library_item(vid, canvas, Path(".")), "outdated": False, "created_at": canvas["created_at"],
         "langs": langs_by_video[vid]}
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
