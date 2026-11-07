# 05 — Singing trainer

Status: Implemented

All formulas live in `public/training.js` (pure, shared by host, phone and tests). Pitches are fractional MIDI numbers (69 = A4 = 440 Hz). "Folded" intervals ignore octaves: `fold(d) ∈ [−6, 6)`, so singing an octave up or down counts as the same note.

## Frames
Host pitch updates arrive about 75 times a second per singer (`voice-dsp`, one message every 5 render quanta). A frame is **voiced** when `pitch > 0 && clarity > 0.7`. The reference (isolated vocal stem) is voiced when `clarity > 0.75`, an AI song is playing, and music isn't paused.

While a song plays, each voiced singer frame is recorded as `{pos, midi, d, line}`:
- `pos`: song position (s) as heard
- `d`: signed folded distance to the reference, using the **best match in the window 100–450 ms in the past** (this absorbs WebRTC and output latency). `null` without a reference.
- `line`: current lyric line index or −1

## Live score
Per frame with a reference: credit **1** if `|d| < 0.75` semitones (HIT), **0.5** if `< 1.5` (NEAR), else 0. Live % = credits / frames. It's shown after 20 frames.

## Report object
Built by `buildReport(frames, {lines, songRange, singerRange})` at song end (or skip). It returns `null` if there are fewer than 2 s (150 frames) of voiced singing.

| Field | Definition |
|---|---|
| `seconds` | voiced frames / 75 |
| `hasRef` | > 150 frames with a reference |
| `accuracy` | mean credit over frames with a reference (`null` without a reference) |
| `bias` (cents) | with a reference: mean of `d·100` over frames with `\|d\| < 1`. Without: mean of `(midi − round(midi))·100`. `null` if < 75 such frames. Shown as "centred" if `\|bias\| < 8`. |
| `steadiness` (cents) | Split voiced frames into segments (break on > 50 ms gap or > 0.6 semitone jump). For segments ≥ 300 ms: `min(std(midi − median), 2.2·std(midi − 5-frame moving average))·100`. Report the median across segments. |
| `steadinessLabel` | < 15 very steady · < 28 steady · < 45 a little wobbly · else wobbly |
| `range` | 5th and 95th percentile of voiced MIDI, plus note names |
| `worstLines` | Group frames with a reference by lyric line (≥ 45 frames per line), score each line by mean credit, keep the 3 worst that are under 80 %. |
| `key` | `suggestKey(songRange, singerRange)` if `\|semitones\| ≥ 1`, else `null` |
| `tips[]` | Rule-based, in order: flat bias < −15¢ / sharp > +15¢ / centred; steadiness ≥ 28¢ → Hold-a-note drill; hardest line → loop it; key suggestion; accuracy ≥ 80 % → try harder. |
| `name, color, title, artist, date` | Added by the host |

The host shows one card per singer, sends each singer their own report (`relay` → `{type:'report'}`), and the phone saves it to history.

## Song vocal range
After an AI-split local song has played with > 300 voiced reference frames, the host stores its range: the 5th/95th percentile of reference MIDI **with the key change removed**. `POST /api/vocal-range/:id`. A later play overwrites it.

## Key suggestion
`shift = centre(singer) − centre(song)`, then `s = round(fold(shift))` (+6 is preferred over −6 when shift > 0). `octave = round((shift − s)/12)` tells the singer to sing that many octaves away. `fits = song span ≤ singer span + 1`. The host shows *"Suggested key for {singer}: ±N [Apply]"* when the song's range and the queued singer's range are both known and N differs from the current key.

## Phone tuner
The phone runs its **own** `voice-dsp` instance on its local mic, so there's no network latency. Display:
- Reference fresh (< 400 ms): target = reference folded to the singer's octave. Text: "Target X · N¢ flat/sharp", or "go up/down" when > 60¢ off.
- Otherwise: target = nearest semitone.
- Needle range ±50¢, smoothed (EMA 0.35). Green ≤ 15¢, amber ≤ 30¢, pink beyond.

## Drills (phone)
The phone's mic is muted **to the room** during a drill (`sender.replaceTrack(null)`); the local pitch engine keeps running. Reference tones: triangle + 0.25 octave sine, 30 ms attack, 120 ms release, played on the phone. Frames during the listen phase plus 150 ms (and the first `skip` seconds of the sing phase) are ignored.

| Drill | Notes | Listen / sing / skip (s) |
|---|---|---|
| Find my range | Wait up to 20 s for a held note: ≥ 70 consecutive voiced frames within 0.8 semitones of each other; take the median after the first 20. Low, then high. Reject if `high − low < 3`. | — |
| Hold a note | 1 note (default: centre of range, ± buttons) | 1.2 / 4.5 / 0.6 |
| Scale warm-up | root = round(low + 2) + shift; intervals 0 2 4 5 7 5 4 2 0. "Again, ½ step higher" adds 1 to shift. | 0.7 / 1.4 / 0.35 |
| Pitch matching | 8 random notes in [low + 1, high − 1] | 0.9 / 1.8 / 0.35 |

Per note, `scoreNote`: frames folded to the target; `cents` = median deviation, `inTune` = share within ±25¢, `steady` = std dev (¢). Fewer than 8 frames = not sung. Drill score = mean over **all** notes of (1 if `|cents| ≤ 25`, 0.5 if ≤ 50, else 0). Default range before measuring: F3–F4 (53–65).

Voice type label (rough): centre < 54.5 bass, < 58.5 baritone, < 62.5 tenor, < 67 alto, < 70.5 mezzo-soprano, else soprano.

## Practice loop & speed
- **Loop line** (host button or phone 🔁): `a = t(line) − 0.6 − offset`, `b = t(next line) − 0.05 − offset` (or `t + 6` for the last line), with `b ≥ a + 1.5`. Without synced lyrics: position ± 4 s. When `position ≥ b`, seek to `a` (at most once per 600 ms). This check MUST run in background tabs too (`tick()` on a 50 ms timer when `document.hidden`).
- **Speed:** 100/90/85/80/70 %, local files only. Set `defaultPlaybackRate` and `playbackRate` (with `preservesPitch = true`) on music and guide; `defaultPlaybackRate` is what survives a `src` change. Reset to 100 % when a song stops.
- **Practise from a report:** replays the song with a fresh `practice-*` qid (not from the queue), loops the chosen line and sets speed to 85 %.

## Progress (phone)
`localStorage['karaoke-history']`: newest first, at most 200 entries: `{type:'song', date, report}` or `{type:'drill', drill, date, score?, summary}`. The Progress tab shows songs sung, average accuracy over the last 5 songs that had a reference, range, a sparkline of the last 20 accuracies (guide line at 80 %), the latest report and the history list.
