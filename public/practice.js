// Phone-side singing trainer: local pitch engine (Rust/WASM YIN), live tuner, drills and progress history.
import { hzToMidi, noteName, foldTo, scoreNote, voiceType, NOTE } from '/training.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ───────────── local pitch engine ─────────────
let ctx = null, node = null, src = null;
const listeners = new Set();
export const pitch = { midi: null, clarity: 0, rms: 0, t: 0 };

export async function startEngine(stream) {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const [bytes] = await Promise.all([fetch('/dsp.wasm').then((r) => r.arrayBuffer()), ctx.audioWorklet.addModule('/dsp-worklet.js')]);
    node = new AudioWorkletNode(ctx, 'voice-dsp', { outputChannelCount: [1], processorOptions: { wasm: bytes } });
    const sink = ctx.createGain(); sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    node.port.onmessage = ({ data }) => {
      const voiced = data.pitch > 0 && data.clarity > 0.7;
      pitch.midi = voiced ? hzToMidi(data.pitch) : null;
      pitch.clarity = data.clarity; pitch.rms = data.rms; pitch.t = performance.now();
      for (const fn of listeners) fn(pitch);
    };
  }
  await ctx.resume();
  src?.disconnect();
  src = ctx.createMediaStreamSource(stream);
  src.connect(node);
}
const onPitch = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function playTone(midi, dur = 0.8) {
  if (!ctx) return;
  const t = ctx.currentTime, f = 440 * 2 ** ((midi - 69) / 12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.03);
  g.gain.setValueAtTime(0.35, t + dur - 0.12);
  g.gain.linearRampToValueAtTime(0, t + dur);
  for (const [type, mul, lvl] of [['triangle', 1, 1], ['sine', 2, 0.25]]) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = type; o.frequency.value = f * mul; og.gain.value = lvl;
    o.connect(og).connect(g); o.start(t); o.stop(t + dur + 0.05);
  }
  g.connect(ctx.destination);
}

// ───────────── tuner needle (shared widget) ─────────────
function needleHtml() {
  return `<div class="tuner"><div class="tn-note">—</div><div class="tn-bar"><div class="tn-zone"></div><div class="tn-mid"></div><div class="tn-needle"></div></div>
    <div class="tn-scale"><span>-50¢ flat</span><span>in tune</span><span>sharp +50¢</span></div><div class="tn-info small dim">&nbsp;</div></div>`;
}
function drawNeedle(el, sungMidi, target, info) {
  const noteEl = $('.tn-note', el), nd = $('.tn-needle', el);
  if (sungMidi == null) { nd.style.opacity = 0.25; noteEl.style.color = ''; if (info !== undefined) $('.tn-info', el).innerHTML = info || '&nbsp;'; return; }
  const cents = (sungMidi - target) * 100;
  const c = Math.max(-50, Math.min(50, cents));
  el._c = el._c == null ? c : el._c + (c - el._c) * 0.35; // smooth
  nd.style.left = `${50 + el._c}%`; nd.style.opacity = 1;
  const good = Math.abs(cents) <= 15, ok = Math.abs(cents) <= 30;
  nd.style.background = good ? 'var(--good)' : ok ? 'var(--warn)' : 'var(--accent)';
  noteEl.textContent = noteName(sungMidi);
  noteEl.style.color = good ? 'var(--good)' : '';
  $('.tn-info', el).innerHTML = info ?? (Math.abs(cents) < 5 ? 'Spot on' : `${Math.abs(Math.round(cents))}¢ ${cents < 0 ? 'flat, go up a touch' : 'sharp, ease down'}`);
}

// ───────────── live tuner during songs ─────────────
const ref = { midi: null, t: 0 };
export function onRef(m) { ref.midi = m.midi; ref.t = performance.now(); }
export function mountTuner(el) {
  el.innerHTML = needleHtml();
  onPitch((p) => {
    const fresh = ref.midi != null && performance.now() - ref.t < 400;
    if (p.midi == null) return drawNeedle(el, null, 0, fresh ? `Target: ${noteName(foldTo(ref.midi, 60))}` : 'Sing to see your pitch');
    if (fresh) {
      const target = foldTo(ref.midi, p.midi);
      const cents = (p.midi - target) * 100;
      const off = Math.abs(cents) > 60;
      drawNeedle(el, p.midi, target, off
        ? `Target ${noteName(target)}. You're on ${noteName(p.midi)}, ${cents < 0 ? 'go up' : 'go down'}`
        : `Target ${noteName(target)} · ${Math.abs(cents) < 5 ? 'spot on' : `${Math.abs(Math.round(cents))}¢ ${cents < 0 ? 'flat' : 'sharp'}`}`);
    } else drawNeedle(el, p.midi, Math.round(p.midi), undefined);
  });
}

