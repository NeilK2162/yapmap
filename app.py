"""
yapmap -- turn the yap into a map.

Paste a YouTube link, get back a canvas: an interactive mindmap, a tool built
for that kind of video (flashcards, a cook-along, a buy/skip card, claims to
check, or a timeline), a wall of sticky notes, the shelf of everything they
name-dropped, a summary you can re-voice, next moves you can commit to, and
timestamped receipts you can tick, download, or watch as a no-yap cut.

Around the canvas sit the other tools: beef mode (two videos, where they
clash), the purge (triage a pile of videos), a searchable library of
everything you've mapped, a follow-through tracker, and a monthly Wrapped.

Flask backend: fetches transcripts, shells out to the Claude Code CLI
(authenticated with your Claude subscription -- no API key, no per-token
billing), and hands the frontend structured JSON.

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
import threading
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, render_template, request
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

# ------------------------------------------------------------------ config

# The Claude Code CLI binary. Override with an env var if it isn't on PATH
# under this name (or point it at a full path to claude.cmd on Windows).
CLAUDE_BIN = os.getenv("CLAUDE_BIN", "claude")

# Sonnet by default: this job is structured extraction over a long transcript,
# not deep reasoning, and on a Pro plan it goes much further per usage limit
# than Opus. Override with an alias ("opus", "haiku") or a full model name.
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "sonnet")

# A full canvas, or a beef over two transcripts, is a big ask -- give it room.
CLAUDE_TIMEOUT_SECONDS = int(os.getenv("CLAUDE_TIMEOUT_SECONDS", "600"))

# Preferred transcript languages, in order. If none are available we fall
# back to whatever language the video actually has.
PREFERRED_LANGUAGES = ["en", "en-US", "en-GB"]

# Safety cap so a multi-hour video doesn't blow up the prompt. ~120k chars
# is roughly 30k tokens, comfortably inside context for any current Claude
# model while still covering a very long video.
MAX_TRANSCRIPT_CHARS = 120_000

# Beef puts two transcripts in one prompt, so each gets half the room.
BEEF_TRANSCRIPT_CHARS = 55_000

# The purge judges a pile of videos in one call from a slice of each: the
# start, the middle and the end. Twelve is where the prompt stays sane and
# YouTube stays happy with the transcript requests.
PURGE_MAX_VIDEOS = 12
PURGE_SAMPLE_CHARS = 6_000

# Generated output is cached on disk. Subscription usage limits are a real
# budget, so reopening anything you've already made costs nothing.
CACHE_DIR = Path(os.getenv("YAPMAP_CACHE_DIR", ".cache"))

# Things only you create -- commitments and activity for Wrapped -- live
# apart from the cache, so clearing the cache never wipes them.
DATA_DIR = Path(os.getenv("YAPMAP_DATA_DIR", ".yapmap"))
COMMITMENTS_FILE = DATA_DIR / "commitments.json"
EVENTS_FILE = DATA_DIR / "events.json"

# Bumped whenever the canvas gains fields. Canvases from an older version
# still open -- the page offers to regenerate them for the new sections.
SCHEMA_VERSION = 2

# Content modes the frontend knows how to style. Claude picks one; anything
# unrecognised falls back to "study".
KNOWN_MODES = {"study", "yap", "howto", "verdict", "story"}
DEFAULT_MODE = "study"

SHELF_KINDS = {"book", "tool", "person", "paper", "site", "other"}
EVENT_TYPES = {"storycard", "call", "cut"}
CALL_GRADES = {"nailed", "close", "off"}

VIDEO_ID_RE = re.compile(r"[0-9A-Za-z_-]{11}")

VIDEO_ID_PATTERNS = [
    re.compile(r"(?:youtube\.com/watch\?.*[?&]v=|youtube\.com/watch\?v=)([0-9A-Za-z_-]{11})"),
    re.compile(r"youtu\.be/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/embed/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/shorts/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/live/([0-9A-Za-z_-]{11})"),
]

# Each voice: (label shown in the UI, how Claude should rewrite the summary).
VOICES = {
    "groupchat": (
        "group chat",
        "Rewrite it as a group chat between two or three friends who just watched it, with "
        "short lowercase names like maya, dev and sam. 8 to 14 messages, one per line, each "
        "formatted exactly as 'name: message'. Casual and lowercase, the odd emoji.",
    ),
    "commentator": (
        "sports commentator",
        "Rewrite it as a breathless sports commentator calling the video like a cup final, "
        "play by play. 2 or 3 short paragraphs.",
    ),
    "brainrot": (
        "brainrot",
        "Rewrite it in full Gen Z brainrot: no cap, fr, lowkey, it's giving, aura, cooked, "
        "ate, rizz, delulu, the works. 2 or 3 short paragraphs. The slang changes; the facts don't.",
    ),
    "eli5": (
        "like i'm five",
        "Explain it to a five-year-old: short sentences, simple words, and one everyday "
        "comparison. 2 or 3 short paragraphs.",
    ),
}

_data_lock = threading.Lock()


# ------------------------------------------------------------------ helpers

def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")


def parse_iso(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def digest(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:8]


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, payload) -> bool:
    """Atomic write: a crash mid-write never leaves a half-file behind."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
        return True
    except OSError:
        return False


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


def as_list(value) -> list:
    return value if isinstance(value, list) else []


def error(message: str, status: int):
    return {"error": message}, status


# ------------------------------------------------------------------ youtube

def extract_video_id(url: str) -> str | None:
    for pattern in VIDEO_ID_PATTERNS:
        match = pattern.search(url)
        if match:
            return match.group(1)
    # A bare 11-char id pasted on its own.
    if VIDEO_ID_RE.fullmatch(url.strip()):
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


