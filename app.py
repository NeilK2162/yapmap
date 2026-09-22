"""
yapmap -- turn the yap into a map.

Paste a YouTube link, get back a canvas: a mindmap where every idea is
timestamped and explained, a tool built for that kind of video (flashcards, a
cook-along, a buy/skip card, claims to check, or a timeline), a wall of sticky
notes, the shelf of everything they name-dropped, a summary you can re-voice,
next moves you can commit to, and timestamped receipts you can tick, download,
or watch as a no-yap cut. Then ask the video anything, with answers that cite
the second they came from.

Around the canvas sit the other tools: beef mode (two videos, where they
clash), the purge (triage a pile of videos), a searchable library of
everything you've mapped, a spaced-repetition review deck, a follow-through
tracker, and a monthly Wrapped.

Flask backend: fetches transcripts, shells out to the Claude Code CLI
(authenticated with your Claude subscription -- no API key, no per-token
billing), and streams structured JSON to the frontend as Claude writes it.

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
import math
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, Response, render_template, request
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

# On a big job Claude may think before it writes. That took a canvas from about
# a minute to over four, and spends far more of your usage limit, so it's off
# by default. "auto" leaves it to the CLI's own default.
CLAUDE_THINKING = os.getenv("CLAUDE_THINKING", "off").strip().lower()

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

# Asking a question: a transcript up to this size goes in whole, which gives
# the best answers. Anything longer sends only the parts that match the
# question best, so one question never costs a whole long video's worth.
ASK_FULL_TRANSCRIPT_CHARS = 36_000
ASK_CONTEXT_CHARS = 16_000
ASK_HISTORY_TURNS = 3

# Generated output is cached on disk. Subscription usage limits are a real
# budget, so reopening anything you've already made costs nothing.
CACHE_DIR = Path(os.getenv("YAPMAP_CACHE_DIR", ".cache"))

# Things only you create -- commitments, flashcard reviews and activity for
# Wrapped -- live apart from the cache, so clearing it never wipes them.
DATA_DIR = Path(os.getenv("YAPMAP_DATA_DIR", ".yapmap"))
COMMITMENTS_FILE = DATA_DIR / "commitments.json"
EVENTS_FILE = DATA_DIR / "events.json"
REVIEWS_FILE = DATA_DIR / "reviews.json"

# Bumped whenever the canvas gains fields. Canvases from an older version
# still open -- the page offers to regenerate them for the new sections.
SCHEMA_VERSION = 3

# Content modes the frontend knows how to style. Claude picks one; anything
# unrecognised falls back to "study".
KNOWN_MODES = {"study", "yap", "howto", "verdict", "story"}
DEFAULT_MODE = "study"

SHELF_KINDS = {"book", "tool", "person", "paper", "site", "other"}
EVENT_TYPES = {"storycard", "call", "cut", "review", "ask"}
CALL_GRADES = {"nailed", "close", "off"}

# Spaced repetition: days until a card comes back, by how many times in a row
# you've known it. Missing it sends it back to the start.
SRS_INTERVALS = [0, 1, 3, 7, 16, 35, 90]
REVIEW_GRADES = {"again", "good", "easy"}

# How long a finished job stays around, so a tab that reconnects late still
# gets the ending.
JOB_RETENTION_SECONDS = 15 * 60

VIDEO_ID_RE = re.compile(r"[0-9A-Za-z_-]{11}")

VIDEO_ID_PATTERNS = [
    re.compile(r"(?:youtube\.com/watch\?.*[?&]v=|youtube\.com/watch\?v=)([0-9A-Za-z_-]{11})"),
    re.compile(r"youtu\.be/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/embed/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/shorts/([0-9A-Za-z_-]{11})"),
    re.compile(r"youtube\.com/live/([0-9A-Za-z_-]{11})"),
]

# The language everything is written in: (label, how to tell Claude). The
# app's own buttons stay English; this is about what Claude writes. "auto"
# means whatever the video is spoken in.
LANGUAGES = {
    "en": ("English", "English (even if the video itself is in another language)"),
    "hinglish": ("Hinglish", "Hinglish: Hindi written in the Latin alphabet and mixed with English, the way people text in India (e.g. 'yeh video basically batata hai ki...')"),
    "hi": ("हिन्दी", "Hindi, in Devanagari script"),
    "es": ("Español", "Spanish"),
    "pt": ("Português", "Brazilian Portuguese"),
    "fr": ("Français", "French"),
    "de": ("Deutsch", "German"),
    "ja": ("日本語", "Japanese"),
    "ko": ("한국어", "Korean"),
    "id": ("Bahasa Indonesia", "Indonesian"),
    "auto": ("same as the video", None),
}
DEFAULT_LANG = "en"

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


def short_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


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
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return max(0, int(value))
    if isinstance(value, str):
        text = value.strip().strip("[]")
        if text.isdigit():
            return int(text)
        if re.fullmatch(r"\d{1,2}(:\d{2}){1,2}", text):
            total = 0
            for part in text.split(":"):
                total = total * 60 + int(part)
            return total
    return None


def clamp_t(value, duration: int | None = None) -> int | None:
    """A timestamp, dropped if it points past the end of the video."""
    t = as_seconds(value)
    if t is not None and duration and t > duration + 15:
        return None
    return t


def as_text(value, limit: int = 400) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def as_list(value) -> list:
    return value if isinstance(value, list) else []


def error(message: str, status: int, **extra):
    return {"error": message, **extra}, status


# ------------------------------------------------------------------ languages

def clean_lang(value) -> str:
    code = str(value or "").strip().lower()
    return code if code in LANGUAGES else DEFAULT_LANG


def resolve_lang(lang: str, transcript_code: str) -> str:
    """'Same as the video' for an English video is just English -- one cache entry, not two."""
    if lang == "auto" and (transcript_code or "").lower().startswith("en"):
        return "en"
    return lang


def language_line(lang: str, transcript_language: str = "") -> str:
    if lang == "auto":
        spoken = transcript_language.replace("(auto-generated)", "").strip() or "the video's own language"
        return f"Write every human-readable value in the language the video is spoken in: {spoken}."
    return f"Write every human-readable value in {LANGUAGES.get(lang, LANGUAGES['en'])[1]}."


def lang_suffix(lang: str) -> str:
    return "" if lang == DEFAULT_LANG else f".{lang}"


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


_meta_cache: dict[str, tuple[str, str]] = {}


def get_video_meta(video_id: str) -> tuple[str, str]:
    """Best-effort title/channel lookup via YouTube's public oEmbed endpoint (no API key needed)."""
    if video_id in _meta_cache:
        return _meta_cache[video_id]
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
        meta = data.get("title") or "Untitled video", data.get("author_name") or ""
        _meta_cache[video_id] = meta
        return meta
    except Exception:
        return "Untitled video", ""


