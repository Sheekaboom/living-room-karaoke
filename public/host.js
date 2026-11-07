// Host screen: plays music, shows lyrics, receives phone mics over WebRTC and mixes them.
import { NOTE, hzToMidi, fold, credit, buildReport, suggestKey, noteName } from '/training.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; };
const COLORS = ['#4fd8ff', '#ffc24f', '#5be38f', '#c08bff', '#ff7a59', '#ff4fa3'];
function toast(msg, ms = 4000) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

let info = null;
let party = { queue: [], now: null, singers: [] };
let ws = null, myId = null;
let ctx = null, wasmBytes = null, musicDsp = null, dspLatency = 0;
const nodes = {};
const peers = new Map();
let current = null; // { item, kind: 'local'|'spotify', ai, playUri, offset }
let lyr = null, lyrIdx = -2;
let advancing = null;
let lastFinished = null; // the song (and its data) that just ended, for practice requests

// ───────────── settings (persisted) ─────────────
const settingsIds = ['musicVol', 'guideVol', 'semitones', 'cut', 'width', 'micVol', 'reverb', 'echo', 'tune', 'tuneSpeed'];
const S = {};
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('karaoke-host') || '{}'); } catch {}
  for (const id of settingsIds) {
    const el = $('#' + id);
    if (saved[id] != null) el.value = saved[id];
    S[id] = Number(el.value);
    const out = $('#o-' + id);
    const show = () => { out.textContent = id === 'semitones' ? (S[id] > 0 ? '+' : '') + S[id] : Math.round(S[id] * 100) + '%'; };
    show();
    el.addEventListener('input', () => { S[id] = Number(el.value); show(); applySettings(); saveSettings(); });
  }
  const key = $('#tuneKey');
  NOTE.forEach((n, i) => key.insertAdjacentHTML('beforeend', `<option value="${i}">${n} major</option>`));
  key.value = saved.tuneKey ?? '-1';
  S.tuneKey = Number(key.value);
  key.addEventListener('change', () => { S.tuneKey = Number(key.value); applySettings(); saveSettings(); });
}
const saveSettings = () => localStorage.setItem('karaoke-host', JSON.stringify(S));

function applySettings() {
  if (!ctx) return;
  const t = ctx.currentTime;
  nodes.musicVol.gain.setTargetAtTime(S.musicVol, t, 0.03);
  nodes.guide.gain.setTargetAtTime(current?.ai ? S.guideVol : 0, t, 0.03);
  nodes.micBus.gain.setTargetAtTime(S.micVol, t, 0.03);
  nodes.reverbWet.gain.setTargetAtTime(S.reverb * 0.9, t, 0.03);
  nodes.echoWet.gain.setTargetAtTime(S.echo, t, 0.03);
  const spectral = current?.kind === 'local' && current.item.mode === 'karaoke' && !current.ai;
  musicDsp?.port.postMessage({ cut: spectral ? S.cut : 0, width: S.width, semitones: current?.kind === 'local' ? S.semitones : 0 });
  for (const p of peers.values()) p.voice?.port.postMessage({ tune: S.tune, speed: S.tuneSpeed, key: S.tuneKey });
  if (spPlayer) spPlayer.setVolume(Math.min(1, S.musicVol)).catch(() => {});
}

// ───────────── audio graph ─────────────
function impulse(seconds = 2.4, decay = 3.2) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
async function initAudio() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  wasmBytes = await (await fetch('/dsp.wasm')).arrayBuffer();
  await ctx.audioWorklet.addModule('/dsp-worklet.js');

  nodes.musicEl = new Audio(); nodes.musicEl.preload = 'auto';
  nodes.guideEl = new Audio(); nodes.guideEl.preload = 'auto';
  const mSrc = ctx.createMediaElementSource(nodes.musicEl);
  const gSrc = ctx.createMediaElementSource(nodes.guideEl);
  nodes.guide = ctx.createGain(); nodes.guide.gain.value = 0;
  musicDsp = new AudioWorkletNode(ctx, 'music-dsp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { wasm: wasmBytes } });
  musicDsp.port.onmessage = ({ data }) => {
    if (data.ready) { dspLatency = data.latency; applySettings(); }
    if (data.error) toast('WASM DSP failed to load: ' + data.error);
  };
  nodes.musicVol = ctx.createGain();
  nodes.master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.15;
  mSrc.connect(musicDsp);
  gSrc.connect(nodes.guide).connect(musicDsp); // guide vocal follows key changes too
  musicDsp.connect(nodes.musicVol).connect(nodes.master);
  nodes.master.connect(limiter).connect(ctx.destination);

  // reference pitch from the isolated vocal stem (for scoring)
  nodes.refYin = new AudioWorkletNode(ctx, 'voice-dsp', { outputChannelCount: [1], processorOptions: { wasm: wasmBytes } });
  const refSink = ctx.createGain(); refSink.gain.value = 0;
  gSrc.connect(nodes.refYin).connect(refSink).connect(ctx.destination);
  nodes.refYin.port.onmessage = ({ data }) => onRefPitch(data);

  // mic bus: compressor -> dry + reverb + echo
  nodes.micBus = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.12;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
  nodes.micBus.connect(hp).connect(comp);
  comp.connect(nodes.master);
  const conv = ctx.createConvolver(); conv.buffer = impulse();
  nodes.reverbWet = ctx.createGain();
  comp.connect(conv).connect(nodes.reverbWet).connect(nodes.master);
  const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.32;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const dtone = ctx.createBiquadFilter(); dtone.type = 'lowpass'; dtone.frequency.value = 3500;
  nodes.echoWet = ctx.createGain();
  comp.connect(delay); delay.connect(dtone).connect(fb).connect(delay);
  dtone.connect(nodes.echoWet).connect(nodes.master);

  nodes.musicEl.addEventListener('ended', songEnded);
  nodes.musicEl.addEventListener('pause', () => { nodes.guideEl.pause(); updatePlayBtn(); });
  nodes.musicEl.addEventListener('play', () => { syncGuide(true); nodes.guideEl.src && nodes.guideEl.play().catch(() => {}); updatePlayBtn(); });
  nodes.musicEl.addEventListener('seeked', () => syncGuide(true));
  nodes.musicEl.addEventListener('error', () => current?.kind === 'local' && toast('Could not play that file in this browser.'));
  applySettings();
}
function syncGuide(force) {
  const m = nodes.musicEl, g = nodes.guideEl;
  if (!g.src || !current?.ai) return;
  if (force || Math.abs(g.currentTime - m.currentTime) > 0.05) g.currentTime = m.currentTime;
}

