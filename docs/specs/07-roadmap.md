# 07 — Roadmap

Status: Living document

## Known limitations
| Area | Limitation | Notes |
|---|---|---|
| Spotify | Can't strip vocals, change key or score. | DRM (EME). The karaoke-version finder is the workaround. |
| Spotify | 5 users per developer-mode app, owner needs Premium, search capped at 10 results. | Spotify policy since Feb/Mar 2026. Extended quota needs an organisation with 250k MAU. |
| YouTube | Original audio only (no removal, key change or scoring). About 100 searches a day on the default API quota. | The audio is inside YouTube's iframe. Downloading is against YouTube's ToS. Links work without quota. |
| Latency | ~100–200 ms phone→speaker. | Opus 20 ms frames + jitter buffer + output buffer. Phone-side monitoring isn't possible (Bluetooth adds more). |
| Spectral removal | Also removes centred bass-mid instruments (snare body, centred keys). Weak on mono or heavily reverbed mixes. | By design. Demucs is the quality path. |
| Key change | Formants shift (slight "chipmunk" at +4 and above). | Phase vocoder without formant preservation. |
| Scoring | Pitch only, no timing/rhythm. Needs an AI split. | |
| Certificates | Self-signed: every phone sees a warning once. | |
| Security | Any device on the LAN can queue songs, upload files and trigger separation. | Fine for home networks, not for public Wi-Fi. |
| Persistence | Queue is lost on server restart. | |

## Backlog (prioritised)
**P1: next**
1. **Timing / rhythm feedback:** onset detection on singer and reference vocal, report "early/late by N ms" per line.
2. **Lyric-aligned pitch lane:** show the upcoming reference melody (needs offline pitch extraction of the vocal stem → `.data/stems/<id>/pitch.json`), like SingStar note bars.
3. **Batch AI split:** "Split all" with a queue view, plus GPU detection (`--device cuda/mps`).
4. **Offline reference extraction:** run YIN over `vocals.*` once after Demucs finishes, which also gives the vocal range without having to play the song first.

**P2: soon**
5. Formant-preserving key change (spectral-envelope correction or a PSOLA path for vocals).
6. Duets: assign singers to lyric lines and score per part.
7. Optional room PIN for queueing/uploads on shared networks.
8. Persist queue across restarts (`.data/queue.json`).
9. PWA manifest + install prompt for the phone page.
10. Export progress history (CSV / share card).

**P3: later**
11. Remote singers over the internet (TURN, auth, latency compensation).
12. ~~YouTube via official embeds~~: done ([08](08-youtube.md)).
13. Harmony detection (sing a third above the melody and get scored on it).
14. Vibrato detection and coaching (rate/depth) as a separate steadiness metric.

## Decisions log
| Date | Decision | Why |
|---|---|---|
| 2026-11-06 | Phones on HTTPS :3443, host on loopback HTTP :3000. | Mic requires a secure context; Spotify only allows http redirect URIs on loopback. |
| 2026-11-06 | Spotify "karaoke" = play a karaoke release from the catalog. | DRM prevents processing. |
| 2026-11-06 | DSP in Rust `no_std` WASM inside AudioWorklets. | Deterministic, allocation-free, ~2 % CPU, one 22 KB binary for host and phone. |
| 2026-11-07 | Singing history stored on phones only. | Privacy and no account system. The server has no personal data except Spotify tokens. |
| 2026-11-07 | Score octave-agnostic (folded intervals). | Lets people sing comfortably an octave away from the original. |
| 2026-11-07 | YouTube via the official IFrame player only; search on Enter; 24 h search cache; oEmbed for links. | ToS compliance, and the ~100 searches/day default quota. |
