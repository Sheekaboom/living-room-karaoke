// DSP performance budget check: each engine must stay under 5% of one core (docs/specs/03-dsp.md).
import fs from 'node:fs';
const wasm = new URL('../public/dsp.wasm', import.meta.url);
const { instance: { exports: e } } = await WebAssembly.instantiate(fs.readFileSync(wasm));
e.music_init(48000); e.voice_init(48000);
const mem = () => new Float32Array(e.memory.buffer);
const L = e.music_left() / 4, R = e.music_right() / 4, V = e.voice_io() / 4;
const secs = 20, blocks = (secs * 48000) / 128;
let worst = 0;
for (const [name, setup, run] of [
  ['music bypass', () => {}, () => e.music_process(128)],
  ['music cut+key', () => { e.music_set_cut(1); e.music_set_semitones(2); }, () => e.music_process(128)],
  ['voice pitch', () => {}, () => e.voice_process(128)],
  ['voice auto-tune', () => e.voice_set_tune(1, 0.7, -1), () => e.voice_process(128)],
]) {
  setup();
  const t = performance.now();
  for (let b = 0; b < blocks; b++) {
    const m = mem();
    for (let i = 0; i < 128; i++) { const v = Math.sin((b * 128 + i) * 0.0577) * 0.4; m[L + i] = v; m[R + i] = v * 0.8; m[V + i] = v; }
    run();
  }
  const pct = (performance.now() - t) / secs / 10;
  worst = Math.max(worst, pct);
  console.log(`${name.padEnd(16)} ${pct.toFixed(2)}% of one core`);
}
if (worst > 5) { console.error('Over the 5% budget'); process.exit(1); }