// ───────────── websocket ─────────────
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'host', name: 'Host' }));
  ws.onclose = (e) => {
    if (e.code === 4000) { toast('Another host screen took over. Reload to take it back.', 10000); return; }
    setTimeout(connect, 1500);
  };
  ws.onmessage = async ({ data }) => {
    const m = JSON.parse(data);
    if (m.type === 'welcome') myId = m.id;
    else if (m.type === 'state') { party = m.state; renderQueue(); renderSingers(); }
    else if (m.type === 'signal') onSignal(m.from, m.name, m.data);
    else if (m.type === 'peer-gone') closePeer(m.id);
    else if (m.type === 'control') onControl(m);
    else if (m.type === 'stems') onStems(m.track);
    else if (m.type === 'library-changed') searchLibrary();
  };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

// ───────────── WebRTC (phones -> host) ─────────────
function createPeer(id, name) {
  const color = COLORS[[...peers.keys()].length % COLORS.length];
  const pc = new RTCPeerConnection({ iceServers: [] });
  const p = { id, name, pc, color, gain: ctx.createGain(), pending: [], hist: [], last: null, hits: 0, total: 0, rms: 0, vol: 1, frames: [] };
  pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', to: id, data: { candidate: e.candidate } });
  pc.ontrack = (e) => {
    try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; else e.receiver.playoutDelayHint = 0; } catch {}
    const stream = e.streams[0] || new MediaStream([e.track]);
    p.el = new Audio(); p.el.srcObject = stream; p.el.muted = true; p.el.play().catch(() => {}); // Chrome needs this for WebAudio to receive remote audio
    p.src = ctx.createMediaStreamSource(stream);
    p.voice = new AudioWorkletNode(ctx, 'voice-dsp', { outputChannelCount: [1], processorOptions: { wasm: wasmBytes } });
    p.voice.port.onmessage = ({ data }) => onSingerPitch(p, data);
    p.voice.port.postMessage({ tune: S.tune, speed: S.tuneSpeed, key: S.tuneKey });
    p.src.connect(p.voice).connect(p.gain).connect(nodes.micBus);
    renderSingers();
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') closePeer(id); renderSingers(); };
  peers.set(id, p);
  return p;
}
async function onSignal(from, name, data) {
  if (!ctx) return;
  let p = peers.get(from);
  if (data.sdp?.type === 'offer') {
    if (p) closePeer(from);
    p = createPeer(from, name);
    await p.pc.setRemoteDescription(data.sdp);
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    send({ type: 'signal', to: from, data: { sdp: p.pc.localDescription } });
    for (const c of p.pending.splice(0)) p.pc.addIceCandidate(c).catch(() => {});
  } else if (data.candidate && p) {
    if (p.pc.remoteDescription) p.pc.addIceCandidate(data.candidate).catch(() => {});
    else p.pending.push(data.candidate);
  }
}
function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  try { p.pc.close(); p.src?.disconnect(); p.voice?.disconnect(); p.gain.disconnect(); p.el && (p.el.srcObject = null); } catch {}
  peers.delete(id);
  renderSingers();
}
function onControl(m) {
  const p = peers.get(m.from);
  if (m.action === 'micvol' && p) { p.vol = Math.max(0, Math.min(3, Number(m.value) || 0)); p.gain.gain.setTargetAtTime(p.vol, ctx.currentTime, 0.03); }
  else if (m.action === 'playpause') togglePlay();
  else if (m.action === 'skip') skip();
  else if (m.action === 'restart') seekTo(0);
  else if (m.action === 'loop') toggleLoop();
  else if (m.action === 'speed') setSpeed(Number(m.value) || 1);
  else if (m.action === 'practice' && lastFinished) practiceLine(lastFinished.item, Number(m.value));
}

// ───────────── pitch + scoring ─────────────
const ref = { hist: [], last: null };
function onRefPitch(d) {
  const now = performance.now() / 1000;
  const voiced = d.pitch > 0 && d.clarity > 0.75 && current?.ai && !nodes.musicEl.paused;
  const midi = voiced ? hzToMidi(d.pitch) + S.semitones : null;
  ref.last = { t: now, midi };
  ref.hist.push({ t: now, midi });
  if (voiced) current.refMidis.push(midi - S.semitones);
  if (current?.ai && now - (ref.sent || 0) > 0.05) { ref.sent = now; send({ type: 'ref', midi }); }
  while (ref.hist.length && ref.hist[0].t < now - 8) ref.hist.shift();
}
function onSingerPitch(p, d) {
  const now = performance.now() / 1000;
  p.rms = d.rms;
  const voiced = d.pitch > 0 && d.clarity > 0.7;
  const midi = voiced ? hzToMidi(d.pitch) : null;
  p.last = { t: now, midi, target: d.target > 0 ? hzToMidi(d.target) : null };
  p.hist.push({ t: now, midi });
  while (p.hist.length && p.hist[0].t < now - 8) p.hist.shift();
  // Score against the reference vocal a little in the past (the singer hears the music late,
  // and their voice arrives over the network late). Best match in a 100-450 ms window.
  if (midi != null && current && isPlaying()) {
    let best = null;
    if (current.ai) {
      for (const r of ref.hist) {
        if (r.midi == null || r.t < now - 0.45 || r.t > now - 0.1) continue;
        const diff = fold(midi - r.midi);
        if (best == null || Math.abs(diff) < Math.abs(best)) best = diff;
      }
      if (best != null) { p.total++; p.hits += credit(Math.abs(best)); }
    }
    p.frames.push({ pos: position(), midi, d: best, line: lyrIdx });
  }
}
function resetScores() { for (const p of peers.values()) { p.hits = 0; p.total = 0; p.frames = []; } }

