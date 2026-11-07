// Generates synthetic audio for the end-to-end tests (no external files needed).
import fs from 'node:fs';

export function writeWav(file, channels, sr) {
  const n = channels[0].length, nc = channels.length;
  const buf = Buffer.alloc(44 + n * nc * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nc * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * nc * 2, 28); buf.writeUInt16LE(nc * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * nc * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(channels[c][i] * 32767))), 44 + (i * nc + c) * 2);
  fs.writeFileSync(file, buf);
}
export function readWav(file) {
  const b = fs.readFileSync(file);
  const nc = b.readUInt16LE(22), sr = b.readUInt32LE(24), n = (b.length - 44) / (2 * nc);
  const ch = Array.from({ length: nc }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) ch[c][i] = b.readInt16LE(44 + (i * nc + c) * 2) / 32767;
  return { ch, sr };
}

/** 20 s stereo "song": centred melody A4-C5-E5-A5 (one note per second) + wide (anti-phase) bass and 330 Hz tone,
 *  so a perfect separator would find the melody in mid and the instruments in side. */
export function makeSong(file, seconds = 20, sr = 44100) {
  const notes = [440, 523.25, 659.25, 880];
  const L = new Float32Array(sr * seconds), R = new Float32Array(sr * seconds);
  let ph = 0;
  for (let i = 0; i < L.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * notes[Math.floor(t) % 4]) / sr;
    const voc = 0.3 * (Math.sin(ph) + 0.3 * Math.sin(2 * ph));
    const inst = 0.25 * Math.sin(2 * Math.PI * 110 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t)) + 0.2 * Math.sin(2 * Math.PI * 330 * t + 1);
    L[i] = 0.8 * (voc + inst);
    R[i] = 0.8 * (voc - inst);
  }
  writeWav(file, [L, R], sr);
}
/** Mono "singer" holding E4 (330 Hz) with harmonics, used as Chrome's fake microphone. */
export function makeVoice(file, seconds = 60, sr = 48000) {
  const v = new Float32Array(sr * seconds);
  for (let i = 0; i < v.length; i++) { const p = (2 * Math.PI * 330 * i) / sr; v[i] = 0.3 * (Math.sin(p) + 0.4 * Math.sin(2 * p) + 0.2 * Math.sin(3 * p)); }
  writeWav(file, [v], sr);
}
