# 00 — Product

Status: Implemented

## Vision
Turn any computer + speakers into a karaoke machine where everyone's phone is the microphone, with no app to install, no account required for local music, and no cloud service in the audio path. Beyond the party, it should make people **better singers** through honest, specific feedback.

## Users
- **Host:** runs the server, owns the speakers/TV, manages the queue and mix. Moderately technical (can run `npm start`).
- **Singer:** a guest with a phone. Zero setup beyond scanning a QR code and accepting a certificate warning.
- **Learner:** a singer who wants to improve, and uses drills and reports over many sessions.

## Goals
1. Phone-as-mic with latency low enough to sing along to (target: < 200 ms on home Wi-Fi).
2. Sing any song: local files with vocals removed, or Spotify via karaoke versions.
3. Lyrics that follow the music, on the big screen and on the phone.
4. Feedback that's actionable: *what* was off (flat/sharp, wobbly, which line) and *how* to practise it.
5. Runs fully on the local network. The only internet calls are optional (Spotify, LRCLIB lyrics).

## Principles
- **Honest about limits.** Never pretend to strip vocals from DRM audio. Label which removal method is in use.
- **The audio thread never allocates.** DSP runs in fixed-memory WASM in AudioWorklets.
- **Phones are untrusted, lightweight clients.** They can't get Spotify tokens, change server config, or control another singer's mic.
- **Data stays on the device that made it.** Singing history and range live in the phone's localStorage. The server stores only the music library, stems, song vocal ranges and Spotify tokens.
- **Graceful degradation.** Without Demucs → spectral removal. Without synced lyrics → plain lyrics. Without a reference vocal → pitch-only feedback.

## Non-goals (for now)
- Hosting over the internet / remote singers (see roadmap).
- Downloading audio from streaming services or YouTube.
- Multi-room or multi-host parties.
- Storing user accounts on the server.