const cv = $('#pitch'), g2 = cv.getContext('2d');
let centerMidi = 60;
function drawPitch() {
  const dpr = devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, W, H);
  const now = performance.now() / 1000, span = 6, range = 11;
  const recent = [...ref.hist, ...[...peers.values()].flatMap((p) => p.hist)].filter((x) => x.midi != null && x.t > now - 3);
  if (recent.length > 10) {
    const srt = recent.map((x) => x.midi).sort((a, b) => a - b);
    centerMidi += (srt[srt.length >> 1] - centerMidi) * 0.02;
  }
  const y = (m) => H / 2 - ((m - centerMidi) / range) * (H / 2 - 8);
  const x = (t) => W - ((now - t) / span) * W;
  // semitone grid
  g2.strokeStyle = '#ffffff10'; g2.lineWidth = 1;
  for (let m = Math.floor(centerMidi - range); m <= centerMidi + range; m++) {
    if (((m % 12) + 12) % 12 === 0) { g2.strokeStyle = '#ffffff26'; } else g2.strokeStyle = '#ffffff0c';
    g2.beginPath(); g2.moveTo(0, y(m)); g2.lineTo(W, y(m)); g2.stroke();
  }
  // reference = thick bars
  g2.strokeStyle = '#ff4fa366'; g2.lineWidth = 9; g2.lineCap = 'round';
  strokeTrack(ref.hist, x, y, (m) => m);
  // singers = thin lines, octave-folded onto the reference (or the view centre)
  for (const p of peers.values()) {
    g2.strokeStyle = p.color; g2.lineWidth = 3;
    strokeTrack(p.hist, x, y, (m, t) => {
      const r = nearestRef(t);
      const anchor = r ?? centerMidi;
      return anchor + fold(m - anchor);
    });
  }
  // labels
  const lbl = [];
  for (const p of peers.values()) {
    if (p.last?.midi != null && now - p.last.t < 0.3) {
      const n = Math.round(p.last.midi);
      lbl.push(`<span style="color:${p.color}">${esc(p.name)}: ${NOTE[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}</span>`);
    }
  }
  $('#pitchHint').innerHTML = lbl.join(' · ') || (peers.size ? (current?.ai ? 'Sing! Pink bars are the original vocal.' : 'Pitch tracking (scores need an AI-separated local song)') : 'Connect a phone to see your pitch here');
  $('#scores').innerHTML = [...peers.values()].filter((p) => p.total > 20)
    .map((p) => `<span style="color:${p.color}">${esc(p.name)} ${Math.round((p.hits / p.total) * 100)}%</span>`).join('');
}
function nearestRef(t) {
  let best = null, bd = 0.15;
  for (const r of ref.hist) { const d = Math.abs(r.t - (t - 0.25)); if (d < bd && r.midi != null) { bd = d; best = r.midi; } }
  return best;
}
function strokeTrack(hist, x, y, map) {
  g2.beginPath();
  let pen = false, lastT = 0;
  for (const h of hist) {
    if (h.midi == null || h.t - lastT > 0.08) { pen = false; }
    if (h.midi != null) {
      const px = x(h.t), py = y(map(h.midi, h.t));
      pen ? g2.lineTo(px, py) : g2.moveTo(px, py);
      pen = true;
    }
    lastT = h.t;
  }
  g2.stroke();
}