def get_transcript(video_id: str) -> tuple[list[tuple[float, str]], str, str]:
    """
    Returns (snippets, language_label, language_code) where snippets is a list
    of (start_seconds, text). Prefers a manually-created English transcript,
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
    return snippets, label, transcript.language_code or ""


class TranscriptProblem(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def transcript_cache_path(video_id: str) -> Path:
    return CACHE_DIR / "transcripts" / f"{video_id}.json"


def fetch_transcript(video_id: str) -> tuple[list[tuple[float, str]], str, str]:
    """
    get_transcript, cached on disk -- regenerating, asking and reading along
    shouldn't each hit YouTube -- with the library's exceptions turned into
    messages a person can act on.
    """
    cached = read_json(transcript_cache_path(video_id))
    if isinstance(cached, dict) and cached.get("snippets"):
        snippets = [(float(s), str(t)) for s, t in cached["snippets"]]
        return snippets, cached.get("language") or "", cached.get("language_code") or ""
    try:
        snippets, label, code = get_transcript(video_id)
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
    write_json(transcript_cache_path(video_id), {
        "video_id": video_id,
        "language": label,
        "language_code": code,
        "snippets": [[round(s, 2), t] for s, t in snippets],
        "fetched_at": now_iso(),
    })
    return snippets, label, code


def format_timestamp(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def transcript_blocks(snippets: list[tuple[float, str]], size: int = 220) -> list[tuple[float, str]]:
    """
    Collapse raw caption snippets into ~220-char blocks, each stamped with the
    second it starts. The timestamps are the whole point: they're what lets
    Claude cite a moment, and what lets the frontend seek the player to it.
    """
    blocks: list[tuple[float, str]] = []
    buffer: list[str] = []
    buffer_start: float | None = None
    for start, text in snippets:
        # Captions carry their own line breaks; one stray newline in a prompt
        # line would leave the next line without a timestamp.
        text = " ".join(str(text).split())
        if not text:
            continue
        if buffer_start is None:
            buffer_start = start
        buffer.append(text)
        if sum(len(t) + 1 for t in buffer) >= size:
            blocks.append((buffer_start, " ".join(buffer)))
            buffer, buffer_start = [], None
    if buffer and buffer_start is not None:
        blocks.append((buffer_start, " ".join(buffer)))
    return blocks


def block_line(t: float, text: str) -> str:
    return f"[{format_timestamp(t)}] {text}"


def build_prompt_transcript(
    snippets: list[tuple[float, str]], max_chars: int = MAX_TRANSCRIPT_CHARS
) -> tuple[str, bool]:
    joined = "\n".join(block_line(t, text) for t, text in transcript_blocks(snippets))
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

class ClaudeProblem(RuntimeError):
    def __init__(self, message: str, code: str = "claude", **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def resolve_claude() -> str:
    # Resolve to a full path before handing it to subprocess. On Windows the
    # npm install is a `claude.cmd` shim, and CreateProcess only ever tries
    # appending .exe -- it doesn't walk PATHEXT the way shutil.which does --
    # so a bare "claude" dies with "[WinError 2] The system cannot find the
    # file specified" even though the CLI is installed and on PATH.
    claude_path = shutil.which(CLAUDE_BIN)
    if claude_path is None:
        raise ClaudeProblem(
            f"Couldn't find the Claude Code CLI ('{CLAUDE_BIN}') on your PATH. "
            "Install it with 'npm install -g @anthropic-ai/claude-code', then run "
            "'claude auth login' once to sign in with your Claude subscription.",
            "cli_missing",
        )
    return claude_path


def claude_env() -> dict:
    env = dict(os.environ)
    if CLAUDE_THINKING == "off":
        env["MAX_THINKING_TOKENS"] = "0"
    return env


def base_command(claude_path: str) -> list[str]:
    cmd = [
        claude_path,
        "-p",
        "--tools",
        "",  # no tool access needed -- this is a pure text-in, text-out call
        "--no-session-persistence",
    ]
    if CLAUDE_MODEL:
        cmd += ["--model", CLAUDE_MODEL]
    return cmd


def friendly_claude_error(detail: str) -> ClaudeProblem:
    """The CLI's own error text, turned into something a person can act on."""
    low = detail.lower()
    if "limit" in low and any(word in low for word in ("usage", "reached", "hit your", "resets")):
        resets_at = None
        stamp = re.search(r"\|(\d{9,})", detail)
        if stamp:
            resets_at = datetime.fromtimestamp(int(stamp.group(1))).astimezone().isoformat(timespec="minutes")
        return ClaudeProblem(
            "You've hit your Claude usage limit for now. Everything you've already mapped still "
            "opens for free -- new ones will work again once the limit resets.",
            "usage_limit",
            resets_at=resets_at,
        )
    if any(word in low for word in ("not logged in", "/login", "please run", "invalid api key", "authenticat")):
        return ClaudeProblem(
            "The Claude Code CLI isn't signed in. Run 'claude auth login' once in a terminal, then try again.",
            "auth",
        )
    return ClaudeProblem(f"Claude Code CLI failed: {detail[:600]}", "cli_failed")


def run_claude(prompt: str) -> str:
    """One blocking call: prompt in, full text out."""
    cmd = base_command(resolve_claude()) + ["--output-format", "text"]
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
            env=claude_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise ClaudeProblem(
            f"Claude didn't respond within {CLAUDE_TIMEOUT_SECONDS}s. Very long "
            "videos may need a higher CLAUDE_TIMEOUT_SECONDS.",
            "timeout",
        ) from exc

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise friendly_claude_error(detail)

    return result.stdout.strip()


def kill_tree(proc) -> None:
    """Stop the CLI and everything it started -- on Windows the .cmd shim's node child too."""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=15)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001 -- fall back to the plain kill below
        pass
    try:
        if proc.poll() is None:
            proc.kill()
    except Exception:  # noqa: BLE001
        pass


def stream_claude(prompt: str, job: "Job", on_text=None) -> str:
    """
    Run the CLI with token streaming. on_text gets each piece of text as
    Claude writes it; the full text comes back at the end. The job can cancel
    it at any point, which kills the process.
    """
    cmd = base_command(resolve_claude()) + [
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ]
    popen_kwargs = dict(
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1, env=claude_env(),
    )
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True  # so the whole group can be killed
    proc = subprocess.Popen(cmd, **popen_kwargs)
    job.proc = proc
    if job.cancelled:
        kill_tree(proc)
        raise JobCancelled()

    def feed():
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except (OSError, ValueError):
            pass  # the process died early; its exit code tells the story

    stderr_parts: list[str] = []
    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=lambda: stderr_parts.append(proc.stderr.read() or ""), daemon=True).start()

    timed_out = threading.Event()

    def on_timeout():
        timed_out.set()
        kill_tree(proc)

    watchdog = threading.Timer(CLAUDE_TIMEOUT_SECONDS, on_timeout)
    watchdog.daemon = True
    watchdog.start()

    streamed: list[str] = []
    thought = 0
    final_text = None
    final_error = None
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "stream_event":
                inner = event.get("event") or {}
                delta = inner.get("delta") or {}
                block = inner.get("content_block") or {}
                if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                    piece = delta.get("text") or ""
                    if piece:
                        streamed.append(piece)
                        if on_text:
                            on_text(piece)
                elif inner.get("type") == "content_block_start" and block.get("type") in ("thinking", "redacted_thinking"):
                    # Claude plans before it writes on big jobs. Say so, instead
                    # of sitting on "reading" for minutes.
                    job.set_stage("thinking")
                elif inner.get("type") == "content_block_delta" and delta.get("type") == "thinking_delta":
                    thought += len(delta.get("thinking") or "")
                    job.progress(thinking=thought)
            elif kind == "assistant" and not streamed:
                # A CLI without partial messages still sends the whole message
                # once -- hand it over in one go so nothing downstream changes.
                blocks = ((event.get("message") or {}).get("content")) or []
                whole = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
                if whole:
                    streamed.append(whole)
                    if on_text:
                        on_text(whole)
            elif kind == "rate_limit_event":
                job.rate_limit(event.get("rate_limit_info") or {})
            elif kind == "result":
                if event.get("is_error") or event.get("subtype") not in (None, "success"):
                    final_error = str(event.get("result") or event.get("error") or event.get("subtype") or "unknown error")
                else:
                    final_text = event.get("result")
        proc.wait()
    finally:
        watchdog.cancel()
        job.proc = None

    if job.cancelled:
        raise JobCancelled()
    if timed_out.is_set():
        raise ClaudeProblem(
            f"Claude didn't finish within {CLAUDE_TIMEOUT_SECONDS}s. Very long videos may need a "
            "higher CLAUDE_TIMEOUT_SECONDS.",
            "timeout",
        )
    if final_error:
        raise friendly_claude_error(final_error)
    text = final_text if isinstance(final_text, str) else "".join(streamed)
    if proc.returncode != 0 and not text.strip():
        detail = "".join(stderr_parts).strip() or f"exit code {proc.returncode}"
        raise friendly_claude_error(detail)
    return text.strip()


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
        raise ClaudeProblem("Claude didn't return JSON. Try regenerating.", "bad_json")
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ClaudeProblem(f"Claude returned malformed JSON: {exc}", "bad_json") from exc


def ask_claude(prompt: str) -> dict:
    data = extract_json(run_claude(prompt))
    if not isinstance(data, dict):
        raise ClaudeProblem("Claude returned JSON, but not an object. Try regenerating.", "bad_json")
    return data


# ------------------------------------------------------------------ reading JSON while it streams

class TopLevelStream:
    """
    Feed it the text of one JSON object as it streams in; it hands back each
    top-level field the moment that field is complete. That's what lets the
    canvas fill in section by section instead of all at once at the end.
    """

    def __init__(self):
        self.text = ""
        self.fields: dict = {}
        self._pos = 0
        self._started = False
        self._finished = False
        self._depth = 0
        self._in_str = False
        self._esc = False
        self._state = "key"
        self._key = None
        self._key_start = 0
        self._val_start = 0

    def feed(self, chunk: str) -> list[tuple[str, object]]:
        self.text += chunk
        out = []
        text, i, n = self.text, self._pos, len(self.text)
        while i < n and not self._finished:
            c = text[i]
            if not self._started:
                if c == "{":  # skips any preamble or code fence before the object
                    self._started, self._depth, self._state = True, 1, "key"
                i += 1
                continue
            if self._in_str:
                if self._esc:
                    self._esc = False
                elif c == "\\":
                    self._esc = True
                elif c == '"':
                    self._in_str = False
                    if self._state == "keystr":
                        try:
                            self._key = json.loads(text[self._key_start : i + 1])
                        except json.JSONDecodeError:
                            self._key = text[self._key_start + 1 : i]
                        self._state = "colon"
                i += 1
                continue
            if self._state == "key":
                if c == '"':
                    self._in_str, self._state, self._key_start = True, "keystr", i
                elif c == "}":
                    self._finished = True
            elif self._state == "colon":
                if c == ":":
                    self._state = "gap"
            elif self._state == "gap":
                if not c.isspace():
                    self._state, self._val_start = "value", i
                    continue  # look at this character again as the value's first
            elif self._state == "value":
                if c == '"':
                    self._in_str = True
                elif c in "{[":
                    self._depth += 1
                elif c in "}]":
                    if self._depth == 1:  # the object itself just closed
                        out.append(self._complete(i))
                        self._finished = True
                    else:
                        self._depth -= 1
                elif c == "," and self._depth == 1:
                    out.append(self._complete(i))
                    self._state = "key"
            i += 1
        self._pos = i
        return [x for x in out if x]

    def _complete(self, end: int):
        raw = self.text[self._val_start : end].strip()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return None
        self.fields[self._key] = value
        return self._key, value

    def current(self) -> tuple[str | None, str]:
        """The field being written right now, and its text so far."""
        if self._state == "value" and not self._finished:
            return self._key, self.text[self._val_start :]
        return None, ""