class TranscriptProblem(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def fetch_transcript(video_id: str) -> tuple[list[tuple[float, str]], str]:
    """get_transcript, with the library's exceptions turned into messages a person can act on."""
    try:
        return get_transcript(video_id)
    except TranscriptsDisabled as exc:
        raise TranscriptProblem("Captions are switched off for this video, so there's no transcript to work with.") from exc
    except NoTranscriptFound as exc:
        raise TranscriptProblem("No transcript exists for this video.") from exc
    except VideoUnavailable as exc:
        raise TranscriptProblem("That video is unavailable -- private, deleted, or region-locked.") from exc
    except CouldNotRetrieveTranscript as exc:
        raise TranscriptProblem(f"Couldn't fetch the transcript: {str(exc)[:400]}", 502) from exc
    except Exception as exc:  # noqa: BLE001 -- surface anything unexpected with context
        raise TranscriptProblem(f"Unexpected error fetching the transcript: {str(exc)[:400]}", 500) from exc


def format_timestamp(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def build_prompt_transcript(
    snippets: list[tuple[float, str]], max_chars: int = MAX_TRANSCRIPT_CHARS
) -> tuple[str, bool]:
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
    truncated = len(joined) > max_chars
    if truncated:
        joined = joined[:max_chars].rsplit("\n", 1)[0]
    return joined, truncated


def sample_transcript(snippets: list[tuple[float, str]], budget: int = PURGE_SAMPLE_CHARS) -> str:
    """The start, the middle and the end of a transcript -- enough to judge a video by."""
    full, _ = build_prompt_transcript(snippets, max_chars=10**9)
    if len(full) <= budget:
        return full
    lines = full.split("\n")

    def take(seq, limit):
        out, used = [], 0
        for line in seq:
            if used + len(line) + 1 > limit:
                break
            out.append(line)
            used += len(line) + 1
        return out

    head = take(lines, int(budget * 0.45))
    middle = take(lines[len(lines) // 2 :], int(budget * 0.30))
    tail = list(reversed(take(reversed(lines), int(budget * 0.25))))
    return "\n".join(head) + "\n[...]\n" + "\n".join(middle) + "\n[...]\n" + "\n".join(tail)


def duration_of(snippets: list[tuple[float, str]]) -> int:
    return int(snippets[-1][0]) if snippets else 0


# ------------------------------------------------------------------ claude

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
        #
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


def ask_claude(prompt: str) -> dict:
    data = extract_json(run_claude(prompt))
    if not isinstance(data, dict):
        raise RuntimeError("Claude returned JSON, but not an object. Try regenerating.")
    return data


# ------------------------------------------------------------------ canvas prompt

# Kept out of the f-strings below so their braces don't need escaping.
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
    {"title": "4-9 words", "detail": "1-2 sentences of real substance", "t": 452, "t_end": 497}
  ],
  "moves": ["a concrete thing to go do offline after watching, 5-14 words"],
  "shelf": [
    {"name": "the thing exactly as named", "kind": "book | tool | person | paper | site | other", "note": "why it came up, 4-12 words", "t": 301}
  ],
  "artifact": {"type": "...", "...": "the block for your mode, from the list above"}
}"""

ARTIFACT_SPECS = """- study   -> {"type": "flashcards", "cards": [{"q": "a question a student would be tested on, max 16 words", "a": "the answer as the video gives it, 1-2 sentences", "t": 610}]}
             6 to 10 cards, each testing something the video actually teaches.
- howto   -> {"type": "cookalong", "yields": "what you end up with, e.g. '4 servings' or 'one working shelf'", "ingredients": [{"item": "flour", "qty": "2 cups"}], "steps": [{"text": "one imperative step, max 22 words", "t": 95, "timer_seconds": 480}]}
             every ingredient, material and tool the video uses; 4 to 14 steps in order; "timer_seconds" only when the video states how long something takes, otherwise null.
- verdict -> {"type": "verdict", "product": "what is being judged", "call": "buy | wait | skip | depends", "call_line": "the reviewer's bottom line in one sentence", "for_who": ["who it suits, 3-10 words"], "skip_if": ["who should pass, 3-10 words"], "deal_breaker": {"text": "the single biggest reason to hesitate", "t": 812}, "pros": [{"text": "...", "t": 120}], "cons": [{"text": "...", "t": 400}]}
             2 to 5 of each list; "call" is the reviewer's call, not yours.
- yap     -> {"type": "claims", "claims": [{"claim": "one specific, checkable factual claim", "who": "who said it -- a name, or 'host' / 'guest'", "t": 1440, "check": "what you'd look up to verify it, max 14 words"}]}
             5 to 10 claims: facts, numbers, predictions and named events -- never opinions.
- story   -> {"type": "timeline", "events": [{"t": 60, "when": "the date or era if the video states one, else ''", "label": "4-8 words", "detail": "one sentence"}]}
             6 to 14 events, in the order the video covers them."""

MODE_TO_ARTIFACT = {
    "study": "flashcards",
    "howto": "cookalong",
    "verdict": "verdict",
    "yap": "claims",
    "story": "timeline",
}


def build_canvas_prompt(title: str, channel: str, transcript: str, truncated: bool) -> str:
    truncation_note = (
        "NOTE: the transcript was truncated because the video is very long -- "
        "work with what you have and don't pretend to cover the rest.\n"
        if truncated
        else ""
    )
    return f"""You are turning a YouTube transcript into a canvas: a mindmap, a wall of pull-quotes, key findings, a tool built for this kind of video, and the shelf of everything it names.

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

The mode decides what the "receipts" list should hold. It must complement the artifact below, never repeat it:
- study   -> the core concepts worth remembering, each with its one-line explanation
- yap     -> the big takes and arguments -- the opinions and the reasoning behind them, and who made them (checkable facts belong in the artifact's claims instead)
- howto   -> the techniques, tips and gotchas behind the steps -- the why, and the mistakes to avoid (the steps themselves belong in the artifact)
- verdict -> the evidence behind the call -- test results, measurements, specs and comparisons (the pros, cons and call belong in the artifact)
- story   -> the facts, figures and turning points worth remembering, and why each one mattered (the sequence of events belongs in the artifact)
Name that list yourself in "receipts_label" so it fits this video ("Core Concepts", "Hot Takes", "Pro Tips", "The Evidence", "Why It Mattered"...) -- never the same name as the artifact.

The mode also decides the "artifact" -- one extra tool built for this kind of video. Include exactly one: the block for your mode.
{ARTIFACT_SPECS}

Now output JSON matching this shape exactly:

{CANVAS_SCHEMA}

Rules:
- "mindmap" is a markdown outline: exactly one H1, then 4-10 H2 sections, then nested "-" bullets indented two spaces per level, 2 to 4 levels deep wherever the transcript actually has that much structure. Every node 3-10 words, never a full sentence. Don't pad shallow sections to look detailed.
- "stickies": 6 to 10 of them. These are the lines worth screenshotting -- a real quote, the moment something clicks, a warning, a number that lands. For kind "quote", stay close to what was actually said.
- "receipts": 6 to 12, ordered the way the video orders them. "detail" carries the actual substance -- someone who never watches the video should still learn something from it.
- "t_end" on each receipt is the second that point is finished being made: usually 20 to 90 seconds after "t", landing at the end of a sentence. These clips get stitched together into a cut-down version of the video, so each one must make sense on its own.
- "moves": 3 to 5 things to go do in the real world afterwards. Concrete and specific to this video, never "reflect on the content".
- "shelf": every book, tool, product, app, person, paper or website the video actually names, 0 to 15 of them, in the order they come up. Use the name as it was said. If nothing is named, return [].
- Every "t" is an integer number of SECONDS, converted from the [timestamp] on the transcript line the item came from. [12:30] is 750. Get this right -- it is used to seek the video player.
- Base everything on what is actually said. Do not invent, assume, or generalise beyond the transcript.
- "mode_label", "stickies_label" and "receipts_label" can have personality. Everything else must stay accurate and useful -- it is what people came for.
- Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


# Bump when the prompt's instructions change in a way that should retire
# cached canvases -- the schema text alone doesn't capture that.
CANVAS_PROMPT_VERSION = "2.1"

CANVAS_DIGEST = digest(CANVAS_SCHEMA, ARTIFACT_SPECS, CLAUDE_MODEL or "", CANVAS_PROMPT_VERSION)


# ------------------------------------------------------------------ canvas normalising

def normalize_artifact(raw) -> dict | None:
    """One mode-specific tool. Anything malformed becomes None, never a broken section."""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("type", "")).strip().lower()

    if kind == "flashcards":
        cards = []
        for card in as_list(raw.get("cards")):
            if not isinstance(card, dict):
                continue
            q, a = as_text(card.get("q"), 220), as_text(card.get("a"), 600)
            if q and a:
                cards.append({"q": q, "a": a, "t": as_seconds(card.get("t"))})
        return {"type": "flashcards", "cards": cards[:14]} if cards else None

    if kind == "cookalong":
        ingredients = []
        for item in as_list(raw.get("ingredients")):
            if isinstance(item, dict):
                name, qty = as_text(item.get("item"), 120), as_text(item.get("qty"), 60)
            else:
                name, qty = as_text(item, 120), ""
            if name:
                ingredients.append({"item": name, "qty": qty})
        steps = []
        for step in as_list(raw.get("steps")):
            if not isinstance(step, dict):
                step = {"text": step}
            text = as_text(step.get("text"), 300)
            if not text:
                continue
            timer = as_seconds(step.get("timer_seconds"))
            if timer is not None and not 1 <= timer <= 6 * 3600:
                timer = None
            steps.append({"text": text, "t": as_seconds(step.get("t")), "timer_seconds": timer})
        if not steps:
            return None
        return {
            "type": "cookalong",
            "yields": as_text(raw.get("yields"), 80),
            "ingredients": ingredients[:40],
            "steps": steps[:24],
        }

    if kind == "verdict":
        call = str(raw.get("call", "")).strip().lower()
        if call not in {"buy", "wait", "skip", "depends"}:
            call = "depends"

        def points(value):
            out = []
            for item in as_list(value):
                if not isinstance(item, dict):
                    item = {"text": item}
                text = as_text(item.get("text"), 240)
                if text:
                    out.append({"text": text, "t": as_seconds(item.get("t"))})
            return out[:8]

        breaker = raw.get("deal_breaker") if isinstance(raw.get("deal_breaker"), dict) else {}
        deal_breaker = None
        if as_text(breaker.get("text")):
            deal_breaker = {"text": as_text(breaker.get("text"), 300), "t": as_seconds(breaker.get("t"))}
        verdict = {
            "type": "verdict",
            "product": as_text(raw.get("product"), 120),
            "call": call,
            "call_line": as_text(raw.get("call_line"), 300),
            "for_who": [as_text(x, 120) for x in as_list(raw.get("for_who")) if as_text(x)][:6],
            "skip_if": [as_text(x, 120) for x in as_list(raw.get("skip_if")) if as_text(x)][:6],
            "deal_breaker": deal_breaker,
            "pros": points(raw.get("pros")),
            "cons": points(raw.get("cons")),
        }
        if not (verdict["call_line"] or verdict["pros"] or verdict["cons"]):
            return None
        return verdict

    if kind == "claims":
        claims = []
        for item in as_list(raw.get("claims")):
            if not isinstance(item, dict):
                item = {"claim": item}
            claim = as_text(item.get("claim"), 400)
            if claim:
                claims.append(
                    {
                        "claim": claim,
                        "who": as_text(item.get("who"), 60),
                        "t": as_seconds(item.get("t")),
                        "check": as_text(item.get("check"), 160),
                    }
                )
        return {"type": "claims", "claims": claims[:14]} if claims else None

    if kind == "timeline":
        events = []
        for item in as_list(raw.get("events")):
            if not isinstance(item, dict):
                continue
            label = as_text(item.get("label"), 120)
            if label:
                events.append(
                    {
                        "t": as_seconds(item.get("t")),
                        "when": as_text(item.get("when"), 60),
                        "label": label,
                        "detail": as_text(item.get("detail"), 400),
                    }
                )
        return {"type": "timeline", "events": events[:20]} if events else None

    return None


def normalize_canvas(data: dict, fallback_title: str) -> dict:
    """
    Guarantee every key the frontend reads, with the right type. A model that
    skips a field, or hands back a string where a list belongs, should degrade
    into a thinner canvas -- never a broken page. Safe to run twice.
    """
    mode = str(data.get("mode", "")).strip().lower()
    if mode not in KNOWN_MODES:
        mode = DEFAULT_MODE

    summary = data.get("summary")
    if isinstance(summary, str):
        summary = [p.strip() for p in summary.split("\n\n") if p.strip()]
    summary = [as_text(p, 1200) for p in as_list(summary) if as_text(p)]

    headline = as_text(data.get("headline"), 120) or fallback_title

    mindmap = str(data.get("mindmap") or "").strip()
    mindmap = re.sub(r"^```(?:markdown)?\s*", "", mindmap)
    mindmap = re.sub(r"\s*```$", "", mindmap).strip()
    if not mindmap.lstrip().startswith("#"):
        mindmap = f"# {headline}\n\n{mindmap}".strip()

    stickies = []
    for item in as_list(data.get("stickies")):
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
    for item in as_list(data.get("receipts")):
        if not isinstance(item, dict):
            item = {"title": item}
        title = as_text(item.get("title"), 160)
        if not title:
            continue
        t = as_seconds(item.get("t"))
        t_end = as_seconds(item.get("t_end"))
        if t_end is not None and (t is None or t_end <= t):
            t_end = None
        receipts.append({"title": title, "detail": as_text(item.get("detail"), 600), "t": t, "t_end": t_end})

    moves = []
    for item in as_list(data.get("moves")):
        text = as_text(item.get("text") if isinstance(item, dict) else item, 200)
        if text:
            moves.append(text)

    shelf, seen = [], set()
    for item in as_list(data.get("shelf")):
        if not isinstance(item, dict):
            item = {"name": item}
        name = as_text(item.get("name"), 120)
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        kind = str(item.get("kind", "")).strip().lower()
        if kind not in SHELF_KINDS:
            kind = "other"
        shelf.append({"name": name, "kind": kind, "note": as_text(item.get("note"), 200), "t": as_seconds(item.get("t"))})

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
        "shelf": shelf[:20],
        "artifact": normalize_artifact(data.get("artifact")),
        "schema_version": SCHEMA_VERSION,
    }


# ------------------------------------------------------------------ canvas cache

def canvas_cache_path(video_id: str) -> Path:
    # Prompt changes invalidate old canvases, so the schema and model are part
    # of the key rather than the video id alone.
    return CACHE_DIR / f"{video_id}.{CANVAS_DIGEST}.json"


def canvas_files_by_video() -> dict[str, Path]:
    """The newest cached canvas for every video, whichever schema made it."""
    newest: dict[str, Path] = {}
    if not CACHE_DIR.exists():
        return newest
    for path in CACHE_DIR.glob("*.json"):
        video_id = path.name.split(".")[0]
        if not VIDEO_ID_RE.fullmatch(video_id):
            continue
        if video_id not in newest or path.stat().st_mtime > newest[video_id].stat().st_mtime:
            newest[video_id] = path
    return newest


def load_cached_canvas(video_id: str) -> dict | None:
    """The current-schema canvas if there is one, otherwise the newest older one, marked outdated."""
    exact = read_json(canvas_cache_path(video_id))
    if isinstance(exact, dict):
        return {**exact, "cached": True, "outdated": False}

    path = canvas_files_by_video().get(video_id)
    legacy = read_json(path) if path else None
    if not isinstance(legacy, dict):
        return None
    payload = {**legacy, **normalize_canvas(legacy, legacy.get("title") or "Untitled video")}
    payload["schema_version"] = legacy.get("schema_version", 1)
    payload.setdefault("created_at", mtime_iso(path))
    payload.update(cached=True, outdated=payload["schema_version"] < SCHEMA_VERSION)
    return payload


def generate_canvas(video_id: str) -> dict:
    snippets, language_label = fetch_transcript(video_id)
    transcript, truncated = build_prompt_transcript(snippets)
    if not transcript.strip():
        raise TranscriptProblem("The transcript for this video came back empty.")

    title, channel = get_video_meta(video_id)
    canvas = normalize_canvas(ask_claude(build_canvas_prompt(title, channel, transcript, truncated)), title)
    if not canvas["receipts"] and not canvas["summary"]:
        raise RuntimeError("Claude came back empty-handed. Try regenerating.")

    payload = {
        **canvas,
        "video_id": video_id,
        "title": title,
        "channel": channel,
        "language": language_label,
        "duration": duration_of(snippets),
        "truncated": truncated,
        "created_at": now_iso(),
    }
    write_json(canvas_cache_path(video_id), payload)
    return {**payload, "cached": False, "outdated": False}


# ------------------------------------------------------------------ beef

BEEF_SCHEMA = """{
  "related": true,
  "topic": "what both videos are about, 3-8 words",
  "headline": "a punchy framing of the matchup, max 10 words",
  "verdict": "2-3 sentences: who makes the stronger case on what, grounded only in what is said",
  "clash": [
    {"topic": "3-7 words", "a": "what video A claims, one sentence", "t_a": 500, "b": "what video B claims, one sentence", "t_b": 210, "why": "why the difference matters, one sentence"}
  ],
  "agree": [{"point": "something both say, one sentence", "t_a": 120, "t_b": 340}],
  "only_a": [{"point": "something only video A covers", "t": 900}],
  "only_b": [{"point": "something only video B covers", "t": 45}]
}"""

BEEF_DIGEST = digest(BEEF_SCHEMA, CLAUDE_MODEL or "", "beef-v1")


def build_beef_prompt(a: dict, b: dict) -> str:
    notes = []
    if a["truncated"]:
        notes.append("Video A's transcript was cut short because it is very long.")
    if b["truncated"]:
        notes.append("Video B's transcript was cut short because it is very long.")
    return f"""You are comparing two YouTube videos for someone who wants to know where they agree and where they clash.

VIDEO A: {a["title"]} -- {a["channel"] or "unknown channel"}
VIDEO B: {b["title"]} -- {b["channel"] or "unknown channel"}
{" ".join(notes)}
Each transcript line starts with the timestamp it was spoken at in THAT video, as [M:SS] or [H:MM:SS].

TRANSCRIPT A
============
{a["transcript"]}
============

TRANSCRIPT B
============
{b["transcript"]}
============

Output JSON matching this shape exactly:

{BEEF_SCHEMA}

Rules:
- "clash" is the heart of it: 2 to 8 points where they genuinely disagree, contradict each other, or give incompatible advice -- specific, each side in its own terms. If they barely disagree, say so in "verdict" and keep "clash" short. Never invent a fight.
- "agree": 2 to 8. "only_a" and "only_b": 2 to 6 each.
- "t_a" is a timestamp in video A and "t_b" one in video B -- integer SECONDS from each video's own [timestamp]. [12:30] is 750.
- "related" is false only if the two videos are not about the same subject at all; then say so in "verdict" and keep the lists short.
- "verdict" must be fair and grounded in what is actually said, not in your own opinion of the topic.
- Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


def normalize_beef(data: dict) -> dict:
    def point_list(value, keys):
        out = []
        for item in as_list(value):
            if not isinstance(item, dict):
                continue
            point = as_text(item.get("point"), 400)
            if point:
                out.append({"point": point, **{k: as_seconds(item.get(k)) for k in keys}})
        return out[:10]

    clash = []
    for item in as_list(data.get("clash")):
        if not isinstance(item, dict):
            continue
        a_says, b_says = as_text(item.get("a"), 400), as_text(item.get("b"), 400)
        if a_says and b_says:
            clash.append(
                {
                    "topic": as_text(item.get("topic"), 90) or "the disagreement",
                    "a": a_says,
                    "t_a": as_seconds(item.get("t_a")),
                    "b": b_says,
                    "t_b": as_seconds(item.get("t_b")),
                    "why": as_text(item.get("why"), 300),
                }
            )
    return {
        "related": data.get("related") is not False,
        "topic": as_text(data.get("topic"), 90),
        "headline": as_text(data.get("headline"), 140),
        "verdict": as_text(data.get("verdict"), 900),
        "clash": clash[:10],
        "agree": point_list(data.get("agree"), ("t_a", "t_b")),
        "only_a": point_list(data.get("only_a"), ("t",)),
        "only_b": point_list(data.get("only_b"), ("t",)),
    }


def swap_beef(payload: dict) -> dict:
    """The same beef, seen from the other corner -- so A is always what the user put first."""
    return {
        **payload,
        "a": payload["b"],
        "b": payload["a"],
        "clash": [
            {**c, "a": c["b"], "t_a": c["t_b"], "b": c["a"], "t_b": c["t_a"]} for c in payload.get("clash", [])
        ],
        "agree": [{**p, "t_a": p.get("t_b"), "t_b": p.get("t_a")} for p in payload.get("agree", [])],
        "only_a": payload.get("only_b", []),
        "only_b": payload.get("only_a", []),
    }


def beef_cache_path(key: str) -> Path:
    return CACHE_DIR / "beef" / f"{key}.{BEEF_DIGEST}.json"


# ------------------------------------------------------------------ purge

PURGE_SCHEMA = """{
  "items": [
    {"n": 1, "verdict": "watch | skim | skip", "why": "one specific sentence -- name what is actually in it", "best_t": 754, "best_label": "what is at that moment, 3-8 words"}
  ],
  "summary_line": "one punchy line about the pile as a whole"
}"""

PURGE_DIGEST = digest(PURGE_SCHEMA, CLAUDE_MODEL or "", "purge-v1")


def build_purge_prompt(blocks: list[str]) -> str:
    videos = "\n\n".join(blocks)
    return f"""You are triaging someone's watch-later pile. For each video you get its title, channel and length, plus a sample of its transcript -- the start, the middle and the end -- with timestamps.

Decide honestly, for each one:
- "watch": dense, original, worth its full runtime
- "skim":  a few strong moments surrounded by filler -- worth jumping around in
- "skip":  thin, repetitive, clickbait, or a rehash -- nothing you'd miss

VIDEOS
======
{videos}
======

Output JSON matching this shape exactly:

{PURGE_SCHEMA}

Rules:
- Exactly one item per video, using its [n].
- "best_t" is the single best moment, as integer SECONDS from that video's sample timestamps ([12:30] is 750), or null for a skip.
- Don't be generous. A pile where everything is "watch" helps nobody.
- Judge only from what the samples actually contain.
- Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


def normalize_purge(data: dict) -> tuple[dict[int, dict], str]:
    by_n = {}
    for item in as_list(data.get("items")):
        if not isinstance(item, dict):
            continue
        n = as_seconds(item.get("n"))
        verdict = str(item.get("verdict", "")).strip().lower()
        if n is None or verdict not in {"watch", "skim", "skip"}:
            continue
        by_n[n] = {
            "verdict": verdict,
            "why": as_text(item.get("why"), 300),
            "best_t": as_seconds(item.get("best_t")),
            "best_label": as_text(item.get("best_label"), 90),
        }
    return by_n, as_text(data.get("summary_line"), 240)


class PurgeProblem(Exception):
    pass


def playlist_video_ids(url: str) -> list[str]:
    try:
        import yt_dlp  # optional: only needed to expand playlist links
    except ImportError as exc:
        raise PurgeProblem(
            "Playlist links need yt-dlp (pip install yt-dlp). Or paste the video links, one per line."
        ) from exc
    options = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True,
               "playlistend": PURGE_MAX_VIDEOS * 2}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise PurgeProblem(f"Couldn't read that playlist: {str(exc)[:200]}") from exc
    return [e["id"] for e in (info or {}).get("entries") or [] if e and VIDEO_ID_RE.fullmatch(str(e.get("id", "")))]