// ───────────── Spotify ─────────────
let spPlayer = null, spDevice = null, spState = null, spExpect = null, spStartedAt = 0;
async function spToken() {
  const r = await fetch('/api/spotify/token');
  if (!r.ok) throw new Error('Spotify not logged in');
  return (await r.json()).token;
}
async function spApi(method, path, body) {
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${await spToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 204) throw Object.assign(new Error(`Spotify ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
}
function initSpotify() {
  if (spPlayer || !info?.spotify.loggedIn || location.hostname !== '127.0.0.1') return Promise.resolve();
  return new Promise((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = async () => {
      spPlayer = new Spotify.Player({ name: 'Karaoke Host', getOAuthToken: (cb) => spToken().then(cb).catch(() => {}), volume: Math.min(1, S.musicVol) });
      spPlayer.addListener('ready', ({ device_id }) => { spDevice = device_id; $('#spStatus').textContent = 'Spotify player ready.'; resolve(); });
      spPlayer.addListener('not_ready', () => { spDevice = null; $('#spStatus').textContent = 'Spotify player offline.'; });
      spPlayer.addListener('initialization_error', ({ message }) => toast('Spotify: ' + message));
      spPlayer.addListener('authentication_error', ({ message }) => toast('Spotify login problem: ' + message));
      spPlayer.addListener('account_error', () => toast('Spotify playback needs a Premium account.', 8000));
      spPlayer.addListener('playback_error', ({ message }) => toast('Spotify: ' + message));
      spPlayer.addListener('player_state_changed', onSpState);
      await spPlayer.connect();
      setTimeout(resolve, 8000);
    };
    const s = document.createElement('script'); s.src = 'https://sdk.scdn.co/spotify-player.js'; document.head.appendChild(s);
  });
}
function onSpState(s) {
  if (!s || current?.kind !== 'spotify') return;
  const tr = s.track_window?.current_track;
  const uris = [tr?.uri, tr?.linked_from?.uri].filter(Boolean);
  const prev = spState;
  spState = { position: s.position, duration: s.duration, paused: s.paused, ts: performance.now(), uri: tr?.uri };
  updatePlayBtn();
  if (performance.now() - spStartedAt < 3000) return;
  const wrongTrack = spExpect && tr && !uris.includes(spExpect) && !uris.some((u) => u.split(':').pop() === spExpect.split(':').pop());
  const finished = s.paused && s.position === 0 && prev && prev.position > prev.duration - 4000;
  if (wrongTrack || finished) { spPlayer.pause().catch(() => {}); songEnded(); }
}
async function playSpotify(uri) {
  await initSpotify();
  if (!spDevice) throw new Error('Spotify player is not ready. Is this a Premium account?');
  spExpect = uri; spStartedAt = performance.now(); spState = null;
  try { await spApi('PUT', `/me/player/play?device_id=${spDevice}`, { uris: [uri] }); }
  catch (e) {
    if (e.status !== 404) throw e;
    await spApi('PUT', '/me/player', { device_ids: [spDevice], play: false });
    await spApi('PUT', `/me/player/play?device_id=${spDevice}`, { uris: [uri] });
  }
}

// ───────────── playback ─────────────
function isPlaying() {
  if (!current) return false;
  return current.kind === 'local' ? !nodes.musicEl.paused : !!spState && !spState.paused;
}
function position() { // seconds, as heard
  if (!current) return 0;
  if (current.kind === 'local') return Math.max(0, nodes.musicEl.currentTime - dspLatency - (ctx?.outputLatency || 0));
  if (!spState) return 0;
  return (spState.position + (spState.paused ? 0 : performance.now() - spState.ts)) / 1000;
}
function duration() {
  if (!current) return 0;
  if (current.kind === 'local') return nodes.musicEl.duration || current.item.duration / 1000 || 0;
  return (spState?.duration || current.item.duration || 0) / 1000;
}
async function stopAll() {
  nodes.musicEl.pause(); nodes.guideEl.pause();
  for (const el of [nodes.musicEl, nodes.guideEl]) { el.defaultPlaybackRate = 1; el.playbackRate = 1; }
  nodes.musicEl.removeAttribute('src'); nodes.guideEl.removeAttribute('src');
  if (spPlayer && current?.kind === 'spotify') await spPlayer.pause().catch(() => {});
}

async function playItem(item, opts = {}) {
  clearTimeout(advancing?.timer); advancing = null; $('#upNext').classList.add('hidden');
  await stopAll();
  resetScores();
  current = { item, kind: item.source, ai: false, offset: 0, note: '', refMidis: [], loop: null, speed: 1, pendingLoopLine: opts.loopLine ?? null, songRange: null, keyTip: '' };
  $('#speed').value = '1'; updateLoopBtn();
  lyr = null; lyrIdx = -2; renderLyrics(0, true);
  send({ type: 'now', now: item, shift: item.qid });
  renderNow();
  loadLyrics(item);
  try {
    if (item.source === 'local') {
      const tr = await (await fetch(`/api/track/${item.id}`)).json().catch(() => null);
      const stems = tr?.stems === 'ready';
      current.songRange = tr?.vocalRange || null;
      const singerRange = party.singers.find((x) => x.name === item.singer)?.range;
      const k = suggestKey(current.songRange, singerRange);
      if (k && Math.abs(k.semitones) >= 1 && k.semitones !== S.semitones)
        current.keyTip = ` <span class="badge">Suggested key for ${esc(item.singer)}: ${k.semitones > 0 ? '+' : ''}${k.semitones}</span> <button class="sm" id="btnKey" data-k="${k.semitones}">Apply</button>`;
      if (opts.loopLine != null) setSpeed(0.85);
      if (item.mode === 'karaoke' && stems) {
        current.ai = true;
        nodes.musicEl.src = `/media/${item.id}/instrumental`;
        nodes.guideEl.src = `/media/${item.id}/vocals`;
        current.note = '<span class="badge good">AI-separated (Demucs)</span>';
      } else {
        nodes.musicEl.src = `/media/${item.id}/original`;
        current.note = item.mode === 'karaoke'
          ? `<span class="badge pink">Spectral vocal removal (WASM)</span>${info.demucs ? ` <button class="sm" id="btnMakeAI">Make AI version</button>` : ''}`
          : '<span class="badge">Original</span>';
      }
      current.note += current.keyTip;
      if (opts.loopLine != null) current.note += ' <span class="badge warn">Practice loop</span>';
      applySettings();
      await nodes.musicEl.play();
    } else {
      let uri = item.id;
      if (item.mode === 'karaoke') {
        const r = await fetch(`/api/spotify/karaoke?${new URLSearchParams({ title: item.title, artist: item.artist, duration: item.duration, id: item.id })}`);
        const list = r.ok ? await r.json() : [];
        if (list[0]) {
          uri = list[0].id;
          current.alts = list;
          current.note = `<span class="badge pink">Karaoke version</span> <span class="dim">${esc(list[0].title)} — ${esc(list[0].artist)}</span>` +
            (list.length > 1 ? ` <button class="sm" id="btnAlt">Try another</button>` : '');
        } else current.note = '<span class="badge warn">No karaoke version found on Spotify, playing original</span>';
      } else current.note = '<span class="badge">Original (Spotify)</span>';
      current.playUri = uri;
      applySettings();
      await playSpotify(uri);
    }
  } catch (e) {
    toast(e.message || String(e), 7000);
  }
  renderNow();
}
async function tryAltKaraoke() {
  if (!current?.alts?.length) return;
  current.altIdx = ((current.altIdx || 0) + 1) % current.alts.length;
  const alt = current.alts[current.altIdx];
  current.note = `<span class="badge pink">Karaoke version</span> <span class="dim">${esc(alt.title)} — ${esc(alt.artist)}</span> <button class="sm" id="btnAlt">Try another</button>`;
  renderNow();
  await playSpotify(alt.id).catch((e) => toast(e.message));
}
function makeReports(fin) {
  const lines = fin.lyrLines;
  // remember how high/low this song's lead vocal goes, for future key suggestions
  if (fin.ai && fin.item.source === 'local' && fin.refMidis.length > 300) {
    const s = [...fin.refMidis].sort((a, b) => a - b), q = (p) => s[Math.round(p * (s.length - 1))];
    fetch(`/api/vocal-range/${fin.item.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ low: q(0.05), high: q(0.95) }) }).catch(() => {});
  }
  const out = [];
  for (const p of peers.values()) {
    const singerRange = party.singers.find((x) => x.id === p.id)?.range;
    const r = buildReport(p.frames, { lines, songRange: fin.songRange, singerRange });
    if (!r) continue;
    Object.assign(r, { name: p.name, color: p.color, title: fin.item.title, artist: fin.item.artist, date: Date.now() });
    send({ type: 'relay', to: p.id, msg: { type: 'report', report: r } });
    out.push(r);
  }
  return out;
}
function reportHtml(r) {
  const pctTxt = r.accuracy != null ? `${Math.round(r.accuracy * 100)}%` : '—';
  const bias = r.bias == null ? '—' : Math.abs(r.bias) < 8 ? 'centred' : `${Math.round(Math.abs(r.bias))}¢ ${r.bias < 0 ? 'flat' : 'sharp'}`;
  return `<div class="rep" style="--c:${r.color}">
    <div class="rep-h"><b>${esc(r.name)}</b><span class="rep-score">${pctTxt}<small>${r.accuracy != null ? 'pitch accuracy' : 'no reference'}</small></span></div>
    <div class="rep-stats"><div><small>Tuning</small>${bias}</div><div><small>Long notes</small>${esc(r.steadinessLabel || '—')}</div><div><small>Range used</small>${r.range.lowName}–${r.range.highName}</div><div><small>Sang for</small>${r.seconds}s</div></div>
    ${r.worstLines.length ? `<div class="rep-lines"><small>Lines to practise</small>${r.worstLines.map((l) => `<div class="row"><span class="grow ellipsis">“${esc(l.text)}” <span class="dim">${Math.round(l.accuracy * 100)}%</span></span><button class="sm" data-practice="${l.line}">🔁 Loop it</button></div>`).join('')}</div>` : ''}
    <ul class="rep-tips">${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}
function songEnded() {
  if (!current) return;
  const fin = current;
  fin.lyrLines = lyr?.synced || null;
  stopLoop();
  const reports = makeReports(fin);
  lastFinished = fin;
  current = null;
  send({ type: 'now', now: null });
  renderNow(); renderLyrics(0, true);
  const box = $('#upNext');
  let n = reports.length ? 25 : 5;
  const tick = () => {
    const nxt = party.queue[0];
    if (!nxt && !reports.length) { box.classList.add('hidden'); advancing = null; return; }
    box.innerHTML = `<div class="interstitial">
      ${reports.length ? `<div class="reports">${reports.map(reportHtml).join('')}</div>` : ''}
      ${nxt ? `<div class="upnext"><span class="dim small">Up next</span> <b>${esc(nxt.title)}</b> <span class="dim">${esc(nxt.artist)}</span> · <span style="color:var(--accent)">🎤 ${esc(nxt.singer || 'Anyone')}</span>
        <span class="small dim">starting in ${n}s</span> <button class="sm primary" data-go>Start now</button> <button class="sm" data-hold>Wait</button></div>`
        : `<div class="upnext"><button class="sm" data-close>Close</button></div>`}</div>`;
    box.classList.remove('hidden');
    if (nxt && n-- <= 0) { box.classList.add('hidden'); advancing = null; playItem(party.queue[0]); return; }
    advancing = { timer: setTimeout(tick, 1000), fin };
  };
  tick();
}
$('#upNext').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.practice != null && advancing?.fin) practiceLine(advancing.fin.item, Number(b.dataset.practice));
  else if (b.hasAttribute('data-go')) { clearTimeout(advancing?.timer); advancing = null; playNext(); }
  else if (b.hasAttribute('data-hold')) { clearTimeout(advancing?.timer); b.closest('.upnext').querySelector('.small').textContent = 'waiting'; b.remove(); }
  else if (b.hasAttribute('data-close')) { clearTimeout(advancing?.timer); advancing = null; $('#upNext').classList.add('hidden'); }
});

// ───────────── practice: loop a line, slow down ─────────────
function lineRange(i) {
  const L = lyr?.synced;
  if (!L || i < 0 || i >= L.length) { const p = position(); return { a: Math.max(0, p - 4), b: p + 4, line: -1 }; }
  const a = Math.max(0, L[i][0] - 0.6 - current.offset);
  const b = (L[i + 1]?.[0] ?? L[i][0] + 6) - 0.05 - current.offset;
  return { a, b: Math.max(b, a + 1.5), line: i };
}
function setLoopLine(i) {
  if (!current) return;
  current.loop = lineRange(i);
  updateLoopBtn();
}
function toggleLoop() {
  if (!current) return;
  if (current.loop) stopLoop(); else setLoopLine(Math.max(0, lyrIdx));
}
function stopLoop() { if (current) current.loop = null; updateLoopBtn(); }
function updateLoopBtn() {
  const on = !!current?.loop;
  $('#btnLoop').classList.toggle('on', on);
  $('#btnLoop').textContent = on ? (current.loop.line >= 0 ? `🔁 Line ${current.loop.line + 1}` : '🔁 Looping') : '🔁 Loop line';
}
function setSpeed(v) {
  if (!current || current.kind !== 'local') { $('#speed').value = '1'; return; }
  current.speed = v;
  $('#speed').value = String(v);
  // defaultPlaybackRate survives the media load that happens when src changes
  for (const el of [nodes.musicEl, nodes.guideEl]) { el.preservesPitch = true; el.defaultPlaybackRate = v; el.playbackRate = v; }
}
function practiceLine(item, line) {
  clearTimeout(advancing?.timer); advancing = null; $('#upNext').classList.add('hidden');
  playItem({ ...item, qid: 'practice-' + Math.random().toString(36).slice(2, 8) }, { loopLine: line });
}
function playNext() { if (party.queue[0]) playItem(party.queue[0]); else toast('The queue is empty.'); }
function skip() { if (!current && advancing) { clearTimeout(advancing.timer); advancing = null; $('#upNext').classList.add('hidden'); return playNext(); } if (current) { stopAll(); songEnded(); } else playNext(); }
function togglePlay() {
  if (!current) return playNext();
  if (current.kind === 'local') nodes.musicEl.paused ? nodes.musicEl.play() : nodes.musicEl.pause();
  else spPlayer?.togglePlay();
  setTimeout(updatePlayBtn, 100);
}
function seekTo(sec) {
  if (!current) return;
  if (current.kind === 'local') nodes.musicEl.currentTime = sec;
  else spPlayer?.seek(Math.round(sec * 1000));
}
const updatePlayBtn = () => { $('#btnPlay').textContent = isPlaying() ? '❚❚' : '▶︎'; };

function onStems(track) {
  libCache.set(track.id, track);
  renderLibRow(track);
  if (current?.kind === 'local' && current.item.id === track.id && current.item.mode === 'karaoke' && !current.ai && track.stems === 'ready') {
    // upgrade the song that's playing right now, without losing our place
    const t = nodes.musicEl.currentTime, playing = !nodes.musicEl.paused;
    current.ai = true;
    current.note = '<span class="badge good">AI-separated (Demucs)</span>';
    nodes.musicEl.src = `/media/${track.id}/instrumental`;
    nodes.guideEl.src = `/media/${track.id}/vocals`;
    nodes.musicEl.currentTime = t;
    applySettings();
    if (playing) nodes.musicEl.play();
    renderNow();
    toast('AI karaoke track ready, switched over.');
  } else if (current?.item.id === track.id) renderNow();
}

// ───────────── lyrics ─────────────
async function loadLyrics(item) {
  const q = new URLSearchParams({ artist: item.artist, title: item.title, album: item.album || '', duration: item.duration || 0 });
  try {
    const r = await (await fetch(`/api/lyrics?${q}`)).json();
    if (current?.item.qid !== item.qid) return;
    lyr = r; lyrIdx = -2;
    if (current.pendingLoopLine != null) { setLoopLine(current.pendingLoopLine); current.pendingLoopLine = null; seekTo(current.loop.a); }
  } catch { lyr = null; }
  renderLyrics(position(), true);
}
function lineDur(i) {
  const L = lyr.synced, a = L[i][0], b = L[i + 1]?.[0] ?? a + 5;
  return Math.min(b - a, Math.max(1.2, L[i][1].length * 0.075));
}
function renderLyrics(pos, force) {
  const box = $('#lyrics');
  if (!current) { box.innerHTML = party.queue.length ? '' : '<div class="ln dim" style="opacity:.5">Add a song to get started 🎶</div>'; lyrIdx = -2; return; }
  if (!lyr) { if (force) box.innerHTML = '<div class="ln dim">Looking for lyrics…</div>'; return; }
  if (!lyr.synced) {
    if (force || !box.querySelector('.plain')) box.innerHTML = lyr.plain ? `<div class="plain">${esc(lyr.plain)}</div>` : `<div class="ln dim">${lyr.instrumental ? 'Instrumental' : 'No lyrics found for this song'}</div>`;
    const pl = box.querySelector('.plain'); const d = duration();
    if (pl && d) pl.scrollTop = (pl.scrollHeight - pl.clientHeight) * Math.min(1, pos / d);
    return;
  }
  const L = lyr.synced, t = pos + current.offset;
  let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k][0] <= t) i = k; else break; }
  if (i !== lyrIdx || force) {
    lyrIdx = i;
    const txt = (k) => (k >= 0 && k < L.length ? (L[k][1] || '♪') : '');
    box.innerHTML = `<div class="ln prev">${esc(txt(i - 1))}&nbsp;</div><div class="ln cur">${esc(i >= 0 ? txt(i) : '')}&nbsp;</div>
      <div class="ln next">${esc(txt(i + 1))}&nbsp;</div><div class="ln next2">${esc(txt(i + 2))}&nbsp;</div>`;
    send({ type: 'lyric', cur: i >= 0 ? txt(i) : '', next: txt(i + 1), next2: txt(i + 2) });
  }
  const cur = box.querySelector('.cur');
  if (i >= 0) cur.style.setProperty('--p', Math.min(1, (t - L[i][0]) / lineDur(i)).toFixed(3));
  else {
    const until = L[0][0] - t;
    cur.innerHTML = until < 4 ? `<span class="dots">${'●'.repeat(Math.ceil(until))}</span>` : '&nbsp;';
  }
}

// ───────────── UI rendering ─────────────
function renderNow() {
  const it = current?.item;
  $('#npTitle').textContent = it ? it.title : 'Nothing playing';
  $('#npArtist').textContent = it ? `${it.artist}${it.album ? ' — ' + it.album : ''}` : (party.queue.length ? 'Press Play next to start' : 'Add songs from the right, or from a phone');
  $('#npSinger').textContent = it ? `🎤 ${it.singer || 'Anyone'}` : '';
  $('#npArt').src = it?.art || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  $('#npMode').innerHTML = current?.note || '';
  $('#btnMakeAI')?.addEventListener('click', makeAI);
  $('#btnAlt')?.addEventListener('click', tryAltKaraoke);
  $('#btnKey')?.addEventListener('click', (e) => {
    const k = Number(e.target.dataset.k), el = $('#semitones');
    el.value = k; el.dispatchEvent(new Event('input'));
    current.note = current.note.replace(current.keyTip, ` <span class="badge good">Key ${k > 0 ? '+' : ''}${k}</span>`);
    renderNow();
  });
  updatePlayBtn();
}
async function makeAI(e) {
  const id = current?.item.id;
  e.target.disabled = true; e.target.textContent = 'Separating…';
  const r = await fetch(`/api/separate/${id}`, { method: 'POST' });
  if (!r.ok) toast((await r.json()).error || 'Failed');
}
function trackHtml(t, acts) {
  return `<div class="track" data-id="${esc(t.id)}">${t.art ? `<img src="${esc(t.art)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noart'}))">` : '<div class="noart"></div>'}
    <div class="meta"><div class="t ellipsis">${esc(t.title)}</div><div class="a ellipsis">${esc(t.artist)}${t.extra || ''}</div></div><div class="acts">${acts}</div></div>`;
}
function renderQueue() {
  const q = party.queue;
  $('#queue').innerHTML = q.length ? q.map((it, i) => trackHtml({ ...it, id: it.qid, extra: ` · <span style="color:var(--accent)">🎤 ${esc(it.singer || 'Anyone')}</span>` },
    `<button class="sm ${it.mode === 'karaoke' ? 'on' : ''}" data-q="mode" title="Toggle karaoke/original">${it.mode === 'karaoke' ? 'Karaoke' : 'Original'}</button>
     <button class="sm" data-q="up" ${i ? '' : 'disabled'}>↑</button><button class="sm" data-q="down" ${i < q.length - 1 ? '' : 'disabled'}>↓</button><button class="sm" data-q="del">✕</button>`)).join('')
    : '<p class="dim small">Queue is empty. Add songs from Library or Spotify, or from a phone.</p>';
  if (!current) renderNow();
  if (!current && !advancing) renderLyrics(0, true);
}
$('#queue').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]'); if (!b) return;
  const qid = b.closest('.track').dataset.id, it = party.queue.find((x) => x.qid === qid);
  if (b.dataset.q === 'del') send({ type: 'queue:remove', qid });
  if (b.dataset.q === 'up') send({ type: 'queue:move', qid, dir: -1 });
  if (b.dataset.q === 'down') send({ type: 'queue:move', qid, dir: 1 });
  if (b.dataset.q === 'mode') send({ type: 'queue:mode', qid, mode: it.mode === 'karaoke' ? 'original' : 'karaoke' });
});
function renderSingers() {
  const names = party.singers.map((s) => s.name);
  for (const sel of [$('#singerPick'), $('#singerPick2')]) {
    const v = sel.value;
    sel.innerHTML = ['Anyone', ...new Set(names), 'Host'].map((n) => `<option>${esc(n)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === v)) sel.value = v;
  }
  $('#singers').innerHTML = party.singers.length ? party.singers.map((s) => {
    const p = peers.get(s.id);
    const st = p ? (p.src ? 'connected' : p.pc.connectionState) : 'waiting for mic';
    return `<div class="singerRow" data-id="${s.id}"><span class="dot" style="background:${p?.color || '#555'}"></span><span class="grow">${esc(s.name)} <span class="small dim">${esc(st)}</span></span>
      <div class="vu"><div></div></div><input type="range" min="0" max="3" step="0.01" value="${p?.vol ?? 1}" style="width:90px" data-vol></div>`;
  }).join('') : '<p class="small dim">No phones yet. Scan the QR code on the main screen.</p>';
}
$('#singers').addEventListener('input', (e) => {
  if (!e.target.matches('[data-vol]')) return;
  const p = peers.get(e.target.closest('.singerRow').dataset.id);
  if (p) { p.vol = Number(e.target.value); p.gain.gain.setTargetAtTime(p.vol, ctx.currentTime, 0.03); }
});