// ───────────── progress store ─────────────
export const progress = {
  get range() { return store.get('karaoke-range', null); },
  set range(r) { store.set('karaoke-range', r); },
  get history() { return store.get('karaoke-history', []); },
  add(entry) { const h = this.history; h.unshift(entry); store.set('karaoke-history', h.slice(0, 200)); },
};

// ───────────── drills ─────────────
let hooks = null, running = null;
export function initPractice(h) { hooks = h; renderPractice(); renderProgress(); }

const DRILLS = {
  range: { name: 'Find my range', desc: 'Sing your lowest and highest comfortable notes. This sets up the other drills and the key suggestions.' },
  hold: { name: 'Hold a note', desc: 'Hear a note, then hold it steady for 4 seconds. Builds breath control and steadiness.' },
  scale: { name: 'Scale warm-up', desc: 'Do-re-mi-fa-so-fa-mi-re-do. Listen to each note, then echo it.' },
  match: { name: 'Pitch matching', desc: '8 random notes from your range. Hear one, sing it back.' },
};

function defaultRange() { return progress.range || { low: 53, high: 65 }; } // F3–F4 until measured
let holdTarget = null;
let scaleShift = 0; // "again, higher" steps for the scale drill

function renderPractice() {
  const box = $('#practice');
  const r = progress.range;
  holdTarget ??= Math.round(((r || defaultRange()).low + (r || defaultRange()).high) / 2);
  box.innerHTML = `
    <div class="card"><div style="font-weight:700">Your range</div>
      <p class="small">${r ? `${noteName(r.low)} – ${noteName(r.high)} · roughly <b>${voiceType(r.low, r.high)}</b>` : 'Not measured yet. Start with “Find my range”.'}</p>
      <p class="small dim">Your mic is muted to the room while a drill runs. Use headphones if your phone speaker is quiet.</p></div>
    ${Object.entries(DRILLS).map(([k, d]) => `<div class="card drill" data-drill="${k}">
      <div class="row"><div class="grow"><div style="font-weight:700">${d.name}</div><div class="small dim">${d.desc}</div></div>
      <button class="primary sm" data-start="${k}">Start</button></div>
      ${k === 'hold' ? `<div class="row small" style="margin-top:8px"><span class="dim">Note</span><button class="sm" data-hold="-1">−</button><b data-holdnote>${noteName(holdTarget)}</b><button class="sm" data-hold="1">＋</button></div>` : ''}
      <div class="drill-run hidden"></div></div>`).join('')}`;
}
document.addEventListener('click', async (e) => {
  const st = e.target.closest('[data-start]');
  if (st) { if (running) running.cancel = true; else { if (st.dataset.start === 'scale') scaleShift = 0; runDrill(st.dataset.start, st.closest('.drill')); } return; }
  const hd = e.target.closest('[data-hold]');
  if (hd) { holdTarget += Number(hd.dataset.hold); $('[data-holdnote]').textContent = noteName(holdTarget); }
});