def repair_json_prefix(text: str, items_only: bool = False):
    """
    The start of a JSON value that's still streaming, cut back to its last
    complete piece and closed off -- so half a mindmap is still a mindmap.
    items_only cuts only between whole items of a top-level list, so a list
    never shows an item that's half written.
    """
    stack: list[str] = []
    in_str = esc = False
    cut = None
    for i, c in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in "{[":
            if items_only and not stack and c != "[":
                return None
            stack.append(c)
            if not items_only or len(stack) == 1:
                cut = (i + 1, tuple(stack))
        elif c in "}]":
            if not stack:
                break
            stack.pop()
            if not items_only or len(stack) <= 1:
                cut = (i + 1, tuple(stack))
            if not stack:
                break
        elif c == ",":
            if not items_only or len(stack) == 1:
                cut = (i, tuple(stack))
    if cut is None:
        return None
    end, open_stack = cut
    closing = "".join("}" if c == "{" else "]" for c in reversed(open_stack))
    try:
        return json.loads(text[:end] + closing)
    except json.JSONDecodeError:
        return None


# ------------------------------------------------------------------ jobs

class JobCancelled(Exception):
    pass


class Job:
    """
    One long-running piece of work -- a canvas, a beef, a purge, an answer --
    that the page can watch as it happens, leave and come back to, or cancel.
    Every event is kept, so a tab that connects late replays the story so far.
    Progress and half-finished fields are kept only as their latest version.
    """

    def __init__(self, kind: str, key: str, params: dict):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.key = key
        self.params = params
        self.title = params.get("title") or ""
        self.status = "running"
        self.created = time.time()
        self.finished_at = None
        self.events: list[dict] = []
        self.partials: dict[str, dict] = {}
        self.stage = "queued"
        self.cancelled = False
        self.proc = None
        self._partial_version = 0
        self._last_progress = 0.0
        self._warned = False
        self._cond = threading.Condition()

    # -- writing
    def emit(self, type_: str, **data) -> None:
        with self._cond:
            self.events.append({"id": len(self.events) + 1, "type": type_, **data})
            self._cond.notify_all()

    def set_stage(self, stage: str, **data) -> None:
        self.stage = stage
        self.emit("stage", stage=stage, **data)

    def field(self, key: str, value) -> None:
        with self._cond:
            self.partials.pop(key, None)
            self.events.append({"id": len(self.events) + 1, "type": "field", "key": key, "value": value})
            self._cond.notify_all()

    def partial(self, key: str, value) -> None:
        with self._cond:
            self._partial_version += 1
            self.partials[key] = {"type": "partial", "key": key, "value": value, "v": self._partial_version}
            self._cond.notify_all()

    def progress(self, force: bool = False, **data) -> None:
        now = time.monotonic()
        if not force and now - self._last_progress < 0.8:
            return
        self._last_progress = now
        with self._cond:
            self._partial_version += 1
            self.partials["_progress"] = {"type": "progress", "v": self._partial_version, **data}
            self._cond.notify_all()

    def rate_limit(self, info: dict) -> None:
        status = str(info.get("status") or "")
        if status in ("", "allowed") or self._warned:
            return
        self._warned = True
        windows = info.get("unifiedWindows") or {}
        window = windows.get(info.get("rateLimitType") or "") or {}
        used = window.get("utilization", info.get("utilization"))
        percent = None
        if isinstance(used, (int, float)):
            percent = round(used * 100 if used <= 1 else used)
        resets = window.get("resetsAt") or info.get("resetsAt")
        resets_at = None
        if isinstance(resets, (int, float)):
            resets_at = datetime.fromtimestamp(resets / 1000 if resets > 1e11 else resets).astimezone().isoformat(timespec="minutes")
        message = "Heads up: you're close to your Claude usage limit"
        message += f" ({percent}% used)." if percent else "."
        self.emit("warning", code="usage", message=message, resets_at=resets_at)

    def finish(self, status: str) -> None:
        with self._cond:
            self.status = status
            self.finished_at = time.time()
            self.partials.pop("_progress", None)
            self._cond.notify_all()

    def cancel(self) -> None:
        self.cancelled = True
        kill_tree(self.proc)

    def check(self) -> None:
        if self.cancelled:
            raise JobCancelled()

    # -- reading
    def summary(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "title": self.title,
            "params": {k: v for k, v in self.params.items() if k in ("video_id", "lang", "a", "b", "force")},
            "stage": self.stage,
            "created_at": datetime.fromtimestamp(self.created).astimezone().isoformat(timespec="seconds"),
        }

    def stream(self, after: int = 0):
        """Server-sent events: everything after `after`, then live until the job ends."""
        sent = max(0, after)
        seen: dict[str, int] = {}
        while True:
            with self._cond:
                while True:
                    fresh = self.events[sent:]
                    partials = [p for k, p in self.partials.items() if seen.get(k) != p["v"]]
                    ended = self.status != "running"
                    if fresh or partials or ended:
                        break
                    if not self._cond.wait(timeout=15):
                        break
            if not (fresh or partials or ended):
                yield ": still cooking\n\n"  # keeps proxies and the browser from giving up
                continue
            for event in fresh:
                sent = event["id"]
                yield sse(event)
            for p in partials:
                seen[p.get("key") or p["type"]] = p["v"]
                yield sse({k: v for k, v in p.items() if k != "v"})
            if ended and sent >= len(self.events):
                return


def sse(event: dict) -> str:
    head = f"id: {event['id']}\n" if "id" in event else ""
    return head + "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


def prune_jobs() -> None:
    cutoff = time.time() - JOB_RETENTION_SECONDS
    for job_id, job in list(_jobs.items()):
        if job.status != "running" and (job.finished_at or 0) < cutoff:
            _jobs.pop(job_id, None)


def start_job(kind: str, key: str, params: dict, work) -> tuple[Job, bool]:
    """Start `work(job)` on a thread -- or hand back the same work already running."""
    with _jobs_lock:
        prune_jobs()
        for job in _jobs.values():
            if job.key == key and job.status == "running":
                return job, False
        job = Job(kind, key, params)
        _jobs[job.id] = job

    def run():
        try:
            result = work(job)
            job.emit("done", result=result)
            job.finish("done")
        except JobCancelled:
            job.emit("cancelled", message="Cancelled. Nothing was saved and nothing more was spent.")
            job.finish("cancelled")
        except TranscriptProblem as exc:
            job.emit("error", message=str(exc), code="transcript")
            job.finish("error")
        except ClaudeProblem as exc:
            job.emit("error", message=str(exc), code=exc.code, **exc.extra)
            job.finish("error")
        except PurgeProblem as exc:
            job.emit("error", message=str(exc), code="input")
            job.finish("error")
        except Exception as exc:  # noqa: BLE001 -- the page must always hear how it ended
            job.emit("error", message=f"Something broke: {str(exc)[:400]}", code="internal")
            job.finish("error")

    threading.Thread(target=run, daemon=True, name=f"yapmap-{kind}-{job.id}").start()
    return job, True


# ------------------------------------------------------------------ canvas prompt

# Kept out of the f-strings below so their braces don't need escaping. The
# key order is the order the page fills in while Claude writes.
CANVAS_SCHEMA = """{
  "mode": "study | yap | howto | verdict | story",
  "mode_label": "2-3 word playful name for what kind of video this is",
  "headline": "a sharper version of the video's title, max 9 words",
  "tldr": "one punchy sentence -- what someone actually gets out of this video",
  "mindmap": {
    "label": "the central topic, 2-6 words",
    "t": "0:00",
    "note": "one sentence: what the whole video argues, teaches or shows",
    "children": [
      {"label": "a main theme, 2-7 words", "t": "1:35", "note": "1-2 sentences: what the video says about it", "children": [
        {"label": "an idea inside it, 2-9 words", "t": "2:10", "note": "one sentence with the specifics, or ''", "children": []}
      ]}
    ]
  },
  "artifact": {"type": "...", "...": "the block for your mode, from the list above"},
  "stickies_label": "2-3 word name for the pull-quote wall, fitted to this video",
  "stickies": [
    {"kind": "quote | aha | warning | stat | tip", "text": "6-25 words", "t": "2:08"}
  ],
  "shelf": [
    {"name": "the thing exactly as named", "kind": "book | tool | person | paper | site | other", "note": "why it came up, 4-12 words", "t": "5:01"}
  ],
  "summary": ["3 to 5 paragraphs of plain prose, each 2-4 sentences"],
  "moves": ["a concrete thing to go do offline after watching, 5-14 words"],
  "questions": ["a question a curious viewer would ask, that this video answers, max 14 words"],
  "receipts_label": "2-3 word name for the key-findings list, fitted to this video",
  "receipts": [
    {"title": "4-9 words", "detail": "1-2 sentences of real substance", "t": "7:32", "t_end": "8:17"}
  ]
}"""