// library
const libCache = new Map();
function libActs(t) {
  let ai = '';
  if (t.stems === 'ready') ai = '<span class="badge good" title="AI-separated instrumental ready">AI</span>';
  else if (t.stems === 'running' || t.stems === 'queued') ai = `<span class="badge warn">AI ${t.stems === 'queued' ? 'queued' : t.stemProgress + '%'}</span>`;
  else if (t.stems === 'error') ai = '<button class="sm" data-a="ai" title="Separation failed, retry">AI ⚠</button>';
  else if (info?.demucs) ai = '<button class="sm" data-a="ai" title="Make a high-quality instrumental with Demucs">AI split</button>';
  return `${ai}<button class="sm" data-a="original">Original</button><button class="sm primary" data-a="karaoke">Karaoke</button>`;
}
function renderLibRow(t) {
  const row = $(`#libList .track[data-id="${t.id}"]`);
  if (row) row.querySelector('.acts').innerHTML = libActs(t);
}
let libTimer;
async function searchLibrary() {
  const list = await (await fetch(`/api/library?q=${encodeURIComponent($('#libSearch').value)}`)).json();
  list.forEach((t) => libCache.set(t.id, t));
  $('#libList').innerHTML = list.map((t) => trackHtml(t, libActs(t))).join('');
  $('#libHint').textContent = list.length ? '' : ($('#libSearch').value ? 'No matches.' : 'No songs yet. Click ＋ Add or drop audio files into the music folder.');
}
$('#libSearch').addEventListener('input', () => { clearTimeout(libTimer); libTimer = setTimeout(searchLibrary, 200); });
$('#libList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const t = libCache.get(b.closest('.track').dataset.id);
  if (b.dataset.a === 'ai') {
    const r = await fetch(`/api/separate/${t.id}`, { method: 'POST' });
    if (!r.ok) toast((await r.json()).error || 'Failed'); else onStems(await r.json());
    return;
  }
  addToQueue(t, b.dataset.a, $('#singerPick').value);
});
function addToQueue(t, mode, singer) {
  send({ type: 'queue:add', item: { ...t, mode, singer: singer === 'Anyone' ? '' : singer } });
  toast(`Queued: ${t.title}${mode === 'karaoke' ? ' (karaoke)' : ''}`, 1800);
}
$('#btnUpload').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const fd = new FormData();
  for (const f of e.target.files) fd.append('files', f);
  toast(`Uploading ${e.target.files.length} file(s)…`);
  const r = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
  toast(`Added ${r.added} song(s).`);
  e.target.value = '';
  searchLibrary();
});
$('#btnRescan').addEventListener('click', async () => { await fetch('/api/library/rescan', { method: 'POST' }); searchLibrary(); });