async function runDrill(kind, card) {
  const run = $('.drill-run', card), btn = $('[data-start]', card);
  running = { cancel: false };
  const me = running;
  btn.textContent = 'Stop';
  run.classList.remove('hidden');
  run.innerHTML = `<div class="drill-msg"></div>${needleHtml()}<div class="dots"></div>`;
  const msg = (t) => ($('.drill-msg', run).innerHTML = t);
  const needle = $('.tuner', run);
  hooks.setRoomMute(true);
  let target = null, collecting = null;
  const off = onPitch((p) => {
    if (collecting) collecting.push(p.midi);
    if (target != null) drawNeedle(needle, p.midi == null ? null : foldTo(p.midi, target), target);
    else drawNeedle(needle, p.midi, p.midi == null ? 0 : Math.round(p.midi), p.midi == null ? '' : undefined);
  });
  const step = async (midi, listen, sing, skip = 0.35) => {
    target = midi;
    msg(`Listen… <b>${noteName(midi)}</b>`);
    playTone(midi, listen);
    await sleep(listen * 1000 + 150);
    if (me.cancel) throw new Error('cancel');
    msg(`Sing <b>${noteName(midi)}</b>`);
    await sleep(skip * 1000);
    collecting = [];
    await sleep((sing - skip) * 1000);
    const res = scoreNote(collecting, midi);
    collecting = null;
    if (me.cancel) throw new Error('cancel');
    return res;
  };
  const dot = (res, label) => {
    const c = !res.sung ? '#555' : Math.abs(res.cents) <= 15 && res.inTune > 0.6 ? 'var(--good)' : Math.abs(res.cents) <= 35 ? 'var(--warn)' : 'var(--accent)';
    $('.dots', run).insertAdjacentHTML('beforeend', `<span class="dot-res" style="border-color:${c}" title="${label}"><b>${label}</b><small>${res.sung ? `${res.cents > 0 ? '+' : ''}${res.cents}¢` : '—'}</small></span>`);
  };
  try {
    if (kind === 'range') {
      const capture = async (what) => {
        msg(`Sing your <b>${what}</b> comfortable note on “ah” and hold it…`);
        target = null;
        const deadline = performance.now() + 20000;
        let streak = [];
        while (performance.now() < deadline && !me.cancel) {
          await sleep(30);
          if (pitch.midi != null && performance.now() - pitch.t < 100) {
            if (streak.length && Math.abs(pitch.midi - streak[streak.length - 1]) > 0.8) streak = [];
            streak.push(pitch.midi);
          } else if (performance.now() - pitch.t > 300) streak = [];
          if (streak.length > 70) break; // ~2 s held
        }
        if (me.cancel) throw new Error('cancel');
        if (streak.length < 70) throw new Error(`Couldn't hear a steady note. Try again a little louder.`);
        const s = streak.slice(20).sort((a, b) => a - b);
        return s[s.length >> 1];
      };
      const low = await capture('lowest');
      msg(`Low note: <b>${noteName(low)}</b>. Nice.`); await sleep(1200);
      const high = await capture('highest');
      if (high - low < 3) throw new Error('Those two notes were very close. Try going lower, then higher.');
      const r = { low: Math.round(low * 10) / 10, high: Math.round(high * 10) / 10 };
      progress.range = r;
      holdTarget = Math.round((r.low + r.high) / 2);
      hooks.sendProfile(r);
      progress.add({ type: 'drill', drill: 'range', date: Date.now(), summary: `${noteName(r.low)}–${noteName(r.high)}` });
      msg(`Your comfortable range: <b>${noteName(r.low)} – ${noteName(r.high)}</b> (${Math.round(r.high - r.low)} semitones, roughly ${voiceType(r.low, r.high)}). Saved. The host uses it to suggest keys.`);
      renderPractice(); renderProgress();
      return;
    }
    const R = defaultRange();
    let notes = [], listen = 0.8, sing = 1.6;
    if (kind === 'hold') { notes = [holdTarget]; listen = 1.2; sing = 4.5; }
    if (kind === 'scale') { const root = Math.round(R.low + 2) + scaleShift; notes = [0, 2, 4, 5, 7, 5, 4, 2, 0].map((x) => root + x); listen = 0.7; sing = 1.4; }
    if (kind === 'match') { for (let i = 0; i < 8; i++) notes.push(Math.round(R.low + 1 + Math.random() * Math.max(1, R.high - R.low - 2))); listen = 0.9; sing = 1.8; }
    const results = [];
    for (const n of notes) { const res = await step(n, listen, sing, kind === 'hold' ? 0.6 : 0.35); results.push(res); dot(res, noteName(n)); }
    target = null;
    const sung = results.filter((r) => r.sung);
    const score = sung.length ? Math.round((sung.reduce((s, r) => s + (Math.abs(r.cents) <= 25 ? 1 : Math.abs(r.cents) <= 50 ? 0.5 : 0), 0) / results.length) * 100) : 0;
    const avg = sung.length ? Math.round(sung.reduce((s, r) => s + r.cents, 0) / sung.length) : null;
    let summary = `${score}%`;
    let text = `Score <b>${score}%</b>`;
    if (avg != null) text += ` · on average ${Math.abs(avg) < 8 ? 'centred' : `${Math.abs(avg)}¢ ${avg < 0 ? 'flat' : 'sharp'}`}`;
    if (kind === 'hold' && sung[0]) { text += ` · in tune ${Math.round(sung[0].inTune * 100)}% of the time · wobble ±${sung[0].steady}¢`; summary += ` · ±${sung[0].steady}¢`; }
    if (!sung.length) text = "I didn't hear you. Check the mic isn't muted and sing a bit louder.";
    else if (score >= 85) text += '. Excellent!';
    else if (avg != null && avg < -20) text += '. Aim slightly higher than feels natural.';
    else if (avg != null && avg > 20) text += '. Relax, you are overshooting a little.';
    msg(text + (kind === 'scale' ? ' <button class="sm" data-higher>Again, ½ step higher</button>' : ''));
    progress.add({ type: 'drill', drill: kind, date: Date.now(), score, summary });
    renderProgress();
  } catch (err) {
    msg(err.message === 'cancel' ? 'Stopped.' : esc(err.message));
  } finally {
    off(); collecting = null; running = null;
    btn.textContent = 'Start';
    hooks.setRoomMute(false);
  }
}
document.addEventListener('click', (e) => {
  if (!e.target.matches('[data-higher]') || running) return;
  scaleShift++;
  runDrill('scale', e.target.closest('.drill'));
});