ARTIFACT_SPECS = """- study   -> {"type": "flashcards", "cards": [{"q": "a question a student would be tested on, max 16 words", "a": "the answer as the video gives it, 1-2 sentences", "t": "10:10"}]}
             6 to 10 cards, each testing something the video actually teaches.
- howto   -> {"type": "cookalong", "yields": "what you end up with, e.g. '4 servings' or 'one working shelf'", "ingredients": [{"item": "flour", "qty": "2 cups"}], "steps": [{"text": "one imperative step, max 22 words", "t": "1:35", "timer_seconds": 480}]}
             every ingredient, material and tool the video uses; 4 to 14 steps in order; "timer_seconds" only when the video states how long something takes, otherwise null.
- verdict -> {"type": "verdict", "product": "what is being judged", "call": "buy | wait | skip | depends", "call_line": "the reviewer's bottom line in one sentence", "for_who": ["who it suits, 3-10 words"], "skip_if": ["who should pass, 3-10 words"], "deal_breaker": {"text": "the single biggest reason to hesitate", "t": "13:32"}, "pros": [{"text": "...", "t": "2:00"}], "cons": [{"text": "...", "t": "6:40"}]}
             2 to 5 of each list; "call" is the reviewer's call, not yours.
- yap     -> {"type": "claims", "claims": [{"claim": "one specific, checkable factual claim", "who": "who said it -- a name, or 'host' / 'guest'", "t": "24:00", "check": "what you'd look up to verify it, max 14 words"}]}
             5 to 10 claims: facts, numbers, predictions and named events -- never opinions.
- story   -> {"type": "timeline", "events": [{"t": "1:00", "when": "the date or era if the video states one, else ''", "label": "4-8 words", "detail": "one sentence"}]}
             6 to 14 events, in the order the video covers them."""

MODE_TO_ARTIFACT = {
    "study": "flashcards",
    "howto": "cookalong",
    "verdict": "verdict",
    "yap": "claims",
    "story": "timeline",
}


def build_canvas_prompt(
    title: str, channel: str, transcript: str, truncated: bool, lang: str = DEFAULT_LANG, transcript_language: str = ""
) -> str:
    truncation_note = (
        "NOTE: the transcript was truncated because the video is very long -- "
        "work with what you have and don't pretend to cover the rest.\n"
        if truncated
        else ""
    )
    return f"""You are turning a YouTube transcript into a canvas: a mindmap of every idea in it, a tool built for this kind of video, a wall of pull-quotes, key findings, and the shelf of everything it names.

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

Now output JSON matching this shape exactly, with the keys in this order:

{CANVAS_SCHEMA}

The mindmap is the centrepiece -- make it excellent:
- It maps the IDEAS in the video, grouped the way a great teacher would explain the subject -- not a list of timestamps. The root is the central topic. Under it, 4 to 8 main themes. Under each theme, 2 to 6 ideas, and a level or two deeper wherever the video genuinely goes deeper (never more than 4 levels below the root). Roughly 30 to 70 nodes for a typical video, fewer for a short or thin one. Never pad.
- Every "label" is a compact phrase of 2 to 9 words, never a sentence. Siblings are parallel in form, and no two nodes say the same thing.
- Every "note" carries the specific substance the video attaches to that node -- the number, the example, the reason, the mechanism -- in one sentence (two at most for main themes). A note never just restates its label; if a leaf's label already says everything, its note is "".
- Every node's "t" is the timestamp of the line where that idea is discussed, so clicking a node plays that exact moment. A theme's "t" is where its discussion begins.
- Keep each node's children in the order the video covers them.

Everything else:
- "stickies": 6 to 10 of them. These are the lines worth screenshotting -- a real quote, the moment something clicks, a warning, a number that lands. For kind "quote", stay close to what was actually said.
- "receipts": 6 to 12, ordered the way the video orders them. "detail" carries the actual substance -- someone who never watches the video should still learn something from it.
- "t_end" on each receipt is the timestamp of the line where that point is finished being made: usually 20 to 90 seconds after "t", landing at the end of a sentence. These clips get stitched together into a cut-down version of the video, so each one must make sense on its own.
- "moves": 3 to 5 things to go do in the real world afterwards. Concrete and specific to this video, never "reflect on the content".
- "shelf": every book, tool, product, app, person, paper or website the video actually names, 0 to 15 of them, in the order they come up. Use the name as it was said. If nothing is named, return [].
- "questions": 4 to 6 questions a curious viewer would ask that this transcript can actually answer -- specific to this video, max 14 words each. They become one-tap prompts for asking the video.
- Every "t" and "t_end" is a timestamp COPIED from the start of the transcript line the item comes from, exactly as written there without the brackets: "12:30", or "1:02:03" past the hour. Copy it character for character and never convert it to seconds. It seeks the video player, so it must point at the line where that thing is actually said.
- Base everything on what is actually said. Do not invent, assume, or generalise beyond the transcript.
- "mode_label", "stickies_label" and "receipts_label" can have personality. Everything else must stay accurate and useful -- it is what people came for.
- LANGUAGE: {language_line(lang, transcript_language)} Keep every JSON key, and the fixed values of "mode", "type", "kind" and "call", exactly as specified above, in English.
- Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


# Bump when the prompt's instructions change in a way that should retire
# cached canvases -- the schema text alone doesn't capture that.
CANVAS_PROMPT_VERSION = "3.1"

CANVAS_DIGEST = digest(CANVAS_SCHEMA, ARTIFACT_SPECS, CLAUDE_MODEL or "", CANVAS_PROMPT_VERSION)


# ------------------------------------------------------------------ canvas normalising

MINDMAP_MAX_DEPTH = 4       # levels below the root
MINDMAP_MAX_NODES = 180


def markdown_to_tree(markdown: str, fallback: str) -> dict:
    """Canvases from before the tree schema stored the map as a markdown outline."""
    root = None
    stack: list[tuple[int, dict]] = []
    heading_level = 0
    for line in str(markdown or "").splitlines():
        if not line.strip() or line.strip().startswith("```"):
            continue
        heading = re.match(r"^\s*(#{1,6})\s+(.*)$", line)
        bullet = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if heading:
            level = len(heading.group(1)) - 1
            label = heading.group(2)
            heading_level = level
        elif bullet:
            level = heading_level + 1 + len(bullet.group(1).replace("\t", "  ")) // 2
            label = bullet.group(2)
        else:
            continue
        label = re.sub(r"[*_`]+|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", label).strip()
        if not label:
            continue
        node = {"label": label, "t": None, "note": "", "children": []}
        if root is None:
            if level == 0:
                root = node
                stack = [(0, root)]
                continue
            root = {"label": fallback, "t": None, "note": "", "children": []}
            stack = [(0, root)]
        while len(stack) > 1 and stack[-1][0] >= level:
            stack.pop()
        stack[-1][1]["children"].append(node)
        stack.append((max(level, stack[-1][0] + 1), node))
    return root or {"label": fallback, "t": None, "note": "", "children": []}


def normalize_mindmap(raw, fallback_label: str, duration: int | None = None) -> dict | None:
    """The map as a clean tree: every node a label, a timestamp (or None), a note, and children."""
    if isinstance(raw, str):
        raw = markdown_to_tree(raw, fallback_label)
    if not isinstance(raw, dict):
        return None
    count = 0

    def walk(node, depth):
        nonlocal count
        if count >= MINDMAP_MAX_NODES:
            return None
        if isinstance(node, str):
            node = {"label": node}
        if not isinstance(node, dict):
            return None
        label = as_text(node.get("label") or node.get("title") or node.get("name"), 120)
        if not label:
            return None
        count += 1
        note = as_text(node.get("note"), 420)
        if note.lower().rstrip(".") == label.lower().rstrip("."):
            note = ""
        children = []
        if depth < MINDMAP_MAX_DEPTH:
            for child in as_list(node.get("children")):
                kid = walk(child, depth + 1)
                if kid:
                    children.append(kid)
        return {"label": label, "t": clamp_t(node.get("t"), duration), "note": note, "children": children}

    tree = walk(raw, 0)
    if tree is None:
        return None
    if tree["t"] is None:
        tree["t"] = 0
    return tree


def count_nodes(tree) -> int:
    if not isinstance(tree, dict):
        return 0
    return 1 + sum(count_nodes(c) for c in as_list(tree.get("children")))


def walk_tree(tree, depth: int = 0):
    if not isinstance(tree, dict):
        return
    yield tree, depth
    for child in as_list(tree.get("children")):
        yield from walk_tree(child, depth + 1)


def normalize_artifact(raw, duration: int | None = None) -> dict | None:
    """One mode-specific tool. Anything malformed becomes None, never a broken section."""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("type", "")).strip().lower()

    def t_of(value):
        return clamp_t(value, duration)

    if kind == "flashcards":
        cards = []
        for card in as_list(raw.get("cards")):
            if not isinstance(card, dict):
                continue
            q, a = as_text(card.get("q"), 220), as_text(card.get("a"), 600)
            if q and a:
                # A stable id, so reviews in the deck survive re-opening the canvas.
                cards.append({"id": short_hash(q), "q": q, "a": a, "t": t_of(card.get("t"))})
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
            steps.append({"text": text, "t": t_of(step.get("t")), "timer_seconds": timer})
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
                    out.append({"text": text, "t": t_of(item.get("t"))})
            return out[:8]

        breaker = raw.get("deal_breaker") if isinstance(raw.get("deal_breaker"), dict) else {}
        deal_breaker = None
        if as_text(breaker.get("text")):
            deal_breaker = {"text": as_text(breaker.get("text"), 300), "t": t_of(breaker.get("t"))}
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
                        "t": t_of(item.get("t")),
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
                        "t": t_of(item.get("t")),
                        "when": as_text(item.get("when"), 60),
                        "label": label,
                        "detail": as_text(item.get("detail"), 400),
                    }
                )
        return {"type": "timeline", "events": events[:20]} if events else None

    return None


def _norm_mode(value, ctx):
    mode = str(value or "").strip().lower()
    return mode if mode in KNOWN_MODES else DEFAULT_MODE


def _norm_summary(value, ctx):
    if isinstance(value, str):
        value = [p.strip() for p in value.split("\n\n") if p.strip()]
    return [as_text(p, 1200) for p in as_list(value) if as_text(p)]


def _norm_stickies(value, ctx):
    stickies = []
    for item in as_list(value):
        if not isinstance(item, dict):
            item = {"text": item}
        text = as_text(item.get("text"), 240)
        if not text:
            continue
        kind = str(item.get("kind", "")).strip().lower()
        if kind not in {"quote", "aha", "warning", "stat", "tip"}:
            kind = "aha"
        stickies.append({"kind": kind, "text": text, "t": clamp_t(item.get("t"), ctx.get("duration"))})
    return stickies


def _norm_receipts(value, ctx):
    receipts = []
    for item in as_list(value):
        if not isinstance(item, dict):
            item = {"title": item}
        title = as_text(item.get("title"), 160)
        if not title:
            continue
        t = clamp_t(item.get("t"), ctx.get("duration"))
        t_end = clamp_t(item.get("t_end"), ctx.get("duration"))
        if t_end is not None and (t is None or t_end <= t):
            t_end = None
        receipts.append({"title": title, "detail": as_text(item.get("detail"), 600), "t": t, "t_end": t_end})
    return receipts


def _norm_moves(value, ctx):
    moves = []
    for item in as_list(value):
        text = as_text(item.get("text") if isinstance(item, dict) else item, 200)
        if text:
            moves.append(text)
    return moves[:8]


def _norm_shelf(value, ctx):
    shelf, seen = [], set()
    for item in as_list(value):
        if not isinstance(item, dict):
            item = {"name": item}
        name = as_text(item.get("name"), 120)
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        kind = str(item.get("kind", "")).strip().lower()
        if kind not in SHELF_KINDS:
            kind = "other"
        shelf.append({"name": name, "kind": kind, "note": as_text(item.get("note"), 200), "t": clamp_t(item.get("t"), ctx.get("duration"))})
    return shelf[:20]


def _norm_questions(value, ctx):
    questions = []
    for item in as_list(value):
        text = as_text(item.get("q") if isinstance(item, dict) else item, 160)
        if not text:
            continue
        if not text.endswith(("?", "？")):
            text += "?"
        if text not in questions:
            questions.append(text)
    return questions[:8]


# Field by field, in the order Claude writes them -- the same normalisers run
# on each field as it streams in and on the whole canvas at the end.
CANVAS_FIELDS = {
    "mode": _norm_mode,
    "mode_label": lambda v, ctx: as_text(v, 40) or "Deep Dive",
    "headline": lambda v, ctx: as_text(v, 120) or ctx["title"],
    "tldr": lambda v, ctx: as_text(v, 300),
    "mindmap": lambda v, ctx: normalize_mindmap(v, ctx.get("headline") or ctx["title"], ctx.get("duration")),
    "artifact": lambda v, ctx: normalize_artifact(v, ctx.get("duration")),
    "stickies_label": lambda v, ctx: as_text(v, 40) or "The Wall",
    "stickies": _norm_stickies,
    "shelf": _norm_shelf,
    "summary": _norm_summary,
    "moves": _norm_moves,
    "questions": _norm_questions,
    "receipts_label": lambda v, ctx: as_text(v, 40) or "Key Findings",
    "receipts": _norm_receipts,
}

# Fields worth showing before they're finished: (key, only whole list items).
PARTIAL_FIELDS = {"mindmap": False, "stickies": True, "shelf": True, "summary": True, "receipts": True}


def normalize_canvas(data: dict, fallback_title: str, duration: int | None = None) -> dict:
    """
    Guarantee every key the frontend reads, with the right type. A model that
    skips a field, or hands back a string where a list belongs, should degrade
    into a thinner canvas -- never a broken page. Safe to run twice.
    """
    ctx = {"title": fallback_title, "duration": duration}
    out = {}
    for key, norm in CANVAS_FIELDS.items():
        out[key] = norm(data.get(key), ctx)
        if key == "headline":
            ctx["headline"] = out[key]
    out["schema_version"] = SCHEMA_VERSION
    return out


# ------------------------------------------------------------------ canvas cache

def canvas_cache_path(video_id: str, lang: str = DEFAULT_LANG) -> Path:
    # Prompt changes invalidate old canvases, so the schema and model are part
    # of the key rather than the video id alone. So is the language.
    return CACHE_DIR / f"{video_id}.{CANVAS_DIGEST}{lang_suffix(lang)}.json"


def canvas_files_by_video() -> dict[str, Path]:
    """The newest cached canvas for every video, whichever schema or language made it."""
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


def current_canvas_files(video_id: str) -> list[Path]:
    """This video's canvases made by the current schema, newest first -- one per language."""
    if not CACHE_DIR.exists():
        return []
    files = [p for p in CACHE_DIR.glob(f"{video_id}.{CANVAS_DIGEST}*.json") if not p.name.endswith(".tmp")]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def canvas_langs(video_id: str) -> list[str]:
    langs = []
    for path in current_canvas_files(video_id):
        parts = path.name.split(".")
        code = parts[2] if len(parts) == 4 else DEFAULT_LANG
        if code not in langs:
            langs.append(code)
    return langs


