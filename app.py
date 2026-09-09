"""
yapmap -- turn the yap into a map.

Paste a YouTube link, get back a canvas: an interactive mindmap, a summary,
a wall of sticky notes, real-world next moves, and timestamped receipts you
can tick and download.

Flask backend: fetches the transcript, shells out to the Claude Code CLI
(authenticated with your Claude subscription -- no API key, no per-token
billing), and hands the frontend a structured canvas.

One-time setup:
    npm install -g @anthropic-ai/claude-code
    claude auth login          # sign in with your Claude subscription
    claude auth status         # confirm it shows you as logged in

Run:
    pip install -r requirements.txt
    python app.py
Then open http://localhost:5000
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from flask import Flask, jsonify, render_template, request
import requests

from youtube_transcript_api import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
    YouTubeTranscriptApi,
)
from youtube_transcript_api._errors import CouldNotRetrieveTranscript

app = Flask(__name__)

ytt_api = YouTubeTranscriptApi()

# The Claude Code CLI binary. Override with an env var if it isn't on PATH
# under this name (or point it at a full path to claude.cmd on Windows).
CLAUDE_BIN = os.getenv("CLAUDE_BIN", "claude")

# Sonnet by default: this job is structured extraction over a long transcript,
# not deep reasoning, and it's noticeably faster than Opus for the same result.
# Override with an alias ("opus", "haiku") or a full model name.
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "sonnet")

# One canvas is a bigger ask than a plain outline, so give it room.
CLAUDE_TIMEOUT_SECONDS = int(os.getenv("CLAUDE_TIMEOUT_SECONDS", "420"))

# Preferred transcript languages, in order. If none are available we fall
# back to whatever language the video actually has.
PREFERRED_LANGUAGES = ["en", "en-US", "en-GB"]

# Safety cap so a multi-hour video doesn't blow up the prompt. ~120k chars
# is roughly 30k tokens, comfortably inside context for any current Claude
# model while still covering a very long video.
MAX_TRANSCRIPT_CHARS = 120_000

# Generated canvases are cached on disk by video id. Subscription usage
# limits are a real budget, so re-opening a video you've already done costs
# nothing. Pass {"force": true} to regenerate.
CACHE_DIR = Path(os.getenv("YAPMAP_CACHE_DIR", ".cache"))

# Content modes the frontend knows how to style. Claude picks one; anything
# unrecognised falls back to "study".
KNOWN_MODES = {"study", "yap", "howto", "verdict", "story"}
DEFAULT_MODE = "study"

VIDEO_ID_PATTERNS = [
    re.compile(r"(?:youtube\.com/watch\?.*[?&]v=|youtube\.com/watch\?v=)([0-9A-Za-z_-]{11})"),
    re.compile(r"youtu\.be/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/embed/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/shorts/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/live/([0-9A-Za-z_-]{11})"),
]


def extract_video_id(url: str) -> str | None:
    for pattern in VIDEO_ID_PATTERNS:
        match = pattern.search(url)
        if match:
            return match.group(1)
    # A bare 11-char id pasted on its own.
    if re.fullmatch(r"[0-9A-Za-z_-]{11}", url.strip()):
        return url.strip()
    return None


def get_video_meta(video_id: str) -> tuple[str, str]:
    """Best-effort title/channel lookup via YouTube's public oEmbed endpoint (no API key needed)."""
    try:
        resp = requests.get(
            "https://www.youtube.com/oembed",
            params={
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "format": "json",
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("title") or "Untitled video", data.get("author_name") or ""
    except Exception:
        return "Untitled video", ""


def get_transcript(video_id: str) -> tuple[list[tuple[float, str]], str]:
    """
    Returns (snippets, language_label) where snippets is a list of
    (start_seconds, text). Prefers a manually-created English transcript,
    falls back to an auto-generated one, then to whatever language the video
    actually has.
    """
    transcript_list = ytt_api.list(video_id)

    transcript = None
    try:
        transcript = transcript_list.find_manually_created_transcript(PREFERRED_LANGUAGES)
    except NoTranscriptFound:
        pass

    if transcript is None:
        try:
            transcript = transcript_list.find_generated_transcript(PREFERRED_LANGUAGES)
        except NoTranscriptFound:
            pass

    if transcript is None:
        transcript = next(iter(transcript_list), None)

    if transcript is None:
        raise NoTranscriptFound(video_id, PREFERRED_LANGUAGES, transcript_list)

    fetched = transcript.fetch()
    snippets = [(float(s.start), s.text) for s in fetched]

    # YouTube already spells out "(auto-generated)" in the language name for
    # generated tracks, so only add it when it isn't there.
    label = transcript.language
    if transcript.is_generated and "auto-generated" not in label.lower():
        label += " (auto-generated)"
    return snippets, label


def format_timestamp(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def build_prompt_transcript(snippets: list[tuple[float, str]]) -> tuple[str, bool]:
    """
    Collapse raw caption snippets into ~220-char timestamped blocks. The
    timestamps are the whole point: they're what lets Claude cite a moment,
    and what lets the frontend seek the player to it.
    """
    blocks: list[str] = []
    buffer: list[str] = []
    buffer_start: float | None = None

    for start, text in snippets:
        text = text.strip()
        if not text:
            continue
        if buffer_start is None:
            buffer_start = start
        buffer.append(text)
        if sum(len(t) + 1 for t in buffer) >= 220:
            blocks.append(f"[{format_timestamp(buffer_start)}] " + " ".join(buffer))
            buffer, buffer_start = [], None

    if buffer and buffer_start is not None:
        blocks.append(f"[{format_timestamp(buffer_start)}] " + " ".join(buffer))

    joined = "\n".join(blocks)
    truncated = len(joined) > MAX_TRANSCRIPT_CHARS
    if truncated:
        joined = joined[:MAX_TRANSCRIPT_CHARS].rsplit("\n", 1)[0]
    return joined, truncated


# Kept out of the f-string below so its braces don't need escaping.
CANVAS_SCHEMA = """{
  "mode": "study | yap | howto | verdict | story",
  "mode_label": "2-3 word playful name for what kind of video this is",
  "headline": "a sharper version of the video's title, max 9 words",
  "tldr": "one punchy sentence -- what someone actually gets out of this video",
  "summary": ["3 to 5 paragraphs of plain prose, each 2-4 sentences"],
  "mindmap": "# Central topic\\n\\n## Section\\n- point\\n  - sub-point",
  "stickies_label": "2-3 word name for the pull-quote wall, fitted to this video",
  "stickies": [
    {"kind": "quote | aha | warning | stat | tip", "text": "6-25 words", "t": 128}
  ],
  "receipts_label": "2-3 word name for the key-findings list, fitted to this video",
  "receipts": [
    {"title": "4-9 words", "detail": "1-2 sentences of real substance", "t": 452}
  ],
  "moves": ["a concrete thing to go do offline after watching, 5-14 words"]
}"""


def build_canvas_prompt(title: str, channel: str, transcript: str, truncated: bool) -> str:
    truncation_note = (
        "NOTE: the transcript was truncated because the video is very long -- "
        "work with what you have and don't pretend to cover the rest.\n"
        if truncated
        else ""
    )
    return f"""You are turning a YouTube transcript into a study canvas: a mindmap, a summary, a wall of pull-quotes, and a list of key findings.

Video title: {title}
Channel: {channel or "unknown"}
{truncation_note}
The transcript is below. Every line starts with the timestamp it was spoken at, as [M:SS] or [H:MM:SS].

TRANSCRIPT
==========
{transcript}
==========

First decide the mode -- what kind of video this actually is:
- "study"   lectures, tutorials, courses, explainers, technical deep-dives
- "yap"     podcasts, interviews, panels, commentary, reactions
- "howto"   recipes, builds, repairs, walkthroughs, anything step-by-step
- "verdict" reviews, comparisons, rankings, buying guides
- "story"   documentaries, video essays, news, storytime, case studies

The mode decides what the "receipts" list should hold:
- study   -> the core concepts worth remembering, each with its one-line explanation
- yap     -> the actual claims and takes made, and who made them
- howto   -> the steps in order, each concrete enough to follow without the video
- verdict -> the specific pros, cons, and the final call
- story   -> the key events and facts, in the order they happened
Name that list yourself in "receipts_label" so it fits this video ("Core Concepts", "The Steps", "The Verdict", "What Happened", "Hot Takes"...).

Now output JSON matching this shape exactly:

{CANVAS_SCHEMA}

Rules:
- "mindmap" is a markdown outline: exactly one H1, then 4-10 H2 sections, then nested "-" bullets indented two spaces per level, 2 to 4 levels deep wherever the transcript actually has that much structure. Every node 3-10 words, never a full sentence. Don't pad shallow sections to look detailed.
- "stickies": 6 to 10 of them. These are the lines worth screenshotting -- a real quote, the moment something clicks, a warning, a number that lands. For kind "quote", stay close to what was actually said.
- "receipts": 6 to 12, ordered the way the video orders them. "detail" carries the actual substance -- someone who never watches the video should still learn something from it.
- "moves": 3 to 5 things to go do in the real world afterwards. Concrete and specific to this video, never "reflect on the content".
- Every "t" is an integer number of SECONDS, converted from the [timestamp] on the transcript line the item came from. [12:30] is 750. Get this right -- it is used to seek the video player.
- Base everything on what is actually said. Do not invent, assume, or generalise beyond the transcript.
- "mode_label", "stickies_label" and "receipts_label" can have personality. "summary", "receipts" and "mindmap" must stay accurate and useful -- they are what people came for.
- Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


def run_claude(prompt: str) -> str:
    # Resolve to a full path before handing it to subprocess. On Windows the
    # npm install is a `claude.cmd` shim, and CreateProcess only ever tries
    # appending .exe -- it doesn't walk PATHEXT the way shutil.which does --
    # so a bare "claude" dies with "[WinError 2] The system cannot find the
    # file specified" even though the CLI is installed and on PATH.
    claude_path = shutil.which(CLAUDE_BIN)
    if claude_path is None:
        raise RuntimeError(
            f"Couldn't find the Claude Code CLI ('{CLAUDE_BIN}') on your PATH. "
            "Install it with 'npm install -g @anthropic-ai/claude-code', then run "
            "'claude auth login' once to sign in with your Claude subscription."
        )

    cmd = [
        claude_path,
        "-p",
        "--tools",
        "",  # no tool access needed -- this is a pure text-in, text-out call
        "--no-session-persistence",
        "--output-format",
        "text",
    ]
    if CLAUDE_MODEL:
        cmd += ["--model", CLAUDE_MODEL]

    try:
        # The prompt goes over stdin, never as an argv element. Launching the
        # .cmd shim routes the command line through cmd.exe, which cuts it off
        # at the first newline -- silently sending Claude the instructions
        # without the transcript -- and would read quotes, & and %VAR% inside
        # transcript text as shell syntax.
        # encoding must be explicit. text=True alone decodes with the locale
        # codec, which is cp1252 on Windows -- every em dash Claude writes came
        # back as "a€"", and a non-English transcript would be mangled on the
        # way in as well.
        result = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=CLAUDE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"Claude didn't respond within {CLAUDE_TIMEOUT_SECONDS}s. Very long "
            "videos may need a higher CLAUDE_TIMEOUT_SECONDS."
        ) from exc

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise RuntimeError(f"Claude Code CLI failed: {detail}")

    return result.stdout.strip()


def extract_json(raw: str) -> dict:
    """Pull the JSON object out of a model response, fences and preamble and all."""
    text = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    text = re.sub(r"\s*```$", "", text)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("Claude didn't return JSON. Try regenerating.")
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Claude returned malformed JSON: {exc}") from exc


def as_seconds(value) -> int | None:
    """Timestamps come back as ints, floats, or the occasional '12:30' string."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return int(text)
        if re.fullmatch(r"\d{1,2}(:\d{2}){1,2}", text):
            total = 0
            for part in text.split(":"):
                total = total * 60 + int(part)
            return total
    return None


def as_text(value, limit: int = 400) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def normalize_canvas(data: dict, fallback_title: str) -> dict:
    """
    Guarantee every key the frontend reads, with the right type. A model that
    skips a field, or hands back a string where a list belongs, should degrade
    into a thinner canvas -- never a broken page.
    """
    mode = str(data.get("mode", "")).strip().lower()
    if mode not in KNOWN_MODES:
        mode = DEFAULT_MODE

    summary = data.get("summary")
    if isinstance(summary, str):
        summary = [p.strip() for p in summary.split("\n\n") if p.strip()]
    elif not isinstance(summary, list):
        summary = []
    summary = [as_text(p, 1200) for p in summary if as_text(p)]

    headline = as_text(data.get("headline"), 120) or fallback_title

    mindmap = str(data.get("mindmap") or "").strip()
    mindmap = re.sub(r"^```(?:markdown)?\s*", "", mindmap)
    mindmap = re.sub(r"\s*```$", "", mindmap).strip()
    if not mindmap.lstrip().startswith("#"):
        mindmap = f"# {headline}\n\n{mindmap}".strip()

    stickies = []
    for item in data.get("stickies") or []:
        if not isinstance(item, dict):
            item = {"text": item}
        text = as_text(item.get("text"), 240)
        if not text:
            continue
        kind = str(item.get("kind", "")).strip().lower()
        if kind not in {"quote", "aha", "warning", "stat", "tip"}:
            kind = "aha"
        stickies.append({"kind": kind, "text": text, "t": as_seconds(item.get("t"))})

    receipts = []
    for item in data.get("receipts") or []:
        if not isinstance(item, dict):
            item = {"title": item}
        title = as_text(item.get("title"), 160)
        if not title:
            continue
        receipts.append(
            {
                "title": title,
                "detail": as_text(item.get("detail"), 600),
                "t": as_seconds(item.get("t")),
            }
        )

    moves = []
    for item in data.get("moves") or []:
        text = as_text(item.get("text") if isinstance(item, dict) else item, 200)
        if text:
            moves.append(text)

    return {
        "mode": mode,
        "mode_label": as_text(data.get("mode_label"), 40) or "Deep Dive",
        "headline": headline,
        "tldr": as_text(data.get("tldr"), 300),
        "summary": summary,
        "mindmap": mindmap,
        "stickies_label": as_text(data.get("stickies_label"), 40) or "The Wall",
        "stickies": stickies,
        "receipts_label": as_text(data.get("receipts_label"), 40) or "Key Findings",
        "receipts": receipts,
        "moves": moves,
    }


def cache_path(video_id: str) -> Path:
    # Prompt changes should invalidate old canvases, so the schema and model
    # are part of the key rather than the video id alone.
    digest = hashlib.sha256((CANVAS_SCHEMA + (CLAUDE_MODEL or "")).encode()).hexdigest()[:8]
    return CACHE_DIR / f"{video_id}.{digest}.json"


def read_cache(video_id: str) -> dict | None:
    path = cache_path(video_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_cache(video_id: str, payload: dict) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_path(video_id).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass  # a cache that can't be written isn't worth failing a request over


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/canvas", methods=["POST"])
def api_canvas():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    force = bool(data.get("force"))

    if not url:
        return jsonify({"error": "Paste a YouTube link first."}), 400

    video_id = extract_video_id(url)
    if not video_id:
        return jsonify({"error": "That doesn't look like a YouTube link. Paste a normal one."}), 400

    if not force:
        cached = read_cache(video_id)
        if cached:
            cached["cached"] = True
            return jsonify(cached)

    try:
        snippets, language_label = get_transcript(video_id)
    except TranscriptsDisabled:
        return jsonify({"error": "Captions are switched off for this video, so there's no transcript to work with."}), 422
    except NoTranscriptFound:
        return jsonify({"error": "No transcript exists for this video."}), 422
    except VideoUnavailable:
        return jsonify({"error": "That video is unavailable -- private, deleted, or region-locked."}), 422
    except CouldNotRetrieveTranscript as exc:
        return jsonify({"error": f"Couldn't fetch the transcript: {exc}"}), 502
    except Exception as exc:  # noqa: BLE001 -- surface anything unexpected with context
        return jsonify({"error": f"Unexpected error fetching the transcript: {exc}"}), 500

    transcript, truncated = build_prompt_transcript(snippets)
    if not transcript.strip():
        return jsonify({"error": "The transcript for this video came back empty."}), 422

    title, channel = get_video_meta(video_id)
    duration = int(snippets[-1][0]) if snippets else 0

    try:
        raw = run_claude(build_canvas_prompt(title, channel, transcript, truncated))
        canvas = normalize_canvas(extract_json(raw), title)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Couldn't build the canvas: {exc}"}), 502

    if not canvas["receipts"] and not canvas["summary"]:
        return jsonify({"error": "Claude came back empty-handed. Try regenerating."}), 502

    payload = {
        **canvas,
        "video_id": video_id,
        "title": title,
        "channel": channel,
        "language": language_label,
        "duration": duration,
        "truncated": truncated,
        "cached": False,
    }
    write_cache(video_id, payload)
    return jsonify(payload)


if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("PORT", "5000")))