def expand_purge_input(raw) -> tuple[list[str], int]:
    """Links (one per line, or a list) and playlist links in; unique video ids out, capped."""
    tokens = raw if isinstance(raw, list) else re.split(r"[\s,]+", str(raw or ""))
    ids: list[str] = []
    for token in tokens:
        token = str(token).strip()
        if not token:
            continue
        if "list=" in token and "v=" not in token and "youtu.be/" not in token:
            found = playlist_video_ids(token)
        else:
            vid = extract_video_id(token)
            found = [vid] if vid else []
        for vid in found:
            if vid not in ids:
                ids.append(vid)
    return ids[:PURGE_MAX_VIDEOS], max(0, len(ids) - PURGE_MAX_VIDEOS)


def purge_cache_path(key: str) -> Path:
    return CACHE_DIR / "purge" / f"{key}.{PURGE_DIGEST}.json"


# ------------------------------------------------------------------ voices

def build_revoice_prompt(canvas: dict, voice: str) -> str:
    source = "\n\n".join([canvas.get("tldr") or "", *as_list(canvas.get("summary"))]).strip()
    return f"""Here is a summary of a YouTube video called "{canvas.get("headline") or canvas.get("title")}".

SUMMARY
=======
{source}
=======

{VOICES[voice][1]}

Every fact, name and number must stay accurate -- only the voice changes. Don't add anything the summary doesn't say.

Output JSON exactly like this: {{"lines": ["...", "..."]}} -- one entry per paragraph, or per message for a chat.
Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


def voice_cache_path(video_id: str, voice: str, canvas: dict) -> Path:
    source = "\n".join([canvas.get("tldr") or "", *as_list(canvas.get("summary"))])
    return CACHE_DIR / "voice" / f"{video_id}.{voice}.{digest(source, VOICES[voice][1], CLAUDE_MODEL or '')}.json"


# ------------------------------------------------------------------ library, search, stats

def canvas_records(canvas: dict) -> list[dict]:
    """Every searchable line in a canvas, with the second it points at where there is one."""
    records = []

    def add(field, text, t=None):
        text = as_text(text, 700)
        if text:
            records.append({"field": field, "text": text, "t": t if isinstance(t, int) else None})

    add("headline", canvas.get("headline"))
    add("tldr", canvas.get("tldr"))
    for para in as_list(canvas.get("summary")):
        add("summary", para)
    for r in as_list(canvas.get("receipts")):
        if isinstance(r, dict):
            add("receipt", " — ".join(x for x in (r.get("title"), r.get("detail")) if x), r.get("t"))
    for s in as_list(canvas.get("stickies")):
        if isinstance(s, dict):
            add("sticky", s.get("text"), s.get("t"))
    for s in as_list(canvas.get("shelf")):
        if isinstance(s, dict):
            add("shelf", " — ".join(x for x in (s.get("name"), s.get("note")) if x), s.get("t"))
    for move in as_list(canvas.get("moves")):
        add("move", move)
    for line in str(canvas.get("mindmap") or "").splitlines():
        add("map", re.sub(r"^\s*(#+|-)\s*", "", line))

    art = canvas.get("artifact") if isinstance(canvas.get("artifact"), dict) else {}
    for card in as_list(art.get("cards")):
        add("flashcard", f"{card.get('q', '')} — {card.get('a', '')}", card.get("t"))
    for step in as_list(art.get("steps")):
        add("step", step.get("text"), step.get("t"))
    for item in as_list(art.get("ingredients")):
        add("ingredient", " ".join(x for x in (item.get("qty"), item.get("item")) if x))
    for claim in as_list(art.get("claims")):
        add("claim", claim.get("claim"), claim.get("t"))
    for event in as_list(art.get("events")):
        add("timeline", " — ".join(x for x in (event.get("when"), event.get("label"), event.get("detail")) if x), event.get("t"))
    if art.get("type") == "verdict":
        add("verdict", art.get("call_line"))
        for p in as_list(art.get("pros")) + as_list(art.get("cons")):
            add("verdict", p.get("text"), p.get("t"))
    return records


def library_item(video_id: str, canvas: dict, path: Path) -> dict:
    return {
        "video_id": video_id,
        "title": canvas.get("title") or "",
        "headline": canvas.get("headline") or canvas.get("title") or "",
        "channel": canvas.get("channel") or "",
        "mode": canvas.get("mode") or DEFAULT_MODE,
        "mode_label": canvas.get("mode_label") or "",
        "duration": int(canvas.get("duration") or 0),
        "created_at": canvas.get("created_at") or mtime_iso(path),
        "outdated": int(canvas.get("schema_version") or 1) < SCHEMA_VERSION,
        "receipts": len(as_list(canvas.get("receipts"))),
    }


def all_canvases() -> list[tuple[str, dict, Path]]:
    out = []
    for video_id, path in canvas_files_by_video().items():
        canvas = read_json(path)
        if isinstance(canvas, dict):
            out.append((video_id, canvas, path))
    out.sort(key=lambda row: row[1].get("created_at") or mtime_iso(row[2]), reverse=True)
    return out


def search_records(rows, query: str, limit: int = 120) -> list[dict]:
    terms = [t for t in re.split(r"\s+", query.lower().strip()) if t]
    if not terms:
        return []
    hits = []
    for video_id, canvas in rows:
        for rec in canvas_records(canvas):
            low = rec["text"].lower()
            if all(term in low for term in terms):
                hits.append({
                    "video_id": video_id,
                    "headline": canvas.get("headline") or canvas.get("title") or "",
                    "mode": canvas.get("mode") or DEFAULT_MODE,
                    **rec,
                })
                if len(hits) >= limit:
                    return hits
    return hits


def reading_seconds(canvas: dict) -> int:
    """Roughly how long the canvas takes to read, at 230 words a minute."""
    parts = [canvas.get("tldr") or "", *as_list(canvas.get("summary")), *as_list(canvas.get("moves"))]
    for r in as_list(canvas.get("receipts")):
        if isinstance(r, dict):
            parts += [r.get("title") or "", r.get("detail") or ""]
    for s in as_list(canvas.get("stickies")):
        if isinstance(s, dict):
            parts.append(s.get("text") or "")
    words = sum(len(str(p).split()) for p in parts)
    return max(60, int(words / 230 * 60))


def load_list(path: Path) -> list:
    data = read_json(path, [])
    return data if isinstance(data, list) else []


def compute_streak(commitments: list) -> dict:
    resolved = sorted(
        (c for c in commitments if c.get("status") in {"done", "dropped"} and c.get("resolved_at")),
        key=lambda c: c["resolved_at"],
    )
    run = best = 0
    for c in resolved:
        if c["status"] == "done":
            run += 1
            best = max(best, run)
        else:
            run = 0
    return {
        "current": run,
        "best": best,
        "kept": sum(1 for c in commitments if c.get("status") == "done"),
        "dropped": sum(1 for c in commitments if c.get("status") == "dropped"),
        "open": sum(1 for c in commitments if c.get("status") == "open"),
    }


def compute_stats(canvases, commitments, events, beef_times, purge_times) -> dict:
    months: dict[str, dict] = {}

    def bucket(month: str) -> dict:
        return months.setdefault(month, {
            "month": month, "videos": 0, "footage_s": 0, "reading_s": 0,
            "modes": Counter(), "channels": Counter(), "longest": None, "featured": None,
            "made": 0, "kept": 0, "dropped": 0,
            "storycards": 0, "calls": 0, "nailed": 0, "cuts": 0, "beefs": 0, "purges": 0,
            "_quotes": [],
        })

    for video_id, canvas, created in canvases:
        m = bucket(created[:7])
        duration = int(canvas.get("duration") or 0)
        m["videos"] += 1
        m["footage_s"] += duration
        m["reading_s"] += reading_seconds(canvas)
        m["modes"][canvas.get("mode") or DEFAULT_MODE] += 1
        if canvas.get("channel"):
            m["channels"][canvas["channel"]] += 1
        if m["longest"] is None or duration > m["longest"]["duration"]:
            m["longest"] = {"video_id": video_id, "headline": canvas.get("headline") or "", "duration": duration}
        for sticky in as_list(canvas.get("stickies")):
            if isinstance(sticky, dict) and sticky.get("text"):
                m["_quotes"].append((sticky.get("kind") != "quote", {
                    "text": sticky["text"], "kind": sticky.get("kind"), "t": sticky.get("t"),
                    "video_id": video_id, "headline": canvas.get("headline") or "",
                }))

    for c in commitments:
        if c.get("created_at"):
            bucket(c["created_at"][:7])["made"] += 1
        if c.get("status") in {"done", "dropped"} and c.get("resolved_at"):
            bucket(c["resolved_at"][:7])["kept" if c["status"] == "done" else "dropped"] += 1

    for e in events:
        at = str(e.get("at") or "")
        if not at:
            continue
        m = bucket(at[:7])
        if e.get("type") == "storycard":
            m["storycards"] += 1
        elif e.get("type") == "call":
            m["calls"] += 1
            m["nailed"] += e.get("grade") == "nailed"
        elif e.get("type") == "cut":
            m["cuts"] += 1

    for at in beef_times:
        bucket(at[:7])["beefs"] += 1
    for at in purge_times:
        bucket(at[:7])["purges"] += 1

    out = []
    for month in sorted(months, reverse=True):
        m = months[month]
        quotes = sorted(m.pop("_quotes"), key=lambda q: q[0])  # real quotes first, newest canvas first
        m["featured"] = quotes[0][1] if quotes else None
        m["skipped_s"] = max(0, m["footage_s"] - m["reading_s"])
        m["top_mode"] = m["modes"].most_common(1)[0][0] if m["modes"] else None
        m["top_channel"] = m["channels"].most_common(1)[0][0] if m["channels"] else None
        m["modes"] = dict(m["modes"])
        m["channels"] = dict(m["channels"])
        out.append(m)

    total = {
        "videos": sum(m["videos"] for m in out),
        "footage_s": sum(m["footage_s"] for m in out),
        "reading_s": sum(m["reading_s"] for m in out),
    }
    total["skipped_s"] = max(0, total["footage_s"] - total["reading_s"])
    return {"total": total, "months": out, "streak": compute_streak(commitments)}


def cached_times(folder: Path) -> list[str]:
    if not folder.exists():
        return []
    times = []
    for path in folder.glob("*.json"):
        data = read_json(path, {})
        times.append((data.get("created_at") if isinstance(data, dict) else None) or mtime_iso(path))
    return times


# ------------------------------------------------------------------ routes: pages

@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def api_health():
    return {"ok": True, "schema_version": SCHEMA_VERSION}


@app.get("/api/meta")
def api_meta():
    video_id = extract_video_id((request.args.get("url") or "").strip())
    if not video_id:
        return error("That doesn't look like a YouTube link.", 400)
    title, channel = get_video_meta(video_id)
    return {"video_id": video_id, "title": title, "channel": channel}


# ------------------------------------------------------------------ routes: canvas

@app.post("/api/canvas")
def api_canvas():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    force = bool(data.get("force"))

    if not url:
        return error("Paste a YouTube link first.", 400)
    video_id = extract_video_id(url)
    if not video_id:
        return error("That doesn't look like a YouTube link. Paste a normal one.", 400)

    if not force:
        cached = load_cached_canvas(video_id)
        if cached:
            return cached

    try:
        return generate_canvas(video_id)
    except TranscriptProblem as exc:
        return error(str(exc), exc.status)
    except RuntimeError as exc:
        return error(str(exc), 502)
    except Exception as exc:  # noqa: BLE001
        return error(f"Couldn't build the canvas: {exc}", 502)


@app.get("/api/canvas/<video_id>")
def api_canvas_get(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id):
        return error("That isn't a video id.", 400)
    cached = load_cached_canvas(video_id)
    return cached if cached else error("That video hasn't been mapped yet.", 404)


@app.post("/api/revoice")
def api_revoice():
    data = request.get_json(silent=True) or {}
    video_id = extract_video_id(str(data.get("video_id") or ""))
    voice = str(data.get("voice") or "")
    if not video_id:
        return error("Which video?", 400)
    if voice not in VOICES:
        return error("That voice doesn't exist.", 400)

    canvas = load_cached_canvas(video_id)
    if not canvas:
        return error("Map this video first, then re-voice it.", 404)

    path = voice_cache_path(video_id, voice, canvas)
    cached = read_json(path)
    if isinstance(cached, dict):
        return cached

    try:
        raw = ask_claude(build_revoice_prompt(canvas, voice))
    except RuntimeError as exc:
        return error(str(exc), 502)
    lines = [as_text(line, 700) for line in as_list(raw.get("lines")) if as_text(line)][:20]
    if not lines:
        return error("Claude didn't manage that voice. Try again.", 502)
    payload = {"video_id": video_id, "voice": voice, "label": VOICES[voice][0], "lines": lines, "created_at": now_iso()}
    write_json(path, payload)
    return payload


# ------------------------------------------------------------------ routes: beef

@app.post("/api/beef")
def api_beef():
    data = request.get_json(silent=True) or {}
    a_id = extract_video_id(str(data.get("a") or "").strip())
    b_id = extract_video_id(str(data.get("b") or "").strip())
    if not a_id or not b_id:
        return error("Paste two YouTube links -- one for each corner.", 400)
    if a_id == b_id:
        return error("That's the same video twice. Beef needs two different videos.", 400)

    key = "__".join(sorted([a_id, b_id]))
    path = beef_cache_path(key)
    if not data.get("force"):
        cached = read_json(path)
        if isinstance(cached, dict):
            return {**(cached if cached["a"]["video_id"] == a_id else swap_beef(cached)), "cached": True}

    sides = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {name: pool.submit(fetch_transcript, vid) for name, vid in (("A", a_id), ("B", b_id))}
        for name, vid in (("A", a_id), ("B", b_id)):
            try:
                snippets, language = jobs[name].result()
            except TranscriptProblem as exc:
                return error(f"Video {name}: {exc}", exc.status)
            transcript, truncated = build_prompt_transcript(snippets, BEEF_TRANSCRIPT_CHARS)
            title, channel = get_video_meta(vid)
            sides[name] = {
                "video_id": vid, "title": title, "channel": channel, "language": language,
                "duration": duration_of(snippets), "transcript": transcript, "truncated": truncated,
            }

    try:
        beef = normalize_beef(ask_claude(build_beef_prompt(sides["A"], sides["B"])))
    except RuntimeError as exc:
        return error(str(exc), 502)
    if not (beef["clash"] or beef["agree"] or beef["verdict"]):
        return error("Claude came back empty-handed. Try again.", 502)

    def side(s):
        return {k: s[k] for k in ("video_id", "title", "channel", "language", "duration", "truncated")}

    payload = {**beef, "key": key, "a": side(sides["A"]), "b": side(sides["B"]), "created_at": now_iso()}
    write_json(path, payload)
    return {**payload, "cached": False}


# ------------------------------------------------------------------ routes: purge

@app.post("/api/purge")
def api_purge():
    data = request.get_json(silent=True) or {}
    try:
        ids, trimmed = expand_purge_input(data.get("urls"))
    except PurgeProblem as exc:
        return error(str(exc), 400)
    if not ids:
        return error("Paste at least one YouTube link (one per line), or a playlist link.", 400)

    key = hashlib.sha256(",".join(ids).encode()).hexdigest()[:12]
    path = purge_cache_path(key)
    if not data.get("force"):
        cached = read_json(path)
        if isinstance(cached, dict):
            return {**cached, "cached": True}

    def gather(video_id):
        title, channel = get_video_meta(video_id)
        row = {"video_id": video_id, "title": title, "channel": channel, "duration": 0}
        try:
            snippets, _ = fetch_transcript(video_id)
            row.update(snippets=snippets, duration=duration_of(snippets))
        except TranscriptProblem as exc:
            row["problem"] = str(exc)
        return row

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(gather, ids))

    usable = [r for r in rows if r.get("snippets")]
    verdicts, summary_line = {}, ""
    if usable:
        blocks = []
        for n, row in enumerate(usable, 1):
            row["n"] = n
            blocks.append(
                f"[{n}] {row['title']} -- {row['channel'] or 'unknown channel'} -- {format_timestamp(row['duration'])} long\n"
                f"{sample_transcript(row['snippets'])}"
            )
        try:
            verdicts, summary_line = normalize_purge(ask_claude(build_purge_prompt(blocks)))
        except RuntimeError as exc:
            return error(str(exc), 502)

    items = []
    for row in rows:
        verdict = verdicts.get(row.get("n")) if row.get("n") else None
        items.append({
            "video_id": row["video_id"],
            "title": row["title"],
            "channel": row["channel"],
            "duration": row["duration"],
            "verdict": verdict["verdict"] if verdict else "unknown",
            "why": verdict["why"] if verdict else (row.get("problem") or "Claude skipped this one -- run the purge again."),
            "best_t": verdict["best_t"] if verdict else None,
            "best_label": verdict["best_label"] if verdict else "",
        })

    counts = Counter(item["verdict"] for item in items)
    saved = sum(i["duration"] for i in items if i["verdict"] == "skip") + int(
        sum(i["duration"] for i in items if i["verdict"] == "skim") * 0.75
    )
    payload = {
        "key": key,
        "items": items,
        "summary_line": summary_line,
        "counts": {v: counts.get(v, 0) for v in ("watch", "skim", "skip", "unknown")},
        "saved_seconds": saved,
        "trimmed": trimmed,
        "created_at": now_iso(),
    }
    write_json(path, payload)
    return {**payload, "cached": False}


@app.get("/api/purge/<key>")
def api_purge_get(key):
    if not re.fullmatch(r"[0-9a-f]{12}", key):
        return error("That isn't a purge.", 400)
    folder = CACHE_DIR / "purge"
    matches = sorted(folder.glob(f"{key}.*.json"), key=lambda p: p.stat().st_mtime, reverse=True) if folder.exists() else []
    data = read_json(matches[0]) if matches else None
    return {**data, "cached": True} if isinstance(data, dict) else error("That purge isn't around any more.", 404)


# ------------------------------------------------------------------ routes: library

@app.get("/api/library")
def api_library():
    return {"items": [library_item(vid, canvas, path) for vid, canvas, path in all_canvases()]}


@app.get("/api/search")
def api_search():
    query = request.args.get("q") or ""
    rows = [(vid, canvas) for vid, canvas, _ in all_canvases()]
    return {"hits": search_records(rows, query), "terms": [t for t in query.lower().split() if t]}


@app.get("/api/stats")
def api_stats():
    canvases = [(vid, canvas, canvas.get("created_at") or mtime_iso(path)) for vid, canvas, path in all_canvases()]
    return compute_stats(
        canvases,
        load_list(COMMITMENTS_FILE),
        load_list(EVENTS_FILE),
        cached_times(CACHE_DIR / "beef"),
        cached_times(CACHE_DIR / "purge"),
    )


# ------------------------------------------------------------------ routes: commitments + events

@app.get("/api/commitments")
def api_commitments():
    items = load_list(COMMITMENTS_FILE)
    return {"items": items, "streak": compute_streak(items)}


@app.post("/api/commitments")
def api_commit():
    data = request.get_json(silent=True) or {}
    action = as_text(data.get("action"), 240)
    if not action:
        return error("Commit to what, though?", 400)
    video_id = extract_video_id(str(data.get("video_id") or "")) or None

    with _data_lock:
        items = load_list(COMMITMENTS_FILE)
        for c in items:
            if c.get("status") == "open" and c.get("action") == action and c.get("video_id") == video_id:
                return c
        commitment = {
            "id": uuid.uuid4().hex[:12],
            "video_id": video_id,
            "headline": as_text(data.get("headline"), 200),
            "action": action,
            "status": "open",
            "created_at": now_iso(),
            "resolved_at": None,
            "snooze_until": None,
        }
        items.append(commitment)
        if not write_json(COMMITMENTS_FILE, items):
            return error(f"Couldn't save that -- is {DATA_DIR} writable?", 500)
    return commitment, 201


@app.patch("/api/commitments/<cid>")
def api_commit_update(cid):
    data = request.get_json(silent=True) or {}
    with _data_lock:
        items = load_list(COMMITMENTS_FILE)
        target = next((c for c in items if c.get("id") == cid), None)
        if not target:
            return error("That commitment isn't around any more.", 404)
        status = data.get("status")
        if status in {"done", "dropped"}:
            target.update(status=status, resolved_at=now_iso(), snooze_until=None)
        elif status == "open":
            target.update(status="open", resolved_at=None)
        if data.get("snooze_days"):
            days = max(1, min(30, int(as_seconds(data.get("snooze_days")) or 1)))
            target["snooze_until"] = (datetime.now().astimezone() + timedelta(days=days)).isoformat(timespec="seconds")
        if not write_json(COMMITMENTS_FILE, items):
            return error(f"Couldn't save that -- is {DATA_DIR} writable?", 500)
    return target


@app.post("/api/events")
def api_event():
    data = request.get_json(silent=True) or {}
    kind = data.get("type")
    if kind not in EVENT_TYPES:
        return error("Unknown event.", 400)
    event = {"type": kind, "video_id": extract_video_id(str(data.get("video_id") or "")) or None, "at": now_iso()}
    if kind == "call" and data.get("grade") in CALL_GRADES:
        event["grade"] = data["grade"]
    with _data_lock:
        events = load_list(EVENTS_FILE)[-4999:]
        events.append(event)
        write_json(EVENTS_FILE, events)
    return event, 201


if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("PORT", "5000")))