def upgrade_legacy(legacy: dict, path: Path) -> dict:
    """An older canvas, reshaped to today's fields and marked outdated."""
    payload = {**legacy, **normalize_canvas(legacy, legacy.get("title") or "Untitled video", legacy.get("duration"))}
    payload["schema_version"] = legacy.get("schema_version", 1)
    payload.setdefault("created_at", mtime_iso(path))
    payload.setdefault("lang", DEFAULT_LANG)
    payload["outdated"] = payload["schema_version"] < SCHEMA_VERSION
    return payload


def load_cached_canvas(video_id: str, lang: str | None = None) -> dict | None:
    """
    The canvas in the language asked for; failing that, the newest current one
    in any language; failing that, the newest older one, marked outdated.
    """
    exact = exact_canvas(video_id, lang) if lang else None
    if exact:
        return exact
    for path in current_canvas_files(video_id):
        data = read_json(path)
        if isinstance(data, dict):
            return {**data, "cached": True, "outdated": False, "langs": canvas_langs(video_id)}

    path = canvas_files_by_video().get(video_id)
    legacy = read_json(path) if path else None
    if not isinstance(legacy, dict):
        return None
    return {**upgrade_legacy(legacy, path), "cached": True, "langs": []}


def exact_canvas(video_id: str, lang: str) -> dict | None:
    data = read_json(canvas_cache_path(video_id, lang))
    if not isinstance(data, dict):
        return None
    return {**data, "cached": True, "outdated": False, "langs": canvas_langs(video_id)}


def canvas_work(job: Job, video_id: str, lang: str, force: bool) -> dict:
    """Make a canvas, streaming each section to the page as Claude writes it."""
    if not force and lang != "auto":
        cached = exact_canvas(video_id, lang)
        if cached:
            return cached

    job.set_stage("transcript")
    snippets, language_label, language_code = fetch_transcript(video_id)
    transcript, truncated = build_prompt_transcript(snippets)
    if not transcript.strip():
        raise TranscriptProblem("The transcript for this video came back empty.")
    job.check()

    # "Same as the video" only means something once we know what the video is in.
    resolved = resolve_lang(lang, language_code)
    if not force and resolved != lang:
        cached = exact_canvas(video_id, resolved)
        if cached:
            return cached
    lang = resolved

    title, channel = get_video_meta(video_id)
    duration = duration_of(snippets)
    job.title = title
    job.emit("meta", video_id=video_id, title=title, channel=channel, duration=duration,
             language=language_label, truncated=truncated, lang=lang)

    job.set_stage("reading")
    stream = TopLevelStream()
    ctx = {"title": title, "duration": duration}
    last_partial: dict[str, tuple[float, int]] = {}
    writing = False

    def on_text(piece: str):
        nonlocal writing
        if not writing:
            writing = True
            job.set_stage("writing")
        for key, value in stream.feed(piece):
            norm = CANVAS_FIELDS.get(key)
            if not norm:
                continue
            value = norm(value, ctx)
            if key == "headline":
                ctx["headline"] = value
            job.field(key, value)
        key, raw = stream.current()
        if key in PARTIAL_FIELDS and raw:
            now = time.monotonic()
            then, size = last_partial.get(key, (0.0, 0))
            if now - then >= 0.7 and len(raw) > size + 30:
                last_partial[key] = (now, len(raw))
                repaired = repair_json_prefix(raw, items_only=PARTIAL_FIELDS[key])
                if repaired:
                    value = CANVAS_FIELDS[key](repaired, ctx)
                    if value:
                        job.partial(key, value)
        job.progress(chars=len(stream.text), field=key)

    text = stream_claude(build_canvas_prompt(title, channel, transcript, truncated, lang, language_label), job, on_text)
    try:
        data = extract_json(text)
    except ClaudeProblem:
        if not stream.fields:
            raise
        data = stream.fields  # every field that did finish is still worth keeping
    if not isinstance(data, dict):
        raise ClaudeProblem("Claude returned JSON, but not an object. Try regenerating.", "bad_json")

    job.set_stage("saving")
    canvas = normalize_canvas(data, title, duration)
    if not canvas["receipts"] and not canvas["summary"] and not canvas["mindmap"]:
        raise ClaudeProblem("Claude came back empty-handed. Try regenerating.", "empty")

    payload = {
        **canvas,
        "video_id": video_id,
        "title": title,
        "channel": channel,
        "language": language_label,
        "lang": lang,
        "duration": duration,
        "truncated": truncated,
        "created_at": now_iso(),
    }
    write_json(canvas_cache_path(video_id, lang), payload)
    return {**payload, "cached": False, "outdated": False, "langs": canvas_langs(video_id)}


