# Transcribing YouTube Videos

How Mien gets a usable transcript out of a YouTube video so the **Quick Summary**
and **Deep Summary** buttons (Finance → News panel) have something real to
summarize — and what to do when it says it "can't find a transcript."

> Companion doc: [`youtube-summary-pipeline.md`](./youtube-summary-pipeline.md)
> covers the full discovery → transcript → summary → DB flow and manual injection.
> This doc focuses specifically on the **transcript-acquisition** step, which is
> the bottleneck.

## TL;DR

- Transcript fetch is a **cascade**: YouTube captions → InnerTube ANDROID player
  → **yt-dlp subtitles** → yt-dlp audio + Whisper → metadata only.
- The caption/InnerTube paths are increasingly **bot-walled** (they return a
  caption *track* but an empty caption *body*), so **`yt-dlp` is the reliable
  path** in practice.
- `yt-dlp` must be **resolvable from the Electron process**. It can be a binary on
  `PATH` *or* the Python module `python -m yt_dlp`. The app now probes for both.
- If you see "can't find transcript", it almost always means **yt-dlp isn't
  installed / isn't resolvable**. Fix: `pip install yt-dlp`.

## The cascade (what the app tries, in order)

Implemented in `src/main/services/finance/video-transcript.service.ts`
(`getVideoContext`). First stage that returns text wins; the result is cached to
`news_articles.content_context` + the `transcript_*` columns.

| # | Stage | Code | Needs | Status written |
|---|-------|------|-------|----------------|
| 1 | YouTube captions (watch-page `ytInitialPlayerResponse`) | `fetchYouTubeCaptionTranscript` | nothing | `captions` |
| 2 | InnerTube **ANDROID** player endpoint (reuses page `INNERTUBE_API_KEY`) | same fn, fallback branch | nothing | `captions` |
| 3 | **yt-dlp subtitles** (`--write-subs --write-auto-subs`, json3/vtt) | `fetchYtDlpSubtitles` | `yt-dlp` | `yt_dlp_subtitles` |
| 4 | yt-dlp audio download → Whisper transcription | `fetchAudioTranscript` | `yt-dlp` + `ffmpeg` + `whisper`/`faster-whisper` | `partial_/full_audio_transcript` |
| 5 | Nothing worked | — | — | `metadata_only` (had a description) or `failed` |

Quick mode caps context at **24k chars**; deep mode at **60k chars**. Quick mode
also only samples audio (first 4 min + middle + last) when it reaches stage 4;
deep mode transcribes the full audio.

### Why stages 1–2 fail so often now

YouTube serves the caption *track list* (you can see `('en', 'asr')` tracks) but
the `baseUrl` for the actual caption file returns an **empty body** without a
valid proof-of-origin token / correct client context. Both `json3` and `srv3`
formats come back empty. This is the "bot wall." `yt-dlp` handles the current
client handshakes, so stage 3 is what actually delivers text.

## Dependencies

