// Pure singing-analysis helpers shared by the host screen, the phone and the tests.
// No DOM, no audio: everything takes plain numbers so it can run in Node.

export const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
export const noteName = (m) => { const n = Math.round(m); return `${NOTE[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`; };
/** Fold an interval (semitones) into [-6, 6): "same note, any octave". */
export const fold = (d) => ((((d + 6) % 12) + 12) % 12) - 6;
/** Bring `m` into the octave nearest `anchor`. */
export const foldTo = (m, anchor) => anchor + fold(m - anchor);

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]; };
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

export const HIT = 0.75; // semitones: counts as "on the note"
export const NEAR = 1.5; // semitones: half credit / "aiming at the right note"

/** Per-frame credit used by the live score. */
export const credit = (absDiff) => (absDiff < HIT ? 1 : absDiff < NEAR ? 0.5 : 0);

/**
 * Steadiness: split voiced frames into held-note segments and measure the spread inside each.
 * frames: [{pos (s), midi}] in time order. Returns median within-segment std dev in cents.
 */
export function steadiness(frames, { gap = 0.05, jump = 0.6, minDur = 0.3 } = {}) {
  const segs = [];
  let cur = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], prev = frames[i - 1];
    if (prev && (f.pos - prev.pos > gap || Math.abs(f.midi - prev.midi) > jump)) { segs.push(cur); cur = []; }
    cur.push(f);
  }
  segs.push(cur);
  const spreads = segs
    .filter((s) => s.length > 2 && s.at(-1).pos - s[0].pos >= minDur)
    .map((s) => {
      // remove the slow trend (intentional glides) with a 5-frame moving average before measuring wobble
      const m = s.map((f) => f.midi);
      const resid = m.map((v, i) => { const w = m.slice(Math.max(0, i - 2), i + 3); return v - mean(w); });
      const raw = std(m.map((v) => v - median(m)));
      return Math.min(raw, std(resid) * 2.2) * 100;
    });
  return { cents: median(spreads), segments: spreads.length };
}

export function steadinessLabel(c) {
  if (c == null) return null;
  return c < 15 ? 'very steady' : c < 28 ? 'steady' : c < 45 ? 'a little wobbly' : 'wobbly';
}

export function voiceType(low, high) {
  const mid = (low + high) / 2;
  // rough classical ranges by centre note: bass E2–E4, baritone A2–A4, tenor C3–C5, alto F3–F5, mezzo A3–A5, soprano C4–C6
  return mid < 54.5 ? 'bass' : mid < 58.5 ? 'baritone' : mid < 62.5 ? 'tenor' : mid < 67 ? 'alto' : mid < 70.5 ? 'mezzo-soprano' : 'soprano';
}

/**
 * Key change (semitones) that best centres a song's vocal range in a singer's range.
 * Singing an octave up/down is allowed, so the shift is folded into [-6, 6].
 */
export function suggestKey(song, singer) {
  if (!song || !singer) return null;
  const shift = (singer.low + singer.high) / 2 - (song.low + song.high) / 2;
  let s = Math.round(fold(shift));
  if (s === -6 && shift > 0) s = 6;
  const songSpan = song.high - song.low, singerSpan = singer.high - singer.low;
  return { semitones: s, fits: songSpan <= singerSpan + 1, octave: Math.round((shift - s) / 12) };
}

/**
 * Build an after-song report for one singer.
 * frames: [{pos, midi, d, line}] where d = signed folded distance to the reference vocal in semitones
 *         (null if no reference at that moment) and line = lyric line index (-1 if none).
 * lines:  lyric lines [[t, text], ...] or null.
 */
export function buildReport(frames, { lines = null, songRange = null, singerRange = null, fps = 75 } = {}) {
  const voiced = frames.filter((f) => f.midi != null);
  if (voiced.length < fps * 2) return null; // under ~2 s of singing: nothing useful to say
  const withRef = voiced.filter((f) => f.d != null);
  const hasRef = withRef.length > fps * 2;

  const accuracy = hasRef ? withRef.reduce((s, f) => s + credit(Math.abs(f.d)), 0) / withRef.length : null;
  // tuning bias: only frames where the singer is clearly aiming at the right note
  const aimed = hasRef ? withRef.filter((f) => Math.abs(f.d) < 1).map((f) => f.d) : voiced.map((f) => f.midi - Math.round(f.midi));
  const bias = aimed.length > fps ? mean(aimed) * 100 : null;
  const st = steadiness(voiced);
  const low = pct(voiced.map((f) => f.midi), 5), high = pct(voiced.map((f) => f.midi), 95);

  let worstLines = [];
  if (hasRef && lines) {
    const by = new Map();
    for (const f of withRef) if (f.line >= 0) (by.get(f.line) || by.set(f.line, []).get(f.line)).push(f);
    worstLines = [...by.entries()]
      .filter(([, fs]) => fs.length >= fps * 0.6)
      .map(([line, fs]) => ({
        line, text: lines[line]?.[1] || '♪', start: lines[line]?.[0] ?? 0,
        accuracy: fs.reduce((s, f) => s + credit(Math.abs(f.d)), 0) / fs.length,
        bias: mean(fs.filter((f) => Math.abs(f.d) < 1).map((f) => f.d)) * 100 || 0,
      }))
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 3)
      .filter((l) => l.accuracy < 0.8);
  }

  const key = suggestKey(songRange, singerRange);
  const report = {
    seconds: Math.round(voiced.length / fps),
    accuracy, bias, hasRef,
    steadiness: st.cents, steadinessLabel: steadinessLabel(st.cents),
    range: { low, high, lowName: noteName(low), highName: noteName(high) },
    worstLines,
    key: key && Math.abs(key.semitones) >= 1 ? key : null,
  };
  report.tips = tips(report);
  return report;
}

export function tips(r) {
  const out = [];
  if (r.bias != null && r.bias < -15) out.push(`You tend to sing about ${Math.round(-r.bias)}¢ flat. Keep steady breath support through the end of each phrase, and think "up" on long notes.`);
  else if (r.bias != null && r.bias > 15) out.push(`You tend to sing about ${Math.round(r.bias)}¢ sharp. Relax your jaw and don't push on loud notes.`);
  else if (r.bias != null) out.push('Your tuning centre is spot on. Nice.');
  if (r.steadiness != null && r.steadiness >= 28) out.push('Long notes waver a bit. Try the Hold-a-note drill in Practice to build steadiness.');
  if (r.worstLines?.length) out.push(`Hardest line: “${r.worstLines[0].text}”. Loop it slowly until it feels easy.`);
  if (r.key) out.push(`This song may sit better for you ${r.key.semitones > 0 ? 'up' : 'down'} ${Math.abs(r.key.semitones)} semitone${Math.abs(r.key.semitones) > 1 ? 's' : ''}.`);
  if (r.accuracy != null && r.accuracy >= 0.8) out.push('Great pitch accuracy. Try a harder song, or turn the guide vocal off.');
  return out;
}

/** Score a drill note: frames of midi during the sing window vs a target. */
export function scoreNote(midis, target, { tol = 0.25 } = {}) {
  const v = midis.filter((m) => m != null).map((m) => foldTo(m, target));
  if (v.length < 8) return { sung: false, cents: null, inTune: 0, steady: null };
  const diffs = v.map((m) => (m - target) * 100);
  return {
    sung: true,
    cents: Math.round(median(diffs)),
    inTune: diffs.filter((c) => Math.abs(c) <= tol * 100).length / diffs.length,
    steady: Math.round(std(diffs)),
  };
}