def delete_video(video_id: str) -> int:
    """Everything yapmap made from one video: canvases, voices, answers, transcript, reviews."""
    removed = 0
    targets = [
        *CACHE_DIR.glob(f"{video_id}.*.json"),
        *(CACHE_DIR / "voice").glob(f"{video_id}.*.json"),
        CACHE_DIR / "ask" / f"{video_id}.json",
        transcript_cache_path(video_id),
    ]
    for path in targets:
        try:
            if path.exists():
                path.unlink()
                removed += 1
        except OSError:
            pass
    with _data_lock:
        reviews = load_reviews()
        kept = {k: v for k, v in reviews.items() if not k.startswith(f"{video_id}:")}
        if len(kept) != len(reviews):
            write_json(REVIEWS_FILE, kept)
    return removed


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


def build_beef_prompt(a: dict, b: dict, lang: str = DEFAULT_LANG) -> str:
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
- LANGUAGE: {language_line(lang)} Keep every JSON key exactly as specified, in English.
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


def beef_cache_path(key: str, lang: str = DEFAULT_LANG) -> Path:
    return CACHE_DIR / "beef" / f"{key}.{BEEF_DIGEST}{lang_suffix(lang)}.json"


def cached_beef(a_id: str, b_id: str, lang: str) -> dict | None:
    key = "__".join(sorted([a_id, b_id]))
    cached = read_json(beef_cache_path(key, lang))
    if not isinstance(cached, dict):
        return None
    return {**(cached if cached["a"]["video_id"] == a_id else swap_beef(cached)), "cached": True}


def beef_work(job: Job, a_id: str, b_id: str, lang: str, force: bool) -> dict:
    if not force:
        cached = cached_beef(a_id, b_id, lang)
        if cached:
            return cached

    job.set_stage("transcript")
    sides = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {name: pool.submit(fetch_transcript, vid) for name, vid in (("A", a_id), ("B", b_id))}
        for name, vid in (("A", a_id), ("B", b_id)):
            try:
                snippets, language, _ = futures[name].result()
            except TranscriptProblem as exc:
                raise TranscriptProblem(f"Video {name}: {exc}", exc.status) from exc
            transcript, truncated = build_prompt_transcript(snippets, BEEF_TRANSCRIPT_CHARS)
            title, channel = get_video_meta(vid)
            sides[name] = {
                "video_id": vid, "title": title, "channel": channel, "language": language,
                "duration": duration_of(snippets), "transcript": transcript, "truncated": truncated,
            }
    job.check()

    def side(s):
        return {k: s[k] for k in ("video_id", "title", "channel", "language", "duration", "truncated")}

    job.title = f"{sides['A']['title']} vs {sides['B']['title']}"
    job.emit("meta", a=side(sides["A"]), b=side(sides["B"]), lang=lang)
    job.set_stage("reading")
    written = 0

    def on_text(piece):
        nonlocal written
        if job.stage != "writing":
            job.set_stage("writing")
        written += len(piece)
        job.progress(chars=written)

    beef = normalize_beef(extract_json(stream_claude(build_beef_prompt(sides["A"], sides["B"], lang), job, on_text)))
    if not (beef["clash"] or beef["agree"] or beef["verdict"]):
        raise ClaudeProblem("Claude came back empty-handed. Try again.", "empty")

    key = "__".join(sorted([a_id, b_id]))
    payload = {**beef, "key": key, "a": side(sides["A"]), "b": side(sides["B"]), "lang": lang, "created_at": now_iso()}
    write_json(beef_cache_path(key, lang), payload)
    return {**payload, "cached": False}


# ------------------------------------------------------------------ purge

PURGE_SCHEMA = """{
  "items": [
    {"n": 1, "verdict": "watch | skim | skip", "why": "one specific sentence -- name what is actually in it", "best_t": 754, "best_label": "what is at that moment, 3-8 words"}
  ],
  "summary_line": "one punchy line about the pile as a whole"
}"""

PURGE_DIGEST = digest(PURGE_SCHEMA, CLAUDE_MODEL or "", "purge-v1")


def build_purge_prompt(blocks: list[str], lang: str = DEFAULT_LANG) -> str:
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
- LANGUAGE: {language_line(lang)} Keep every JSON key, and the "verdict" values, exactly as specified, in English.
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


def purge_key(ids: list[str]) -> str:
    return hashlib.sha256(",".join(ids).encode()).hexdigest()[:12]


def purge_cache_path(key: str, lang: str = DEFAULT_LANG) -> Path:
    return CACHE_DIR / "purge" / f"{key}.{PURGE_DIGEST}{lang_suffix(lang)}.json"


def purge_work(job: Job, urls, lang: str, force: bool) -> dict:
    job.set_stage("links")
    ids, trimmed = expand_purge_input(urls)
    if not ids:
        raise PurgeProblem("Paste at least one YouTube link (one per line), or a playlist link.")
    key = purge_key(ids)
    path = purge_cache_path(key, lang)
    if not force:
        cached = read_json(path)
        if isinstance(cached, dict):
            return {**cached, "cached": True}

    job.set_stage("transcript", total=len(ids))
    done = 0
    lock = threading.Lock()

    def gather(video_id):
        nonlocal done
        title, channel = get_video_meta(video_id)
        row = {"video_id": video_id, "title": title, "channel": channel, "duration": 0}
        try:
            snippets, _, _ = fetch_transcript(video_id)
            row.update(snippets=snippets, duration=duration_of(snippets))
        except TranscriptProblem as exc:
            row["problem"] = str(exc)
        with lock:
            done += 1
            job.progress(force=True, done=done, total=len(ids))
        return row

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(gather, ids))
    job.check()

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
        job.set_stage("reading", total=len(usable))

        def on_text(piece):
            if job.stage != "writing":
                job.set_stage("writing")

        verdicts, summary_line = normalize_purge(extract_json(stream_claude(build_purge_prompt(blocks, lang), job, on_text)))

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
        "lang": lang,
        "created_at": now_iso(),
    }
    write_json(path, payload)
    return {**payload, "cached": False}


# ------------------------------------------------------------------ voices

def build_revoice_prompt(canvas: dict, voice: str) -> str:
    source = "\n\n".join([canvas.get("tldr") or "", *as_list(canvas.get("summary"))]).strip()
    lang = canvas.get("lang") or DEFAULT_LANG
    return f"""Here is a summary of a YouTube video called "{canvas.get("headline") or canvas.get("title")}".

SUMMARY
=======
{source}
=======

{VOICES[voice][1]}

Every fact, name and number must stay accurate -- only the voice changes. Don't add anything the summary doesn't say.
{language_line(lang, canvas.get("language") or "")}

Output JSON exactly like this: {{"lines": ["...", "..."]}} -- one entry per paragraph, or per message for a chat.
Output ONLY the JSON object. No preamble, no closing remarks, no code fences.
"""


def voice_cache_path(video_id: str, voice: str, canvas: dict) -> Path:
    source = "\n".join([canvas.get("tldr") or "", *as_list(canvas.get("summary"))])
    lang = canvas.get("lang") or DEFAULT_LANG
    extra = [] if lang == DEFAULT_LANG else [lang]
    return CACHE_DIR / "voice" / f"{video_id}.{voice}.{digest(source, VOICES[voice][1], CLAUDE_MODEL or '', *extra)}.json"


# ------------------------------------------------------------------ asking the video

STOPWORDS = set("""
a about above after again against all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each even few for from further get gets getting go going gonna got
had has have having he her here hers him his how i if in into is it its just kind know let like lot me more most my
no nor not now of off ok okay on once one only or other our out over own really right said same say says she should
so some such than that the their them then there these they thing things think this those through to too um uh
under until up us very was way we well were what when where which while who whom why will with would yeah you your
""".split())

TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def search_tokens(text: str) -> list[str]:
    out = []
    for word in TOKEN_RE.findall(text.lower()):
        if word in STOPWORDS or (len(word) < 2 and word.isascii()):
            continue
        # Fold simple plurals, so "rates" finds "rate".
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        out.append(word)
    return out


