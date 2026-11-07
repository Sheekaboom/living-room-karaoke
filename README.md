# 🎤 Living-Room Karaoke

A karaoke app you host yourself. Your computer plays the music and shows the lyrics on screen. Everyone's phone turns into a wireless mic over your Wi-Fi.

## Quick start

1. Install **Node.js 20+** (https://nodejs.org).
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. On the computer that's connected to your speakers or TV, open **http://127.0.0.1:3000** and click **Start the party**.
4. On each phone (same Wi-Fi), scan the QR code on screen. You can also type the `https://<your-ip>:3443` address printed in the terminal.
   - The phone will say the connection isn't private. That's expected for a home server, because the certificate is self-signed. Tap **Advanced → Proceed** (Android/Chrome) or **Show Details → visit this website** (iPhone).
   - The mic needs HTTPS, which is why the phone uses port 3443.
5. Add songs from the host screen or any phone. Pick **Original** or **Karaoke** for each song, then sing.

## Music sources

### Your own files (full control)
Drop audio files into `music/`, or click **＋ Add** in the Library tab. Supported formats are MP3, M4A, FLAC, WAV, OGG and Opus. Name files `Artist - Title.mp3` (or tag them) so the app can find lyrics.

There are three ways to strip vocals from local files:

| Mode | How | Quality |
|---|---|---|
| **Spectral (default)** | Rust/WebAssembly engine in the browser. Removes sound that is centered in the stereo mix, one frequency bin at a time, in real time. | Good on most studio pop and rock. Weaker on mono or reverb-heavy mixes. |
| **AI (Demucs)** | `pip install demucs`, restart the server, then click **AI split** on a song. It runs once per song and the result is cached. | Close to studio quality. Also unlocks the guide-vocal slider and pitch scoring. |
| **Original** | Plays the song as-is. | — |

A song that is playing switches to the AI version automatically once its split finishes.

### Spotify (Premium required)
1. Create an app at https://developer.spotify.com/dashboard.
   - Redirect URI: `http://127.0.0.1:3000/spotify/callback`
   - Tick **Web API** and **Web Playback SDK**.
2. Paste the Client ID into the host screen under **Setup**, then log in from the **Spotify** tab.
3. Under User Management in the Spotify dashboard, add the email of each Spotify account that will log in. Development-mode apps allow up to 5.

**What "Karaoke" means for Spotify:** Spotify streams are DRM-encrypted, so no app can strip vocals from them. Instead, the app finds a karaoke or instrumental release of the same song in Spotify's catalog and plays that, with lyrics timed to the original. If it picked the wrong version, click **Try another**. Key change, spectral removal and scoring only work with local files.

Spotify login only works when the host screen is opened at `http://127.0.0.1:3000` on the server computer.

## YouTube
Open the **YouTube** tab on the host (or *YouTube* in the phone's song search) and paste any YouTube link to add the video. No setup needed.

To **search** YouTube, add a free YouTube Data API key under **Setup** (instructions are on that tab). Search is limited to about 100 searches a day. Repeat searches are cached and links don't count, so that's plenty for a party.

Videos play full-screen on the stage in YouTube's own player, with their **original audio**, and phone mics mix in as usual. Vocal removal, key change and scoring aren't possible for YouTube, so leave "Karaoke versions only" ticked to find videos with the vocals already removed and the lyrics on screen.

## Features
- Phone mics stream to the host over WebRTC (Opus at 128 kbps, minimal jitter buffer). Each phone has its own volume control, mute button and noise-suppression toggle.
- Synced lyrics come from LRCLIB (free, no API key), with a word-wipe highlight on screen and the current line shown on each phone. Use ±0.25s to fix the timing.
- Mixer: music volume, guide vocal, **key change ±6 semitones**, removal strength and strictness, mic reverb and echo.
- **Pitch correction ("auto-tune")**: amount, speed and scale (chromatic or any major key).
- **Pitch lane and scoring**: shows each singer's pitch live. With AI-split songs it compares the singer against the original vocal, in any octave, and shows a % score.
- Phones can search, queue songs, and play, pause or skip.

## Singing trainer
- **After-song report** for each singer, on the big screen and on their phone: pitch accuracy, whether you sing flat or sharp (in cents), how steady your long notes are, the range you used, your 3 hardest lyric lines, and concrete tips.
- **Phone tuner:** a live needle showing how far you are from the original vocal's note (or the nearest note).
- **Practice tab** with drills, scored on the phone using its own pitch engine (your mic is muted to the room while you practise):
  - *Find my range*: measures your comfortable low and high notes and estimates your voice type.
  - *Hold a note*, *Scale warm-up*, *Pitch matching*.
- **Key suggestions:** once your range and a song's vocal range are known, the host suggests the best key for you, which you can apply in one tap.
- **Loop a line and slow it down** (70–100 %, pitch preserved) from the host or your phone. "🔁 Loop it" on a report replays the song looping that line at 85 %.
- **Progress tab:** history of songs and drills on your phone, with an accuracy trend.
- A shared queue with an "Up next" countdown between songs.

## Rust/WebAssembly DSP (`dsp/`)
All the heavy audio work runs in `public/dsp.wasm` (about 22 KB) inside AudioWorklets, using roughly 2% of one CPU core per stream:
- **Centre-channel extraction**: 2048-point STFT. Both channels are transformed with a single complex FFT. A bin is treated as vocal when its inter-channel coherence is high, a smooth mask with a vocal-band weighting is applied to it, and only the mid component is reduced, so the stereo sides survive.
- **Phase-vocoder pitch shifter** for key change.
- **YIN pitch detector** with 2:1 decimation and parabolic interpolation, for each mic and for the reference vocal.
- **Pitch-correcting voice engine** that snaps to the nearest note in the chosen scale, with an adjustable glide.

A prebuilt `dsp.wasm` is included. To rebuild it:
```
rustup target add wasm32-unknown-unknown
npm run build:wasm
```
To run the DSP unit tests natively: `cd dsp && cargo test --lib --target <your-host-triple>`

## Development
- Specs: [`docs/specs/`](docs/specs/README.md). Start there before changing behaviour.
- `npm test`: training-maths unit tests
- `cd dsp && cargo test --lib --target <your-host-triple>`: DSP unit tests
- `npm run bench`: DSP CPU budget
- `CHROME_PATH=/path/to/chrome npm run test:e2e`: full end-to-end run in headless Chrome with a simulated phone mic

## Tips
- **Feedback or echo:** point phones away from the speakers, lower the mic volume, or turn on echo cancellation on the phone (Mic options).
- **Latency:** expect roughly 100–200 ms from phone to speakers over Wi-Fi. A 5 GHz network helps.
- **Phones going to sleep:** the page asks the phone to keep its screen awake. On iPhone, keep Safari in the foreground.
- **Ports:** set `HTTP_PORT` or `HTTPS_PORT` to use other ports, and `MUSIC_DIR` to use another music folder.