// spotify UI
let spTimer;
$('#spSearch').addEventListener('input', () => {
  clearTimeout(spTimer);
  spTimer = setTimeout(async () => {
    const q = $('#spSearch').value.trim();
    if (!q) return ($('#spList').innerHTML = '');
    const r = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}`);
    const list = await r.json();
    if (!r.ok) return ($('#spStatus').textContent = list.error);
    $('#spList').innerHTML = list.map((t) => trackHtml(t, '<button class="sm" data-a="original">Original</button><button class="sm primary" data-a="karaoke">Karaoke</button>')).join('');
    $('#spList')._data = list;
  }, 300);
});
$('#spList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const t = $('#spList')._data.find((x) => x.id === b.closest('.track').dataset.id);
  addToQueue(t, b.dataset.a, $('#singerPick2').value);
});
$('#spLogin').addEventListener('click', () => { location.href = `http://127.0.0.1:${location.port || 3000}/spotify/login`; });
$('#spSave').addEventListener('click', async () => {
  const r = await fetch('/api/spotify/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: $('#spClientId').value }) });
  const j = await r.json();
  $('#spSetupMsg').textContent = r.ok ? 'Saved. Now open the Spotify tab and log in.' : j.error;
  await loadInfo();
});
$('#spLogout').addEventListener('click', async () => { await fetch('/api/spotify/logout', { method: 'POST' }); spPlayer?.disconnect(); spPlayer = null; await loadInfo(); });

// tabs, transport
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('active', x.id === 'pane-' + name));
  if (name === 'library') searchLibrary();
}
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnSkip').addEventListener('click', skip);
$('#btnRestart').addEventListener('click', () => seekTo(0));
$('#btnStartQueue').addEventListener('click', playNext);
$('#btnLoop').addEventListener('click', toggleLoop);
$('#speed').addEventListener('change', (e) => setSpeed(Number(e.target.value)));
$('#seek').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * duration()); });
const setOffset = (d) => { if (!current) return; current.offset = Math.round((current.offset + d) * 100) / 100; $('#offVal').textContent = current.offset.toFixed(2); renderLyrics(position(), true); };
$('#offMinus').addEventListener('click', () => setOffset(-0.25));
$('#offPlus').addEventListener('click', () => setOffset(0.25));
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.target.matches('input, select, textarea')) { e.preventDefault(); togglePlay(); } });