def bm25_scores(docs: list[list[str]], query: list[str], k1: float = 1.4, b: float = 0.75) -> list[float]:
    if not docs:
        return []
    avg = sum(len(d) for d in docs) / len(docs) or 1
    df = Counter()
    for doc in docs:
        df.update(set(doc))
    terms = set(query)
    scores = []
    for doc in docs:
        tf = Counter(doc)
        score = 0.0
        for term in terms:
            f = tf.get(term)
            if not f:
                continue
            idf = math.log(1 + (len(docs) - df[term] + 0.5) / (df[term] + 0.5))
            score += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * len(doc) / avg))
        scores.append(score)
    return scores


def retrieve_context(blocks: list[tuple[float, str]], question: str, budget: int = ASK_CONTEXT_CHARS) -> str:
    """
    The parts of a long transcript that best match a question, in time order,
    with a [...] wherever something was skipped. No match at all (a question
    in another language, say) falls back to an even spread across the video.
    """
    size, stride = 5, 3
    chunks = [(i, min(len(blocks), i + size)) for i in range(0, max(1, len(blocks) - size + stride), stride)]
    docs = [search_tokens(" ".join(text for _, text in blocks[a:b])) for a, b in chunks]
    scores = bm25_scores(docs, search_tokens(question))
    if not scores or max(scores) <= 0:
        step = max(1, len(chunks) // 8)
        order = list(range(0, len(chunks), step))
    else:
        order = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)

    picked: set[int] = set()
    used = 0
    for index in order:
        a, b = chunks[index]
        fresh = [i for i in range(a, b) if i not in picked]
        cost = sum(len(blocks[i][1]) + 12 for i in fresh)
        if used + cost > budget and picked:
            continue
        picked.update(fresh)
        used += cost
        if used >= budget:
            break

    lines, previous = [], None
    for i in sorted(picked):
        if previous is not None and i != previous + 1:
            lines.append("[...]")
        lines.append(block_line(*blocks[i]))
        previous = i
    return "\n".join(lines)


def mindmap_outline(tree, depth_limit: int = 2) -> str:
    lines = []
    for node, depth in walk_tree(tree):
        if 0 < depth <= depth_limit:
            lines.append("  " * (depth - 1) + "- " + node["label"])
    return "\n".join(lines)


def ask_history_path(video_id: str) -> Path:
    return CACHE_DIR / "ask" / f"{video_id}.json"


def load_ask_history(video_id: str) -> list[dict]:
    data = read_json(ask_history_path(video_id), [])
    return data if isinstance(data, list) else []


CITE_RE = re.compile(r"\[(\d{1,2}:\d{2}(?::\d{2})?)\]")


def build_ask_prompt(title: str, channel: str, canvas: dict | None, context: str, partial: bool,
                     history: list[dict], question: str, lang: str, transcript_language: str) -> str:
    orientation = ""
    if canvas:
        outline = mindmap_outline(canvas.get("mindmap"))
        orientation = (
            "What the video covers, for orientation only -- answer from the transcript, not from this:\n"
            f"{canvas.get('tldr') or ''}\n{outline}\n"
        )
    earlier = ""
    if history:
        turns = "\n\n".join(f"Q: {h.get('q', '')}\nA: {as_text(h.get('a'), 700)}" for h in history[-ASK_HISTORY_TURNS:])
        earlier = f"\nEarlier in this conversation:\n{turns}\n"
    scope = "the parts of the transcript that best match the question" if partial else "the full transcript"
    return f"""You are answering a question about a YouTube video, using its transcript.

Video: {title} -- {channel or "unknown channel"}
{orientation}
Below is {scope}. Every line starts with the timestamp it was spoken at, as [M:SS] or [H:MM:SS].

TRANSCRIPT
==========
{context}
==========
{earlier}
Question: {question}

How to answer:
- Answer from the transcript. After each claim, cite the moment it comes from by copying that line's timestamp in square brackets, like "They recommend resting it overnight [4:12]." Several claims from one moment can share a citation.
- Lead with the answer. Short paragraphs or a few "- " bullets; under 170 words unless the question truly needs more.
- If the video doesn't cover it, say so in one sentence, then give whatever it says that comes closest -- still cited.
- Plain text with light markdown only: paragraphs, "- " bullets, **bold**. No headings, tables or code fences.
- {language_line(lang, transcript_language)}
"""


def ask_work(job: Job, video_id: str, question: str, lang: str) -> dict:
    job.set_stage("transcript")
    snippets, language_label, language_code = fetch_transcript(video_id)
    blocks = transcript_blocks(snippets)
    if not blocks:
        raise TranscriptProblem("The transcript for this video came back empty.")
    canvas = load_cached_canvas(video_id)
    title, channel = (canvas.get("title"), canvas.get("channel")) if canvas else get_video_meta(video_id)
    if lang == "auto" or not lang:
        lang = (canvas or {}).get("lang") or DEFAULT_LANG
    lang = resolve_lang(lang, language_code)

    full = "\n".join(block_line(t, text) for t, text in blocks)
    partial = len(full) > ASK_FULL_TRANSCRIPT_CHARS
    context = retrieve_context(blocks, question) if partial else full
    history = load_ask_history(video_id)
    prompt = build_ask_prompt(title, channel, canvas, context, partial, history, question, lang, language_label)

    job.set_stage("reading")

    def on_text(piece):
        if job.stage != "writing":
            job.set_stage("writing")
        job.emit("delta", text=piece)

    answer = stream_claude(prompt, job, on_text)
    if not answer:
        raise ClaudeProblem("Claude came back empty-handed. Try asking again.", "empty")
    cited = sorted({as_seconds(m) for m in CITE_RE.findall(answer) if as_seconds(m) is not None})
    entry = {"id": uuid.uuid4().hex[:10], "q": question, "a": answer, "cited": cited, "lang": lang,
             "partial": partial, "at": now_iso()}
    with _data_lock:
        items = load_ask_history(video_id)
        items.append(entry)
        write_json(ask_history_path(video_id), items[-60:])
    log_event("ask", video_id)
    return entry


# ------------------------------------------------------------------ spaced repetition

def load_reviews() -> dict:
    data = read_json(REVIEWS_FILE, {})
    return data if isinstance(data, dict) else {}


