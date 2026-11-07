# 03 — DSP engine (Rust → WebAssembly)

Status: Implemented

Source: `dsp/src/lib.rs`. Output: `public/dsp.wasm` (~22 KB). `no_std`, no allocator: all buffers are fixed-size statics, so audio processing never allocates. Each AudioWorklet node instantiates its **own** WASM instance (own linear memory), so the global engines below are per node.

## Build
```
rustup target add wasm32-unknown-unknown
npm run build:wasm        # cargo build --release --target wasm32-unknown-unknown, copies to public/
cd dsp && cargo test --lib --target <host-triple>   # native unit tests
```
Release profile: `opt-level=3`, LTO, `codegen-units=1`, `panic=abort`. SIMD128 enabled via `.cargo/config.toml`. Only dependency: `libm`.

## ABI
All functions are `extern "C"`. Buffers are 128-sample `f32` arrays (one Web Audio render quantum) at the addresses returned by the pointer getters. The worklet copies input into WASM memory, calls `*_process(n)`, and copies output back in place.

### Music engine (stereo)
| Export | Meaning |
|---|---|
| `music_init(sr)` | Reset all state for a sample rate. Must be called first. |
| `music_left()`, `music_right()` → `*f32` | In/out buffers. |
| `music_process(n)` | Process `n ≤ 128` frames in place. |
| `music_set_cut(0..1)` | Vocal removal amount. 0 = bypass removal. |
| `music_set_width(0..1)` | Strictness: centre-ness threshold `t0 = 0.35 + 0.6·width`. |
| `music_set_semitones(-12..12)` | Key change (host UI limits to ±6). |
| `music_set_band(lo_hz, hi_hz)` | Vocal band (default 110–8000 Hz, half-octave soft edges). |
| `music_latency()` → samples | **2048** (one frame). Host subtracts `latency/sr + outputLatency` from `currentTime` for lyric timing. |

### Voice engine (mono)
| Export | Meaning |
|---|---|
| `voice_init(sr)`, `voice_io()`, `voice_process(n)` | As above. |
| `voice_pitch()` → Hz (0 = unvoiced), `voice_clarity()` 0..1, `voice_rms()`, `voice_target()` → Hz | Latest YIN estimate (updated every 256 decimated samples ≈ 10.7 ms at 48 kHz). |
| `voice_set_tune(amount 0..1, speed 0..1, key -1..11)` | Pitch correction. `key=-1` chromatic, else major scale with that root (0 = C). |

## Algorithms

### STFT framework
Hann analysis and synthesis windows, 75 % overlap, overlap-add normalised by `1/(N·1.5)`. Music: N=2048, hop 512. Voice: N=1024, hop 256. Radix-2 iterative complex FFT with precomputed twiddles and bit-reversal table.

**Stereo trick:** both channels go through one complex FFT (`z = L + iR`), are separated using conjugate symmetry, processed, then recombined with `z = L' + iR'` for one inverse FFT.

### Spectral centre-channel vocal removal
Per bin k inside the vocal band:
- centre-ness `c = 2·Re(L·R*) / (|L|² + |R|²)` (1 = identical in both channels, ≤ 0 = wide / anti-phase)
- mask `m = smoothstep(clamp((c − t0)/(1 − t0), 0, 1)) · band(k)`
- temporal smoothing: attack 0.7, release 0.25 per frame (reduces "musical noise")
- with mid `M = (L+R)/2` and side `S = (L−R)/2`: `L' = S + g·M`, `R' = −S + g·M`, `g = 1 − cut·m`

Only the mid component of centred bins is reduced, so stereo width and hard-panned instruments survive. Bass and kick (< ~110 Hz) and cymbals (> ~8 kHz) are kept by the band weight.

**Contract (tests):** with `cut=1`, a centred tone is reduced by > 75 % RMS while a hard-panned tone keeps > 60 % (unit test). On the e2e fixture, centred vocal drops > 30 dB and side content changes < 3 dB.

### Phase-vocoder pitch shift
Bin-shifting phase vocoder (Laroche/Dolson, after Bernsee): true-frequency estimate per bin from the phase difference, bins moved to `round(k·ratio)`, magnitudes summed, the strongest contributor's frequency kept, synthesis phase accumulated. When `ratio == 1` the spectrum passes through untouched and synthesis phases are kept in step so a later shift starts without a click. Formants shift with pitch (no formant preservation, see roadmap).

**Contract:** a 220 Hz tone shifted by ratio 2 is detected at 440 ± 8 Hz.

### YIN pitch detection
2nd-order Butterworth low-pass at 4.5 kHz, then 2:1 decimation into a 1024-sample ring. Every 256 decimated samples: difference function over a 512-sample window for τ in [sr/1100, sr/65] (≈ 65–1100 Hz), cumulative-mean normalisation, absolute threshold 0.15, walk to the local minimum, parabolic interpolation. RMS gate 0.004 → unvoiced. `clarity = 1 − d'(τ)`.

**Contract:** harmonic tones at 82, 196, 440 and 880 Hz are detected within 1 %.

### Pitch correction (auto-tune)
When voiced with clarity > 0.6: target = nearest note (chromatic) or nearest major-scale note within ±2 semitones. Wanted ratio = `(target/f)^amount`. Glide coefficient per estimate = `1 − exp(−(0.05 + 4·speed²))`. Shift via the phase vocoder (N=1024). When `amount = 0` and the ratio has settled to 1, the engine is bypassed entirely, so no latency is added.

**Contract:** a 452 Hz tone with amount=1, speed=1 comes out at 440 ± 4 Hz.

## Performance budget
Measured in Node (V8) on one core: music bypass 1.2 %, music cut+pitch 2.1 %, voice YIN 1.1 %, voice auto-tune 2.0 % of real time. Any change MUST keep each engine under **5 %** of a core (run `node tests/bench-dsp.mjs`).

## Adding a DSP feature
1. Implement in `lib.rs` with fixed-size buffers. Zero-initialised memory must be a valid state (`init` uses `write_bytes(0)`).
2. Export setters via `#[unsafe(no_mangle)] extern "C"`. Never pass pointers to JS other than the I/O buffers.
3. Add a native unit test with a numeric contract, and document it here.
4. Wire the parameter through `dsp-worklet.js` `port.onmessage`.
