# yapmap

**Turn the yap into a map.** Paste a YouTube link, get a canvas back: an interactive mindmap, a tool built for that kind of video, sticky notes for the good bits, a summary in any voice you like, and a **no-yap cut** — the real video, with everything between the good parts cut out.

Runs on your own machine. Uses your **Claude subscription** through the Claude Code CLI, so there's **no API key and no per-token billing**.

**[Try the live demo →](https://neilk2162.github.io/yapmap/)** Real canvases for five Creative Commons videos, one of each kind. No install, nothing to sign into.

![The yapmap landing page: a large gradient "make it make sense." headline, a one-line pitch, and a link box beside the "make it make sense" button](docs/screenshots/landing.webp)

---

## Don't skip the video. Skip the yap.

Summarisers try to replace the video: read this, so you don't have to watch. yapmap goes the other way. It makes the video itself navigable — before you watch, while you watch, and after — and every single thing it produces is a doorway back to the exact second it came from.

## The canvas

One link in:

| | |
|---|---|
| **▶ the no-yap cut** | The moments that matter, played back to back in the real YouTube player — *"13 min → 7 min"*. It goes through YouTube's own player, so the creator still gets the view. |
| **the map** | The whole video as a tree you can pan, zoom, fold and take fullscreen. |
| **the tool** | Something built for *this kind* of video — flashcards, a cook-along, a buy/skip card, claims to check, or a timeline. See below. |
| **the wall** | Sticky notes for the lines worth screenshotting. Drag them around, or turn one into a 1080×1920 story card in a tap. |
| **the shelf** | Every book, tool, person and paper the video name-drops, with the second they said it and a link to look it up. |
| **the download** | A real summary — straight, or re-voiced as a group chat, a sports commentator, full brainrot, or like-I'm-five. |
| **touch grass protocol** | Concrete things to go and do. Pin one, and yapmap asks you days later whether you actually did it. |
| **receipts** | The key findings. Tick the ones that matter and export them as Markdown. |

While a canvas generates you can **call it**: guess the big idea first, then see how close you got. Guessing before you learn — even guessing wrong — improves what you remember; learning research calls it the pretesting effect.

Every timestamp is clickable. It plays that moment in a mini player, and it survives into every export as a deep link.

### A tool for every kind of video

Claude first works out what kind of video it is, then builds the tool to match — and names every section itself.

| Mode | Fits | The tool |
|---|---|---|
| `study` | lectures, tutorials, explainers | **cram deck** — flashcards whose answer side plays the creator explaining it. Exports to Anki. |
| `howto` | recipes, builds, walkthroughs | **cook-along** — a pantry checklist that becomes your shopping list, step timers, and a hands-free mode. The no-yap cut plays each step being done. |
| `verdict` | reviews, comparisons, buying guides | **buy/skip card** — the reviewer's call, who it's for, who should skip, and the deal-breaker. |
| `yap` | podcasts, interviews, commentary | **claims to check** — every checkable claim, who made it, how to verify it, and a place to mark what holds up. |
| `story` | documentaries, video essays, news | **timeline** — scrub it to jump, and it follows the video as it plays. |

Real examples: a bread recipe came back as a **Bread Baking Session** with **Baker's Tricks**; a laptop review as a **Featherweight Verdict** with **The Evidence**; a science podcast as an **Ethics Interview** with claims attributed to its guest.

## The toolkit

Everything else lives in the tabs along the top.

| Tab | What it does |
|---|---|
| **beef** | Two videos, one ring. Where they genuinely clash — each side's receipt, playable — where they agree, and what only one of them covers. |
| **purge** | Paste up to 12 links, or a playlist. Get *watch / skim / skip* for each, the best moment, and the hours you'd save. |
| **library** | Every canvas you've ever made, searchable all at once. Every result is a timestamp that plays the moment. |
| **grass** | Your commitments and your follow-through streak — a streak for things you *did*, not things you watched. |
| **wrapped** | Your month: yap skipped, what kind of watcher you were, the line that hit hardest. Downloads as a story. |
| **extras** | The one-click "map this" bookmark for YouTube, the theme switch, keyboard shortcuts, and where your data lives. |

Light mode and dark mode are both first-class, and follow your device until you pick one.

### See it

**The canvas** — the video comes back retitled, with a one-line TL;DR, its channel and runtime, and a mode picked for it (here, *Career Masterclass*).

![A yapmap canvas for a 51-minute interview: a rewritten headline, a one-line TL;DR, channel and runtime pills, and the start of the mindmap](docs/screenshots/canvas.webp)

**The map** — the whole video as a tree. Fold what you already know, drag, zoom, go fullscreen.

![Mindmap of the interview: a root node branching into sections such as the rare skillset, building and proving the system, selling the engagement, and a 30-day plan broken into weekly steps](docs/screenshots/map.webp)

**The wall** — the lines worth screenshotting, each tagged by kind and linked to its timestamp.

![Nine colour-coded sticky notes labelled "they said it", "the number", "heads up", "steal this" and "oh, that's why", each with a play-button timestamp](docs/screenshots/wall.webp)

**The download** — a real summary, in paragraphs.

![A two-column prose summary of the interview with a drop cap](docs/screenshots/summary.webp)

**Touch grass protocol and receipts** — what to go and do, then the findings you tick and export.

![A checklist of five real-world next steps, followed by the findings section with select-all, copy and download controls](docs/screenshots/next-moves-and-findings.webp)

---

## Setup

You need **Python 3.10+**, **Node 18+**, and a **Claude subscription** (Pro or Max).

**1. Install the Claude Code CLI and sign in**

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude auth login
```

That opens a browser — sign in with the account your subscription is on. Then confirm:

```bash
claude auth status
```

You want to see `"loggedIn": true` and your `subscriptionType`. If you have an `ANTHROPIC_API_KEY` set in that shell from another project, **unset it** — it takes priority over the subscription login and will bill you per token.

**2. Install the Python dependencies**

```bash
pip install -r requirements.txt
```

**3. Run it**

```bash
python app.py
```

Open **http://localhost:5000**, paste a link, hit *make it make sense*.

A new canvas takes roughly one to two minutes depending on video length. After that it's cached locally, so reopening it is instant — and so is everything in the library.

**Optional: the one-click button.** Open the *extras* tab and drag *🗺️ map this* to your bookmarks bar. On any YouTube video, click it and the video opens straight in yapmap.

---

## Config

All optional, all environment variables:

| Variable | Default | Does what |
|---|---|---|
| `CLAUDE_MODEL` | `sonnet` | Swap the model: `opus`, `haiku`, or a full model name |
| `CLAUDE_BIN` | `claude` | Full path to the CLI if it isn't on `PATH` |
| `CLAUDE_TIMEOUT_SECONDS` | `600` | Raise it for very long videos, or big beefs |
| `YAPMAP_CACHE_DIR` | `.cache` | Where canvases, beefs, purges and voices are cached |
| `YAPMAP_DATA_DIR` | `.yapmap` | Your commitments and Wrapped activity — kept apart, so clearing the cache never wipes your streak |
| `PORT` | `5000` | Port to serve on |

Want more or less detail in the output? It's all one prompt — `build_canvas_prompt()` in [`app.py`](app.py). Change the rules, bump `CANVAS_PROMPT_VERSION`, and regenerate.

---

## Fonts

Three faces, no setup required:

| Face | Where | How it loads |
|---|---|---|
| **Luckiest Guy** | wordmark, hero, section titles, headlines, buttons | self-hosted from `static/fonts/`, bundled in this repo |
| **Space Grotesk** | body copy, summaries, finding details | Google Fonts |
| **JetBrains Mono** | timestamps, pills, small caps chrome | Google Fonts |

Luckiest Guy is by Brian J. Bonislawsky (Astigmatic) and is licensed under the **Apache License 2.0**, which permits redistribution — so it ships with the repo and its licence sits beside it at [`static/fonts/LuckiestGuy-LICENSE.txt`](static/fonts/LuckiestGuy-LICENSE.txt). Self-hosting means the display layer works offline and never flashes an unstyled headline.

It only covers Latin, so arrows and ticks (`↓ ▶ ✓ ✦`) fall back per glyph, which is intended. If the file ever goes missing the whole display layer falls back to Space Grotesk and the page still looks right.

**Swapping it out:** drop a new file in `static/fonts/`, update the `@font-face` block at the top of [`templates/index.html`](templates/index.html), and check the new font's licence first — a public repo redistributes everything committed to it, and most display fonts are not licensed for that.

---

## Troubleshooting

**`[WinError 2] The system cannot find the file specified`**
Python couldn't launch the CLI. On Windows `npm install -g` creates a `claude.cmd` shim, and `CreateProcess` only tries appending `.exe` — so the bare name `claude` doesn't resolve even though it works fine in your shell. `app.py` handles this by resolving the full path with `shutil.which()` first. If it comes back, check that `where claude` finds it, or set `CLAUDE_BIN` to the full path of `claude.cmd`.

**`Couldn't find the Claude Code CLI on your PATH`**
`where claude` / `which claude` returns nothing. Reinstall it, or set `CLAUDE_BIN`.

**"Captions are switched off for this video"**
yapmap reads transcripts, not audio. No captions, no canvas — there's no way around that short of running speech-to-text yourself.

**It asks about billing or an API key**
Run `claude auth status`. If it shows an API-key setup rather than your subscription, run `claude auth login` and unset `ANTHROPIC_API_KEY` in that shell.

**The mindmap area is blank**
It loads d3 and markmap from a CDN. Check your connection and refresh — the rest of the canvas works without them.

**A timestamp opens YouTube in a new tab instead of playing in the page**
That creator has switched off embedding, or YouTube's player script was blocked (an ad blocker can do it). yapmap falls back to opening the moment on YouTube.

**The purge says a playlist needs yt-dlp**
It's in `requirements.txt`, so `pip install -r requirements.txt` again. Or skip it and paste the video links one per line.

---

## How it works

```
YouTube link
   └─ youtube-transcript-api  →  timestamped transcript blocks
        └─ claude -p (stdin)  →  one JSON canvas (or beef, purge, voice)
             └─ Flask  →  a single-page app: static/js/, one ES module per tool
```

No build step and no framework. The frontend is plain ES modules in [`static/js/`](static/js/) — one per tool under `views/` — with hash routing, so the exact same files run under Flask and as the static demo.

The transcript is chunked into ~220-character blocks, each tagged with the second it was spoken at. That's what lets Claude cite a moment rather than just paraphrase, and it's what makes every timestamp in the UI land in the right place.

The prompt goes to the CLI over **stdin**, never as a command-line argument — on Windows the `.cmd` shim routes the command line through `cmd.exe`, which truncates it at the first newline and would read quotes, `&` and `%VAR%` in transcript text as shell syntax.

Responses are normalised before they reach the browser: a model that skips a field, or returns a string where a list belongs, degrades into a thinner canvas rather than a broken page. Canvases from an older version of the prompt still open — the page says what's missing and offers to regenerate.

### The demo gallery

[The live demo](https://neilk2162.github.io/yapmap/) is this same app with no server. It notices there's no `/api` and reads pre-built results from [`demo/`](demo/) instead; everything works except making new ones. A [GitHub Actions workflow](.github/workflows/pages.yml) publishes it on every push to `main`.

`demo/` is written by [`export_demo.py`](export_demo.py) from an explicit allowlist, so nothing else in your cache can be published by accident. Every video in it is **Creative Commons Attribution (CC BY)** licensed on YouTube, and each demo canvas credits its creator and links to the original. To change what's in it, generate the canvases locally, edit the allowlist, then run:

```bash
python export_demo.py
```

---

## Notes and limits

- **Captions required.** Manual or auto-generated, any language — non-English videos work, the canvas just comes back in that language's terms.
- **Very long videos get trimmed.** Transcripts are capped at ~120k characters (a few hours of speech). Past that the canvas covers what fits, and says so on the page.
- **Subscription usage is a real budget.** Each canvas, beef or purge is one substantial Claude call; a re-voice is a small one. Everything is cached on disk, and regenerating is always opt-in.
- **Your data stays put.** Canvases live in `.cache/`, commitments and Wrapped activity in `.yapmap/`. Both are gitignored. The only thing that leaves your machine is the transcript going to Claude, through the CLI you're signed into.
- **This is a local dev server.** Flask's built-in one, with `debug=True`. Fine on your own machine, not meant to be exposed to the internet as-is.
- **Not affiliated with YouTube or Anthropic.** It reads public transcripts and shells out to a CLI you're already logged into.

## License

MIT — see [LICENSE](LICENSE).

The bundled font is separate: **Luckiest Guy** is Apache 2.0, and its licence travels with it in [`static/fonts/`](static/fonts/).