// ───────────── reports & progress tab ─────────────
export function reportCard(r, { live = false } = {}) {
  const pctTxt = r.accuracy != null ? `${Math.round(r.accuracy * 100)}%` : '—';
  const bias = r.bias == null ? '—' : Math.abs(r.bias) < 8 ? 'centred' : `${Math.round(Math.abs(r.bias))}¢ ${r.bias < 0 ? 'flat' : 'sharp'}`;
  return `<div class="card report"><div class="row"><div class="grow"><div class="small dim">${esc(r.title)} — ${esc(r.artist)}</div><div style="font-weight:700">Your report</div></div>
    <div class="big">${pctTxt}</div></div>
    <div class="stats"><div><small>Tuning</small>${bias}</div><div><small>Long notes</small>${esc(r.steadinessLabel || '—')}</div><div><small>Range</small>${r.range.lowName}–${r.range.highName}</div></div>
    ${r.worstLines?.length ? `<div class="small" style="margin:6px 0"><div class="dim">Lines to practise</div>${r.worstLines.map((l) => `<div class="row" style="margin-top:4px"><span class="grow ellipsis">“${esc(l.text)}” <span class="dim">${Math.round(l.accuracy * 100)}%</span></span>${live ? `<button class="sm" data-practice="${l.line}">🔁 Loop it</button>` : ''}</div>`).join('')}</div>` : ''}
    <ul class="small dim" style="padding-left:18px;margin:6px 0 0">${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}
export function renderProgress() {
  const box = $('#progress'); if (!box) return;
  const h = progress.history;
  const songs = h.filter((x) => x.type === 'song' && x.report.accuracy != null).slice(0, 20).reverse();
  const r = progress.range;
  box.innerHTML = `
    <div class="card"><div style="font-weight:700">Overview</div>
      <div class="stats" style="margin-top:8px"><div><small>Songs sung</small>${h.filter((x) => x.type === 'song').length}</div>
      <div><small>Avg accuracy (last 5)</small>${songs.length ? Math.round((songs.slice(-5).reduce((s, x) => s + x.report.accuracy, 0) / Math.min(5, songs.length)) * 100) + '%' : '—'}</div>
      <div><small>Range</small>${r ? `${noteName(r.low)}–${noteName(r.high)}` : '—'}</div></div>
      ${songs.length > 1 ? '<canvas id="spark" style="width:100%;height:70px;margin-top:10px"></canvas><div class="small dim">Pitch accuracy, last songs</div>' : ''}</div>
    ${h.find((x) => x.type === 'song') ? reportCard(h.find((x) => x.type === 'song').report) : ''}
    <div class="card"><div style="font-weight:700;margin-bottom:6px">History</div>${h.length ? h.slice(0, 40).map((x) => `<div class="row small" style="padding:4px 0;border-bottom:1px solid var(--line)">
      <span class="dim" style="width:72px">${new Date(x.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      <span class="grow ellipsis">${x.type === 'song' ? `🎤 ${esc(x.report.title)}` : `🎯 ${esc(DRILLS[x.drill]?.name || x.drill)}`}</span>
      <b>${x.type === 'song' ? (x.report.accuracy != null ? Math.round(x.report.accuracy * 100) + '%' : '—') : esc(x.summary)}</b></div>`).join('') : '<p class="small dim">Sing a song or run a drill to start tracking.</p>'}
      ${h.length ? '<button class="sm ghost" id="clearHist" style="margin-top:8px">Clear history</button>' : ''}</div>`;
  const cv = $('#spark');
  if (cv) {
    const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const xs = (i) => 6 + (i / (songs.length - 1)) * (W - 12), ys = (v) => H - 6 - v * (H - 12);
    g.strokeStyle = '#ffffff18'; g.beginPath(); g.moveTo(0, ys(0.8)); g.lineTo(W, ys(0.8)); g.stroke();
    g.strokeStyle = '#ff4fa3'; g.lineWidth = 2.5; g.beginPath();
    songs.forEach((x, i) => (i ? g.lineTo(xs(i), ys(x.report.accuracy)) : g.moveTo(xs(i), ys(x.report.accuracy))));
    g.stroke();
    g.fillStyle = '#ff4fa3'; songs.forEach((x, i) => { g.beginPath(); g.arc(xs(i), ys(x.report.accuracy), 3, 0, 7); g.fill(); });
  }
  $('#clearHist')?.addEventListener('click', () => { if (confirm('Clear your singing history on this phone?')) { store.set('karaoke-history', []); renderProgress(); } });
}
export function onReport(report) {
  progress.add({ type: 'song', date: report.date || Date.now(), report });
  renderProgress();
}
export { NOTE };