// ───────────── main loop ─────────────
let lastSync = 0;
// Timing-critical work (loops, lyric feed to phones, guide sync) must keep running even when this
// tab is in the background, where requestAnimationFrame stops. So it lives in tick(), driven by
// rAF when visible and by a timer when hidden.
function tick() {
  if (!ctx || !nodes.musicEl) return;
  const pos = position();
  if (current) renderLyrics(pos);
  if (current?.loop && pos >= current.loop.b && performance.now() - (current.loopJump || 0) > 600) {
    current.loopJump = performance.now(); seekTo(current.loop.a);
  }
  if (performance.now() - lastSync > 500) { lastSync = performance.now(); if (!nodes.musicEl.paused) syncGuide(false); }
}
setInterval(() => document.hidden && tick(), 50);
function frame() {
  requestAnimationFrame(frame);
  if (!ctx) return;
  tick();
  const pos = position(), dur = duration();
  $('#tCur').textContent = fmt(pos); $('#tDur').textContent = fmt(dur);
  $('#seekFill').style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0';
  if (!current) $('#offVal').textContent = '0.00';
  drawPitch();
  for (const row of document.querySelectorAll('.singerRow')) {
    const p = peers.get(row.dataset.id);
    row.querySelector('.vu > div').style.width = `${Math.min(100, (p?.rms || 0) * 400)}%`;
  }
}

