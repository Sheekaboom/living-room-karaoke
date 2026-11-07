# 08 — YouTube

Status: Implemented
Related: [02 Protocol](02-protocol.md), [04 Playback & sources](04-playback-and-sources.md)

## Problem
Lots of songs aren't in a local library or on Spotify, and YouTube has a huge catalogue of ready-made karaoke videos (vocals removed, lyrics on screen). Hosts want to queue them like any other song.

## Goals / non-goals
- Goal: search YouTube, or paste a link, from the host or any phone, and play the video on the big screen with phone mics mixed in.
- Goal: work with **zero setup** for pasted links, and stay within the free API quota for search.
- Non-goal: downloading or extracting YouTube audio (against YouTube's Terms of Service). So no vocal removal, key change, scoring or Demucs for YouTube.
- Non-goal: YouTube accounts, playlists or sign-in.

## User experience
- **Host:** a *YouTube* tab with a search box (runs on Enter or the Search button), a "Karaoke versions only" checkbox (on by default), a singer picker and results with an **Add** button. Pasting a link resolves it straight away.
- **Phone:** a third source, *YouTube*, in the song search card, with the same checkbox. Typing doesn't search; Enter or the Search button does. Pasting a link resolves it immediately.
- **Stage:** the video fills the lyrics area. If the title looks like a karaoke video, the lyrics overlay starts hidden (the lyrics are already in the video); otherwise synced lyrics from LRCLIB are overlaid at the bottom (current + next line). If no synced lyrics are found, the overlay is removed. "Hide/Show lyrics overlay" toggles it.
- **Phones** still get the lyric feed whenever synced lyrics were found, even when the overlay is hidden.
- **Transport:** play/pause, restart, skip, seek bar, loop line and speed all work. Speed snaps to the nearest rate the player offers (typically 0.25 steps, so 80 % → 75 %).
- **Setup:** an optional API key field with instructions, and a usage counter ("N of ~100 searches used today").

## Design

### Playback
Official **YouTube IFrame Player API** (`https://www.youtube.com/iframe_api`), loaded only when the first YouTube item plays. There's one player instance, reused with `loadVideoById`. Player vars: `autoplay=1, controls=0, disablekb=1, rel=0, playsinline=1, iv_load_policy=3, fs=0, origin=<host origin>`.

| Host function | YouTube call |
|---|---|
| position / duration | `getCurrentTime()` / `getDuration()` (falls back to item duration) |
| isPlaying | `getPlayerState() === 1` |
| play/pause | `playVideo()` / `pauseVideo()` |
| seek, loop | `seekTo(sec, true)` |
| volume | `setVolume(round(min(1, musicVol) × 100))` |
| speed | `setPlaybackRate(closest of getAvailablePlaybackRates())` |
| stop | `stopVideo()`, rate reset to 1, video hidden |

The audio is inside YouTube's cross-origin iframe and never enters the Web Audio graph. Mic mixing, effects and the singer pitch lane still work; reference pitch, scores and key suggestions don't. Reports are pitch-only (range, steadiness, tuning centre).

**End of video:** state `0` (ENDED), only after the video has reached state `1` at least once, triggers `songEnded()`.

**Errors** (`onError`) show a message and skip, using the normal up-next flow:

| Code | Message |
|---|---|
| 2 | invalid ID |
| 5 | can't play in this browser |
| 100 | removed or private |
| 101, 150 | the owner blocks embedding |
| 153 | missing referrer. Open the host at http://127.0.0.1 |

The host page MUST NOT set `Referrer-Policy: no-referrer`; YouTube embeds need the referrer.

### Search & link resolution (server)
- `GET /api/youtube/search?q&karaoke=0|1` → `{results, cached?, link?}`
  - If `q` looks like a link or a bare ID (`looksLikeYouTubeLink`), resolve it instead and return `{results:[one], link:true}`.
  - If karaoke=1 and the query has neither "karaoke" nor "instrumental", append " karaoke".
  - Cache key = normalised query. Results are cached for **24 h** in `.data/youtube-cache.json` (at most 300 entries). Cache hits cost no quota.
  - Without a key: 400 `{error, needsKey:true}`.
  - Calls `search.list` (`part=snippet, type=video, videoEmbeddable=true, maxResults=15`), then one `videos.list` (`part=snippet,contentDetails,status`) for durations and the embeddable flag. Videos with `status.embeddable === false` are dropped.
  - Each `search.list` call increments `config.ytQuota = {day: <Pacific date>, searches}`. The default allowance is about 100 search calls a day per Google Cloud project, resetting at midnight Pacific.
  - Error mapping: quota exceeded → 429 with "daily limit… paste links instead"; invalid key → "check it in Setup".
- `GET /api/youtube/resolve?url=` → one track. With a key, use `videos.list` (1 unit, includes duration and embeddable). Without a key, use **oEmbed** (`https://www.youtube.com/oembed?url=…&format=json`, no key, no quota; duration is 0). 404 if private, removed or not embeddable.
- `POST /api/youtube/config {apiKey}` (host only). Empty clears the key. The key must match `^[\w-]{30,60}$`. Env `YOUTUBE_API_KEY` overrides.
- Test overrides: `YOUTUBE_API_BASE`, `YOUTUBE_OEMBED_URL`.

### Track shape
`{source:'youtube', id:<videoId>, title, artist:<channel>, album:'', duration(ms), art:<thumbnail>, karaoke:boolean}`. Queue items always use `mode:'original'`, and the Original/Karaoke toggle is hidden for them.

### Lyrics
`guessArtistTitle(videoTitle, channel)` strips bracketed tags (karaoke, lyrics, official video, HD, remaster…), `| …` suffixes and `ft./feat.` tails, then splits on ` - `/` – `. Without a dash, the artist is the channel name (minus ` - Topic`/`VEVO`), unless the channel looks like a karaoke channel. Lookup sends duration 0 (video lengths rarely match the recording).

### Pure helpers (`public/youtube.js`)
`parseYouTubeId`, `looksLikeYouTubeLink`, `parseIsoDuration`, `decodeEntities`, `isKaraokeTitle`, `guessArtistTitle`, `mapVideo`, `pacificDay`. Shared by the server, host, phone and tests.

## Numbers that matter
| Item | Value |
|---|---|
| Daily search allowance (Google default) | ~100 `search.list` calls/project/day |
| Results per search | 15 (minus non-embeddable) |
| Cache TTL / size | 24 h / 300 queries |
| Phone search trigger | Enter or Search button; links resolve after 300 ms |
| Bare-ID heuristic | exactly 11 of `[A-Za-z0-9_-]` **and** (a digit, `_`, `-`, or mixed case after the first letter) |

## Testing
- Unit (`tests/youtube.test.mjs`): link shapes (watch, youtu.be, shorts, embed, m., music.), bare-ID heuristic vs words, ISO durations, title parsing, entities, karaoke detection, mapping.
- E2E (`tests/e2e/run.mjs` + `youtube-mocks.mjs`): a mock Data API and oEmbed server, plus a stand-in `YT.Player` injected before page scripts. Checks: no search while typing; no-key message; link via oEmbed; save key; search returns 3; " karaoke" appended; cache hit costs 0; queue 3; blocked video (error 150) skipped; video plays on stage; karaoke video hides overlay; volume 80; phone pause; speed 80 % → 0.75; end advances; next video plays; a normal video overlays (mocked) LRCLIB lyrics using the parsed artist/title; phones get the lyric feed.
- Manual: a real key, a real karaoke video, an embedding-disabled video, and the quota counter after a few searches.

## Rollout & compatibility
Additive. Old phone pages ignore the new source. `.data/youtube-cache.json` is created on demand.

## Open questions
- Should the host be able to set a "safe search" level for family parties?
- Offer a "find on YouTube" fallback when the Spotify karaoke-version finder comes up empty?