| Tool | Required for | Install | Notes |
|------|-------------|---------|-------|
| **yt-dlp** | stages 3 + 4 (the working path) | `pip install yt-dlp` | Standalone binary *or* `python -m yt_dlp`. Keep it current — `pip install -U yt-dlp`; YouTube breaks old versions. |
| **ffmpeg** | stage 4 audio extraction only | [ffmpeg.org](https://ffmpeg.org) / `choco install ffmpeg` | Not needed for subtitles (stage 3). |
| **whisper** or **faster-whisper** | stage 4 only | `pip install faster-whisper` (or `openai-whisper`) | Only needed for videos with **no captions at all**. |

**Subtitles (stage 3) need only yt-dlp — no ffmpeg, no Whisper.** Most finance
channels have auto-captions, so stage 3 covers the large majority of videos.

### Tool resolution (important on Windows / packaged app)

Electron's `PATH` is often narrower than your dev shell, so a bare
`yt-dlp` command can fail with `ENOENT` even when it works in a terminal. The
service probes these candidates and caches the first that responds to
`--version`:

```
$MIEN_YTDLP_PATH   (env override, if set)
yt-dlp             (PATH binary)
yt-dlp.exe
python -m yt_dlp   (pip module form)  ← typical winner on this machine
py -m yt_dlp
python3 -m yt_dlp
```

Whisper resolves `MIEN_WHISPER_PATH` → `faster-whisper` → `whisper`.

**Env overrides** (set in the shell that launches the app, e.g. `launch.vbs`):

- `MIEN_YTDLP_PATH` — absolute path to a yt-dlp binary if it lives somewhere odd.
- `MIEN_WHISPER_PATH` — absolute path to a whisper CLI.
- `MIEN_WHISPER_MODEL` — Whisper model (default `base` quick / `small` deep).

## Troubleshooting: "can't find transcript"

That message is the LLM telling you it got **no transcript** — the cascade fell
through to `metadata_only`/`failed`. Work down this list:

1. **Is yt-dlp installed and resolvable?**
   ```powershell
   python -m yt_dlp --version   # should print e.g. 2026.03.17
   ```
   If not: `pip install -U yt-dlp`. (On this machine yt-dlp is **not** a `PATH`
   binary — it only works as `python -m yt_dlp`, which the resolver handles.)

2. **Check the app logs.** The service now logs the failing stage instead of
   swallowing it. Look for lines like:
   - `[transcript] yt-dlp not found. Tried PATH and python -m yt_dlp...`
   - `[transcript] yt-dlp subtitles failed: <reason>`
   - `[transcript] no transcript for <url> (status=...)`

3. **Does the video actually have captions?** Some do not. Then you need stage 4
   (ffmpeg + Whisper). If those aren't installed, there is no transcript to get —
   the summary will fall back to title + description + web search.

4. **Stale yt-dlp.** YouTube changes break old yt-dlp builds frequently. Update:
   `pip install -U yt-dlp`.

5. **Cached failure.** Once a row is marked `metadata_only`, quick mode reuses the
   cache. Re-running **Deep Summary** re-attempts the cascade; or clear the row's
   `content_context`/`transcript_status` in the DB to force a fresh fetch.

## Manual transcript fetch (outside the app)

When you want a transcript without launching Electron (e.g. to hand-inject a
summary — see `youtube-summary-pipeline.md`), use yt-dlp directly. This is exactly
what the app's stage 3 does:

```powershell
# json3 is the cleanest (no interleaved timestamps)
python -m yt_dlp --skip-download --write-auto-subs --write-subs `
  --sub-langs "en.*,en" --sub-format "json3/vtt/srt/best" `
  --output "%TEMP%\sub.%(ext)s" "https://www.youtube.com/watch?v=VIDEO_ID"
```

Then flatten the json3 to plain text (events → segs → utf8):

```python
import json, re
d = json.load(open(r"%TEMP%\sub.en.json3", encoding="utf-8"))
text = re.sub(r"\s+", " ",
    "".join(seg.get("utf8","") for ev in d.get("events",[]) for seg in ev.get("segs",[]))
).strip()
print(len(text.split()), "words")
```

A standalone helper that mirrors the app's caption-then-yt-dlp logic lives at
`scripts/fetch_yt_transcript.py`.

## Gotchas

- **InnerTube can return tracks but no body** — don't trust "found a caption
  track" as "got a transcript." Always verify non-empty text; the app does.
- **json3 ≠ VTT.** The subtitle reader parses `.json3` as JSON (events/segs) and
  only runs the VTT/SRT line-stripper on `.vtt`/`.srt`. Keep json3 first in
  `--sub-format` for the cleanest text.
- **ffmpeg is only for audio.** Missing ffmpeg disables stage 4 but not stage 3.
- **Mobile mirrors this** in `mobile/src/services/youtube-transcript.service.ts`
  but has no yt-dlp/Whisper — it relies on captions only, so it's more often
  caption-blocked than desktop.
- **Keep yt-dlp updated.** It is the single most common cause of sudden
  transcript breakage.
