# 04 — Playback & sources

Status: Implemented

## Local files
- Scanned recursively from `MUSIC_DIR` (default `./music`). Extensions: mp3, m4a, flac, wav, ogg, opus, aac, webm. Dot-files are ignored.
- Metadata from tags (`music-metadata`). Fallback: filename `Artist - Title.ext`.
- Uploads keep the original filename, with unsafe characters (`/\:*?"<>|` and control characters) replaced by `_`.

### Karaoke mode decision (local)
| Stems ready? | What plays | Vocal cut | Guide slider | Scoring |
|---|---|---|---|---|
| Yes | `instrumental` + `vocals` (guide, gain = slider) | 0 | active | yes |
| No | `original` | `cut` slider (default 100 %) | inactive | pitch-only |
| Original mode | `original` | 0 | inactive | pitch-only |

If stems finish while their song is playing in karaoke mode, the host MUST switch to them at the same position without stopping.

The guide element is kept in sync with the music element: resync on play/seek, and whenever drift > 50 ms (checked every 500 ms).

### Demucs jobs
Command detection order: `$DEMUCS_CMD`, `demucs`, `python3 -m demucs`, `python -m demucs`, `py -m demucs` (each probed with `--help`, 20 s timeout). Invocation:
```
<cmd> --two-stems=vocals --mp3 --mp3-bitrate 256 -o .data/stems/<id> --filename "{stem}.{ext}" <file>
```
Outputs are found by searching `.data/stems/<id>/` for `no_vocals.*` and `vocals.*`. Jobs run one at a time, FIFO. Progress is parsed from tqdm's `NN%|` and broadcast at most once per second.

## Spotify
- Auth: Authorization Code + PKCE (no client secret). Scopes: `streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state`. The refresh token is stored in `.data/config.json`.
- Requirements, as of the February 2026 developer-mode rules: the app owner needs Premium, at most 5 allow-listed users, search capped at 10 results.
- Playback: Web Playback SDK device "Karaoke Host" in the host browser. `PUT /me/player/play?device_id=…` with a single URI. On 404, transfer to the device first and retry.
- End of track is detected when the SDK reports a different track (autoplay/relinking aware), or when paused at position 0 after being within 4 s of the end. Ignored for the first 3 s after starting.

### Karaoke-version finder
Spotify audio is DRM-protected and can't be processed. Instead, for `mode:'karaoke'`:
1. Queries: `"<title> karaoke"`, `"<title> <artist> karaoke"`, `"<title> instrumental"`, `"<title> <artist> instrumental"` (title/artist normalised: lowercase, accents and brackets removed).
2. Keep a candidate only if the normalised titles contain each other **and** "karaoke" or "instrumental" appears in the title, album or artist.
3. Score: +4 karaoke, +3 instrumental, +2 "originally performed / in the style of / made famous" or the original artist mentioned, −2 backing/guide vocal/demo, −10 a cappella, duration diff < 8 s +3, < 20 s +1.5, < 45 s 0, else −2.
4. Play the best one. The host offers **Try another** to cycle through the top 8. If nothing qualifies, play the original and say so.

Lyrics are always fetched for the **original** title/artist/duration.

Not available for Spotify: spectral removal, key change, speed, reference pitch/scoring (pitch lane still shows singers).

## YouTube
See [08 — YouTube](08-youtube.md). In short: official embedded player, original audio only, search via the Data API (optional key, about 100 searches a day, cached 24 h), pasted links via oEmbed with no key.

## Lyrics
- Source: LRCLIB (`LRCLIB_BASE` overrides the URL, for tests). First `/api/get` with artist, cleaned title, album and duration; if that has no synced lyrics, `/api/search` picks the synced result closest in duration.
- Title cleaning removes bracketed `remaster|version|live|edit|mono|stereo|feat` and ` - … remaster…` suffixes.
- Cached in memory per `artist|title` (hits only).
- Rendering: the line index is the last line with `t ≤ position + offset`. Shown: previous, **current** (wipe highlight), next, next+1. The wipe duration is `min(gap to next line, max(1.2 s, 0.075 s × characters))`. A countdown (●●●) appears in the last 3 s before the first line. Empty lines show ♪.
- Offset adjustable in 0.25 s steps per song (reset each song).
- Plain lyrics (no timing) scroll proportionally to song progress.

## Queue & transitions
- Songs end → after-song report (if any singer has data) with a 25 s countdown, otherwise a 5 s "Up next" card. **Start now**, **Wait** and **Close** controls.
- Skip during a countdown starts the next song immediately.
