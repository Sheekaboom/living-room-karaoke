// AudioWorklet processors backed by the Rust/WASM DSP (dsp.wasm).
// Each node gets its own WASM instance (its own memory), compiled from bytes passed in processorOptions.

function makeInstance(bytes) {
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod, {}).exports;
}

class MusicDSP extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.e = null;
    this.params = { cut: 0, width: 0.6, semitones: 0 };
    try {
      this.e = makeInstance(opts.processorOptions.wasm);
      this.e.music_init(sampleRate);
      this.L = this.e.music_left() >> 2;
      this.R = this.e.music_right() >> 2;
      this.port.postMessage({ ready: true, latency: this.e.music_latency() / sampleRate });
    } catch (err) {
      this.port.postMessage({ error: String(err) });
    }
    this.port.onmessage = ({ data }) => {
      if (!this.e) return;
      if ('cut' in data) this.e.music_set_cut(data.cut);
      if ('width' in data) this.e.music_set_width(data.width);
      if ('semitones' in data) this.e.music_set_semitones(data.semitones);
      if ('band' in data) this.e.music_set_band(data.band[0], data.band[1]);
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    if (!this.e) { // pass through until ready
      for (let c = 0; c < out.length; c++) if (inp[c] || inp[0]) out[c].set(inp[c] || inp[0]);
      return true;
    }
    const mem = new Float32Array(this.e.memory.buffer);
    const l = inp[0], r = inp[1] || inp[0];
    if (l) { mem.set(l, this.L); mem.set(r, this.R); }
    else { mem.fill(0, this.L, this.L + n); mem.fill(0, this.R, this.R + n); }
    this.e.music_process(n);
    out[0].set(mem.subarray(this.L, this.L + n));
    if (out[1]) out[1].set(mem.subarray(this.R, this.R + n));
    return true;
  }
}

class VoiceDSP extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.e = null;
    this.tick = 0;
    try {
      this.e = makeInstance(opts.processorOptions.wasm);
      this.e.voice_init(sampleRate);
      this.V = this.e.voice_io() >> 2;
    } catch (err) {
      this.port.postMessage({ error: String(err) });
    }
    this.port.onmessage = ({ data }) => {
      if (this.e && 'tune' in data) this.e.voice_set_tune(data.tune, data.speed ?? 0.6, data.key ?? -1);
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0][0], out = outputs[0][0];
    const n = out.length;
    if (!this.e) { if (inp) out.set(inp); return true; }
    const mem = new Float32Array(this.e.memory.buffer);
    if (inp) mem.set(inp, this.V); else mem.fill(0, this.V, this.V + n);
    this.e.voice_process(n);
    out.set(mem.subarray(this.V, this.V + n));
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (++this.tick % 5 === 0) { // ~75 updates/s
      this.port.postMessage({
        pitch: this.e.voice_pitch(), clarity: this.e.voice_clarity(),
        rms: this.e.voice_rms(), target: this.e.voice_target(), t: currentTime,
      });
    }
    return true;
  }
}

registerProcessor('music-dsp', MusicDSP);
registerProcessor('voice-dsp', VoiceDSP);