def schedule_review(state: dict, grade: str, now: datetime) -> dict:
    """Leitner boxes: knowing a card moves it up a box (and further out); missing it starts it over."""
    box = int(state.get("box") or 0)
    lapses = int(state.get("lapses") or 0)
    if grade == "again":
        box, lapses = 0, lapses + 1
    else:
        box = min(len(SRS_INTERVALS) - 1, box + (2 if grade == "easy" else 1))
    days = SRS_INTERVALS[box]
    if days:
        # Due from the start of that day, so "due today" means any time today.
        due_at = (now + timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        due_at = now
    return {
        "box": box,
        "reps": int(state.get("reps") or 0) + 1,
        "lapses": lapses,
        "last": int(now.timestamp()),
        "due": int(due_at.timestamp()),
    }


def build_deck(canvases, reviews: dict, now_ts: int) -> dict:
    cards = []
    for video_id, canvas in canvases:
        art = canvas.get("artifact") if isinstance(canvas.get("artifact"), dict) else {}
        if art.get("type") != "flashcards":
            continue
        for card in as_list(art.get("cards")):
            if not isinstance(card, dict) or not card.get("q"):
                continue
            card_id = f"{video_id}:{card.get('id') or short_hash(card['q'])}"
            state = reviews.get(card_id) or {}
            cards.append({
                "id": card_id,
                "video_id": video_id,
                "headline": canvas.get("headline") or canvas.get("title") or "",
                "q": card["q"],
                "a": card.get("a") or "",
                "t": card.get("t"),
                "box": int(state.get("box") or 0),
                "reps": int(state.get("reps") or 0),
                "due": state.get("due"),
            })
    due = [c for c in cards if c["reps"] and (c["due"] or 0) <= now_ts]
    new = [c for c in cards if not c["reps"]]
    return {"cards": cards, "due": len(due), "new": len(new), "total": len(cards)}


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
    mindmap = canvas.get("mindmap")
    if isinstance(mindmap, str):
        mindmap = markdown_to_tree(mindmap, canvas.get("headline") or "")
    for node, depth in walk_tree(mindmap):
        if depth:
            add("map", " — ".join(x for x in (node.get("label"), node.get("note")) if x), node.get("t"))

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
    mindmap = canvas.get("mindmap")
    if isinstance(mindmap, str):
        mindmap = markdown_to_tree(mindmap, "")
    art = canvas.get("artifact") if isinstance(canvas.get("artifact"), dict) else {}
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
        "ideas": max(0, count_nodes(mindmap) - 1),
        "tool": art.get("type"),
        "lang": canvas.get("lang") or DEFAULT_LANG,
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


def log_event(kind: str, video_id: str | None = None, **extra) -> dict:
    event = {"type": kind, "video_id": video_id, "at": now_iso(), **extra}
    with _data_lock:
        events = load_list(EVENTS_FILE)[-4999:]
        events.append(event)
        write_json(EVENTS_FILE, events)
    return event


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
            "reviews": 0, "asks": 0,
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
        kind = e.get("type")
        if kind == "storycard":
            m["storycards"] += 1
        elif kind == "call":
            m["calls"] += 1
            m["nailed"] += e.get("grade") == "nailed"
        elif kind == "cut":
            m["cuts"] += 1
        elif kind == "review":
            m["reviews"] += 1
        elif kind == "ask":
            m["asks"] += 1

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
    return {
        "ok": True,
        "schema_version": SCHEMA_VERSION,
        "model": CLAUDE_MODEL,
        "languages": [{"code": code, "label": label} for code, (label, _) in LANGUAGES.items()],
    }


@app.get("/api/meta")
def api_meta():
    video_id = extract_video_id((request.args.get("url") or "").strip())
    if not video_id:
        return error("That doesn't look like a YouTube link.", 400)
    title, channel = get_video_meta(video_id)
    return {"video_id": video_id, "title": title, "channel": channel}


# ------------------------------------------------------------------ routes: jobs

@app.post("/api/jobs")
def api_jobs_start():
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    lang = clean_lang(data.get("lang"))
    force = bool(data.get("force"))

    if kind == "canvas":
        video_id = extract_video_id(str(data.get("url") or data.get("video_id") or "").strip())
        if not video_id:
            return error("That doesn't look like a YouTube link. Paste a normal one.", 400)
        job, created = start_job(
            "canvas", f"canvas:{video_id}:{lang}", {"video_id": video_id, "lang": lang, "force": force},
            lambda job: canvas_work(job, video_id, lang, force),
        )
    elif kind == "beef":
        a_id = extract_video_id(str(data.get("a") or "").strip())
        b_id = extract_video_id(str(data.get("b") or "").strip())
        if not a_id or not b_id:
            return error("Paste two YouTube links -- one for each corner.", 400)
        if a_id == b_id:
            return error("That's the same video twice. Beef needs two different videos.", 400)
        job, created = start_job(
            "beef", f"beef:{'__'.join(sorted([a_id, b_id]))}:{lang}", {"a": a_id, "b": b_id, "lang": lang},
            lambda job: beef_work(job, a_id, b_id, lang, force),
        )
    elif kind == "purge":
        urls = data.get("urls")
        if not str(urls or "").strip():
            return error("Paste at least one YouTube link (one per line), or a playlist link.", 400)
        key = hashlib.sha256(json.dumps(urls, sort_keys=True).encode()).hexdigest()[:12]
        job, created = start_job(
            "purge", f"purge:{key}:{lang}", {"lang": lang},
            lambda job: purge_work(job, urls, lang, force),
        )
    elif kind == "ask":
        video_id = extract_video_id(str(data.get("video_id") or "").strip())
        question = as_text(data.get("question"), 600)
        if not video_id:
            return error("Which video?", 400)
        if not question:
            return error("Ask it something first.", 400)
        ask_lang = str(data.get("lang") or "").strip().lower()
        ask_lang = ask_lang if ask_lang in LANGUAGES else ""
        job, created = start_job(
            "ask", f"ask:{video_id}:{short_hash(question)}", {"video_id": video_id, "title": question},
            lambda job: ask_work(job, video_id, question, ask_lang),
        )
    else:
        return error("Unknown kind of job.", 400)
    return {"job": job.summary(), "created": created}, 201 if created else 200


@app.get("/api/jobs")
def api_jobs_list():
    with _jobs_lock:
        prune_jobs()
        jobs = sorted(_jobs.values(), key=lambda j: j.created)
    return {"jobs": [j.summary() for j in jobs]}


@app.get("/api/jobs/<job_id>")
def api_job_get(job_id):
    job = _jobs.get(job_id)
    return job.summary() if job else error("That job isn't around any more.", 404)


@app.get("/api/jobs/<job_id>/events")
def api_job_events(job_id):
    job = _jobs.get(job_id)
    if not job:
        return error("That job isn't around any more -- the server may have restarted.", 404)
    try:
        after = int(request.headers.get("Last-Event-ID") or request.args.get("after") or 0)
    except ValueError:
        after = 0

    def events():
        yield "retry: 2500\n\n"
        yield from job.stream(after)

    return Response(events(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.delete("/api/jobs/<job_id>")
def api_job_cancel(job_id):
    job = _jobs.get(job_id)
    if not job:
        return error("That job isn't around any more.", 404)
    if job.status == "running":
        job.cancel()
    return job.summary()


# ------------------------------------------------------------------ routes: canvas

@app.get("/api/canvas/<video_id>")
def api_canvas_get(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id):
        return error("That isn't a video id.", 400)
    lang = request.args.get("lang")
    cached = load_cached_canvas(video_id, clean_lang(lang) if lang else None)
    return cached if cached else error("That video hasn't been mapped yet.", 404)


@app.delete("/api/canvas/<video_id>")
def api_canvas_delete(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id):
        return error("That isn't a video id.", 400)
    return {"deleted": delete_video(video_id)}


@app.get("/api/transcript/<video_id>")
def api_transcript(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id):
        return error("That isn't a video id.", 400)
    try:
        snippets, label, code = fetch_transcript(video_id)
    except TranscriptProblem as exc:
        return error(str(exc), exc.status)
    blocks = transcript_blocks(snippets, size=180)
    return {
        "video_id": video_id,
        "language": label,
        "language_code": code,
        "blocks": [{"t": round(t, 1), "text": text} for t, text in blocks],
    }


@app.post("/api/revoice")
def api_revoice():
    data = request.get_json(silent=True) or {}
    video_id = extract_video_id(str(data.get("video_id") or ""))
    voice = str(data.get("voice") or "")
    if not video_id:
        return error("Which video?", 400)
    if voice not in VOICES:
        return error("That voice doesn't exist.", 400)

    lang = data.get("lang")
    canvas = load_cached_canvas(video_id, clean_lang(lang) if lang else None)
    if not canvas:
        return error("Map this video first, then re-voice it.", 404)

    path = voice_cache_path(video_id, voice, canvas)
    cached = read_json(path)
    if isinstance(cached, dict):
        return cached

    try:
        raw = ask_claude(build_revoice_prompt(canvas, voice))
    except ClaudeProblem as exc:
        return error(str(exc), 502, code=exc.code)
    lines = [as_text(line, 700) for line in as_list(raw.get("lines")) if as_text(line)][:20]
    if not lines:
        return error("Claude didn't manage that voice. Try again.", 502)
    payload = {"video_id": video_id, "voice": voice, "label": VOICES[voice][0], "lines": lines,
               "lang": canvas.get("lang") or DEFAULT_LANG, "created_at": now_iso()}
    write_json(path, payload)
    return payload


# ------------------------------------------------------------------ routes: ask

@app.get("/api/ask/<video_id>")
def api_ask_history(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id):
        return error("That isn't a video id.", 400)
    return {"items": load_ask_history(video_id)}


@app.delete("/api/ask/<video_id>")
def api_ask_clear(video_id):
    if not VIDEO_ID_RE.fullmatch(video_id):
        return error("That isn't a video id.", 400)
    path = ask_history_path(video_id)
    try:
        if path.exists():
            path.unlink()
    except OSError:
        return error("Couldn't clear that -- is the cache folder writable?", 500)
    return {"items": []}


# ------------------------------------------------------------------ routes: beef + purge

@app.get("/api/beef/<a_id>/<b_id>")
def api_beef_get(a_id, b_id):
    if not (VIDEO_ID_RE.fullmatch(a_id) and VIDEO_ID_RE.fullmatch(b_id)):
        return error("Those aren't video ids.", 400)
    lang = clean_lang(request.args.get("lang"))
    cached = cached_beef(a_id, b_id, lang)
    return cached if cached else error("That beef hasn't happened yet.", 404)


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


# ------------------------------------------------------------------ routes: review deck

@app.get("/api/deck")
def api_deck():
    rows = [(vid, canvas) for vid, canvas, _ in all_canvases()]
    return build_deck(rows, load_reviews(), int(time.time()))


@app.post("/api/reviews")
def api_review():
    data = request.get_json(silent=True) or {}
    card_id = str(data.get("id") or "")
    grade = str(data.get("grade") or "")
    if not re.fullmatch(r"[0-9A-Za-z_-]{11}:[0-9a-f]{6,40}", card_id):
        return error("Which card?", 400)
    if grade not in REVIEW_GRADES:
        return error("Grade it again, good or easy.", 400)
    with _data_lock:
        reviews = load_reviews()
        state = schedule_review(reviews.get(card_id) or {}, grade, datetime.now().astimezone())
        reviews[card_id] = state
        if not write_json(REVIEWS_FILE, reviews):
            return error(f"Couldn't save that -- is {DATA_DIR} writable?", 500)
    log_event("review", card_id.split(":")[0], grade=grade)
    return {"id": card_id, **state}


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
    extra = {}
    if kind == "call" and data.get("grade") in CALL_GRADES:
        extra["grade"] = data["grade"]
    event = log_event(kind, extract_video_id(str(data.get("video_id") or "")) or None, **extra)
    return event, 201


if __name__ == "__main__":
    # threaded: the page keeps a live connection open to every job it's watching.
    app.run(debug=True, port=int(os.getenv("PORT", "5000")), threaded=True)
