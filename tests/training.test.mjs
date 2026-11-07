import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, foldTo, noteName, suggestKey, steadiness, buildReport, scoreNote, voiceType } from '../public/training.js';

test('fold keeps intervals within a tritone', () => {
  assert.equal(fold(12), 0);
  assert.equal(fold(-11), 1);
  assert.equal(fold(7), -5);
  assert.equal(foldTo(76, 64), 64); // E5 sung against E4 target -> treated as E4
});

test('note names', () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61.4), 'C♯4');
});

test('suggestKey centres song in singer range (octave allowed)', () => {
  assert.deepEqual(suggestKey({ low: 60, high: 72 }, { low: 57, high: 69 }), { semitones: -3, fits: true, octave: 0 });
  // male singer an octave + 2 below a female song -> 2 down, an octave lower
  const k = suggestKey({ low: 64, high: 76 }, { low: 50, high: 62 });
  assert.equal(k.semitones, -2); assert.equal(k.octave, -1);
});

test('steadiness separates steady and wobbly notes', () => {
  const steadyFrames = Array.from({ length: 150 }, (_, i) => ({ pos: i / 75, midi: 64 + 0.03 * Math.sin(i) }));
  const wobblyFrames = Array.from({ length: 150 }, (_, i) => ({ pos: i / 75, midi: 64 + 0.45 * Math.sin(i * 0.9) }));
  assert.ok(steadiness(steadyFrames).cents < 10);
  assert.ok(steadiness(wobblyFrames).cents > 28);
});

test('report finds flat bias, worst line and key suggestion', () => {
  const lines = [[0, 'line one'], [4, 'line two'], [8, 'line three']];
  const frames = [];
  for (let i = 0; i < 75 * 12; i++) {
    const pos = i / 75, line = pos < 4 ? 0 : pos < 8 ? 1 : 2;
    const d = line === 1 ? 2.5 : -0.2; // consistently 20 cents flat, line two badly off
    frames.push({ pos, midi: 60 + d, d, line });
  }
  const r = buildReport(frames, { lines, songRange: { low: 60, high: 70 }, singerRange: { low: 55, high: 65 } });
  assert.ok(r.hasRef);
  assert.ok(Math.abs(r.bias + 20) < 1, `bias ${r.bias}`);
  assert.equal(r.worstLines[0].text, 'line two');
  assert.ok(r.accuracy > 0.6 && r.accuracy < 0.7);
  assert.equal(r.key.semitones, -5);
  assert.ok(r.tips.some((t) => t.includes('flat')));
});

test('report without reference still gives range/steadiness, and refuses tiny samples', () => {
  const frames = Array.from({ length: 300 }, (_, i) => ({ pos: i / 75, midi: 57 + (i > 150 ? 7 : 0), d: null, line: -1 }));
  const r = buildReport(frames);
  assert.equal(r.accuracy, null);
  assert.equal(r.range.lowName, 'A3');
  assert.equal(r.range.highName, 'E4');
  assert.equal(buildReport(frames.slice(0, 50)), null);
});

test('scoreNote', () => {
  const s = scoreNote(Array.from({ length: 60 }, () => 69.1 + 12), 69); // an octave up, 10 cents sharp
  assert.equal(s.cents, 10); assert.equal(s.inTune, 1);
  assert.equal(scoreNote([null, null], 69).sung, false);
  assert.equal(voiceType(45, 64), 'baritone');
});
