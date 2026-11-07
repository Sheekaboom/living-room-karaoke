# 06 — Testing

Status: Implemented

| Layer | Command | What it proves |
|---|---|---|
| Training maths | `npm test` | `training.js` formulas: folding, key suggestion, steadiness, report fields, drill scoring. |
| DSP | `cd dsp && cargo test --lib --target <host-triple>` | Pass-through is exact (delayed 2048 samples), centre removal, octave shift, YIN accuracy, auto-tune pull. |
| DSP performance | `node tests/bench-dsp.mjs` | Each engine < 5 % of one core (see [03](03-dsp.md#performance-budget)). |
| End-to-end | `CHROME_PATH=… npm run test:e2e` | Full stack in headless Chrome with a fake mic. |

## End-to-end suite (`tests/e2e/run.mjs`)
- Starts the server on ports 3190/3593 with a temporary `MUSIC_DIR` and `DATA_DIR`, so it never touches your real library.
- Fixtures are generated in code (`fixtures.mjs`): a 20 s stereo song with a centred A4–C5–E5–A5 melody and anti-phase instruments, and a 60 s mono "singer" holding E4.
- `fake-demucs.mjs` mimics the Demucs CLI and output layout (it splits by mid/side), so the AI path is tested without Python.
- Chrome flags: `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<voice.wav> --use-fake-ui-for-media-stream --ignore-certificate-errors --autoplay-policy=no-user-gesture-required`.
- Tests talk to the host through `window.karaoke` (debug handle: `ctx, nodes, peers, current, party, playNext, position, songEnded, practiceLine, toggleLoop`). Keep it stable or update the suite.
- Use `page.evaluate(() => el.click())` rather than `page.click()`: two tabs share one headless window and native clicks on a background tab are unreliable.
- `SCREENSHOTS=<dir>` saves phone screenshots.

Current checks (all must pass): WebRTC connect; host hears E4; profile reaches host; phone tuner E4; phone queues; spectral cut > 30 dB on vocal and < 3 dB on side; phone loop toggle; loop jumps back; phone speed; AI split; AI mode; host report; phone report saved; accuracy 15–45 %; phone report card; song vocal range ≈ 69–81; key suggestion −5; hold target; room-mute during drill; hold drill 100 %; mic restored; range finder rejects one note; progress tab lists items; no page errors.

## Manual device checklist (before a release)
Run on real hardware. These can't be automated in CI.
- [ ] iPhone Safari and Android Chrome: accept the certificate, join, hear the voice through the speakers within ~200 ms.
- [ ] Phone screen stays awake during a song (Wake Lock).
- [ ] Two phones at once: separate volume, separate pitch lines and scores.
- [ ] Feedback: with phones 1 m from speakers at party volume, no howl at the default mic volume (1.4) with reverb 30 %.
- [ ] Spotify: login, search from the phone, original and karaoke-version playback, end-of-track advance, Try another.
- [ ] LRCLIB: synced lyrics appear and the offset buttons shift them.
- [ ] Real Demucs: AI split completes, the playing song switches over seamlessly, guide slider works, score is sensible.
- [ ] Practice drills with headphones and with the phone speaker.
- [ ] Host tab in the background: loops and the phone lyric feed keep working.