async function loadInfo() {
  info = await (await fetch('/api/info')).json();
  $('#qr').src = info.qr || '';
  $('#joinUrl').textContent = info.micUrls[0]?.replace('/mic.html', '') || 'No network found';
  $('#micUrls').innerHTML = info.micUrls.map((u) => `<div><code>${esc(u)}</code></div>`).join('') || '<p>No network interface found. Connect this computer to Wi-Fi.</p>';
  $('#redirUri').textContent = info.spotify.redirectUri;
  $('#spLoggedOut').classList.toggle('hidden', info.spotify.loggedIn);
  $('#spLoggedIn').classList.toggle('hidden', !info.spotify.loggedIn);
  $('#spLogin').disabled = !info.spotify.configured;
  $('#spNotConfigured').classList.toggle('hidden', info.spotify.configured);
  $('#spLogout').classList.toggle('hidden', !info.spotify.loggedIn);
  $('#demucsInfo').innerHTML = info.demucs
    ? '✅ Demucs found. Click <b>AI split</b> on a song in Library for a studio-quality instrumental (takes ~1× song length on CPU, much faster with a GPU).'
    : 'Not installed. Spectral removal works without it. For much better results install Python, then run <code>pip install demucs</code> and restart the server.';
  if (location.hostname !== '127.0.0.1' && info.spotify.configured) {
    $('#hostWarn').textContent = `For Spotify to work, open the host screen at http://127.0.0.1:${location.port === '3443' ? 3000 : location.port || 3000} on the server computer.`;
    $('#hostWarn').classList.remove('hidden');
  }
}

$('#startBtn').addEventListener('click', async () => {
  $('#startBtn').disabled = true;
  try {
    await initAudio();
    await ctx.resume();
    connect();
    $('#overlay').classList.add('hidden');
    if (info.spotify.loggedIn) initSpotify().then(() => spPlayer?.activateElement?.());
    requestAnimationFrame(frame);
  } catch (e) {
    $('#startBtn').disabled = false;
    toast('Audio setup failed: ' + e.message, 8000);
    console.error(e);
  }
});

// handy for debugging from the browser console
window.karaoke = { get ctx() { return ctx; }, nodes, peers, get current() { return current; }, get party() { return party; }, playNext, position, songEnded, practiceLine, toggleLoop };

loadSettings();
await loadInfo();
if (location.hash.startsWith('#spotify-error=')) toast('Spotify login failed: ' + decodeURIComponent(location.hash.slice(15)), 9000);
if (location.hash === '#spotify-setup') showTab('setup');
history.replaceState(null, '', location.pathname);
renderNow(); renderSingers();
