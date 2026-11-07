// Phone page: captures the mic and streams it to the host screen over WebRTC.
import { looksLikeYouTubeLink } from '/youtube.js';
import { startEngine, mountTuner, onRef, initPractice, onReport, reportCard, renderProgress, progress } from '/practice.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 3000) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

let ws = null, myId = null, stream = null, track = null, pc = null, hostOnline = false, party = { queue: [], now: null };
let wakeLock = null, src = 'library';
const opts = { noiseSuppression: false, echoCancellation: false, autoGainControl: false };

$('#name').value = localStorage.getItem('karaoke-name') || '';
for (const [id, k] of [['optNoise', 'noiseSuppression'], ['optEcho', 'echoCancellation'], ['optAgc', 'autoGainControl']]) {
  $('#' + id).addEventListener('change', async (e) => { opts[k] = e.target.checked; await reacquire(); });
}

const constraints = () => ({ audio: { ...opts, channelCount: 1, sampleRate: 48000 } });

$('#joinBtn').addEventListener('click', async () => {
  const name = $('#name').value.trim() || 'Singer';
  localStorage.setItem('karaoke-name', name);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('#joinErr').textContent = 'This page must be opened over https:// for the mic to work. Use the address shown on the host screen.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints());
  } catch (e) {
    $('#joinErr').textContent = `Couldn't open the microphone (${e.name}). Allow mic access for this site in your browser settings and try again.`;
    return;
  }
  track = stream.getAudioTracks()[0];
  startMeter();
  startEngine(stream).catch((e) => console.warn('pitch engine', e));
  mountTuner($('#tuner'));
  initPractice({ setRoomMute, sendProfile: (range) => send({ type: 'profile', range }) });
  keepAwake();
  $('#join').classList.add('hidden');
  $('#main').classList.remove('hidden');
  connect(name);
  search();
});

async function reacquire() {
  if (!track) return;
  try {
    await track.applyConstraints({ ...opts });
  } catch {
    const s = await navigator.mediaDevices.getUserMedia(constraints());
    const t = s.getAudioTracks()[0];
    t.enabled = track.enabled;
    await pc?.getSenders()[0]?.replaceTrack(t);
    track.stop(); track = t; stream = s; startMeter(); startEngine(s);
  }
}

// level meter
let meterCtx, analyser;
function startMeter() {
  meterCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  meterCtx.resume();
  const s = meterCtx.createMediaStreamSource(stream);
  analyser = meterCtx.createAnalyser(); analyser.fftSize = 512;
  s.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const loop = () => {
    analyser.getFloatTimeDomainData(buf);
    let e = 0; for (const v of buf) e += v * v;
    const lvl = track?.enabled ? Math.min(1, Math.sqrt(e / buf.length) * 6) : 0;
    $('#micBtn').style.setProperty('--lvl', lvl.toFixed(3));
    requestAnimationFrame(loop);
  };
  loop();
}
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && stream) keepAwake(); });

$('#micBtn').addEventListener('click', () => {
  if (!track) return;
  track.enabled = !track.enabled;
  $('#micBtn').classList.toggle('muted', !track.enabled);
  $('#micBtn').textContent = track.enabled ? '🎤' : '🔇';
  setStatus();
});
let volTimer;
$('#vol').addEventListener('input', (e) => {
  $('#volOut').textContent = Math.round(e.target.value * 100) + '%';
  clearTimeout(volTimer);
  volTimer = setTimeout(() => send({ type: 'control', action: 'micvol', value: Number(e.target.value) }), 60);
});
document.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => send({ type: 'control', action: b.dataset.c })));

// ───────────── signalling & WebRTC ─────────────
function connect(name) {
  ws = new WebSocket(`wss://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'mic', name }));
    if (progress.range) ws.send(JSON.stringify({ type: 'profile', range: progress.range }));
  };
  ws.onclose = () => { hostOnline = false; setStatus('Reconnecting…'); setTimeout(() => connect(name), 1500); };
  ws.onmessage = async ({ data }) => {
    const m = JSON.parse(data);
    if (m.type === 'welcome') myId = m.id;
    else if (m.type === 'host-ready') { hostOnline = true; startCall(); }
    else if (m.type === 'host-gone') { hostOnline = false; pc?.close(); pc = null; setStatus(); }
    else if (m.type === 'signal') onSignal(m.data);
    else if (m.type === 'state') { party = m.state; hostOnline = m.state.hostOnline; renderState(); setStatus(); }
    else if (m.type === 'lyric') renderLyric(m);
    else if (m.type === 'ref') onRef(m);
    else if (m.type === 'report') showReport(m.report);
    else if (m.type === 'library-changed' && src === 'library') search();
  };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function tuneOpus(sdp) {
  // ask for high-bitrate, no-DTX Opus: much better for singing than the speech defaults
  const pts = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000/gi)].map((m) => m[1]);
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (all, pt, params) => {
    if (!pts.includes(pt)) return all;
    const keep = params.split(';').filter((x) => x && !/^(maxaveragebitrate|usedtx|useinbandfec|maxplaybackrate|cbr)=/.test(x.trim()));
    return `a=fmtp:${pt} ${[...keep, 'maxaveragebitrate=128000', 'usedtx=0', 'useinbandfec=1', 'maxplaybackrate=48000'].join(';')}`;
  });
}

async function startCall() {
  if (!track) return;
  pc?.close();
  const conn = new RTCPeerConnection({ iceServers: [] });
  pc = conn;
  const sender = conn.addTrack(track, stream);
  if (roomMuted) sender.replaceTrack(null).catch(() => {});
  try {
    const p = sender.getParameters();
    p.encodings = p.encodings?.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 128000;
    p.encodings[0].priority = 'high';
    p.encodings[0].networkPriority = 'high';
    await sender.setParameters(p);
  } catch {}
  conn.onicecandidate = (e) => e.candidate && send({ type: 'signal', to: 'host', data: { candidate: e.candidate } });
  conn.onconnectionstatechange = () => {
    setStatus();
    if (conn.connectionState === 'failed' && pc === conn) setTimeout(() => pc === conn && hostOnline && startCall(), 2000);
  };
  await conn.setLocalDescription(await conn.createOffer());
  send({ type: 'signal', to: 'host', data: { sdp: conn.localDescription } });
  setStatus('Connecting to the host screen…');
}
async function onSignal(data) {
  if (!pc) return;
  if (data.sdp?.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(data.sdp.sdp) });
  else if (data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
}
function setStatus(text) {
  const el = $('#status');
  if (text) { el.textContent = text; return; }
  if (roomMuted) { el.textContent = 'Muted to the room while you practise'; return; }
  if (!hostOnline) el.textContent = 'Waiting for the host screen to start…';
  else if (pc?.connectionState === 'connected') el.innerHTML = track?.enabled ? '<span style="color:var(--good)">● Live</span>. Tap the mic to mute.' : 'Muted. Tap to unmute.';
  else if (pc?.connectionState === 'failed') el.textContent = 'Connection failed. Retrying… (is the phone on the same Wi-Fi?)';
  else el.textContent = 'Connecting to the host screen…';
}

// mute to the room (e.g. during practice drills) without stopping the local mic
let roomMuted = false;
function setRoomMute(on) {
  roomMuted = on;
  const sender = pc?.getSenders()[0];
  sender?.replaceTrack(on ? null : track).catch(() => {});
  setStatus(on ? 'Muted to the room while you practise' : undefined);
}
function showReport(r) {
  onReport(r);
  $('#lastReport').innerHTML = reportCard(r, { live: true }).replace('<div class="card report">', '<div class="card report"><button class="sm ghost" data-dismiss style="float:right">✕</button>');
  toast('Your singing report is ready');
}
$('#lastReport').addEventListener('click', (e) => {
  if (e.target.matches('[data-dismiss]')) $('#lastReport').innerHTML = '';
  const b = e.target.closest('[data-practice]');
  if (b) { send({ type: 'control', action: 'practice', value: Number(b.dataset.practice) }); toast('Looping that line on the big screen'); }
});
$('#phoneSpeed').addEventListener('change', (e) => send({ type: 'control', action: 'speed', value: Number(e.target.value) }));
document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#viewSeg button').forEach((x) => x.classList.toggle('active', x === b));
  for (const v of ['sing', 'practice', 'progress']) $('#view-' + v).classList.toggle('hidden', v !== b.dataset.view);
  if (b.dataset.view === 'progress') renderProgress();
}));

// ───────────── UI ─────────────
function renderLyric(m) {
  $('#lyr').innerHTML = `<div class="ln cur">${esc(m.cur) || '&nbsp;'}</div><div class="ln next">${esc(m.next) || '&nbsp;'}</div>`;
}
function renderState() {
  const n = party.now;
  $('#npTitle').textContent = n ? n.title : 'Nothing playing';
  $('#npSub').textContent = n ? `${n.artist} · 🎤 ${n.singer || 'Anyone'}` : (party.queue.length ? `${party.queue.length} song(s) queued` : 'Add a song below');
  $('#npArt').src = n?.art || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  if (!n) $('#lyr').innerHTML = '';
  const me = $('#name').value.trim() || 'Singer';
  $('#queue').innerHTML = party.queue.length ? party.queue.map((q, i) => `
    <div class="track" data-qid="${q.qid}">${q.art ? `<img src="${esc(q.art)}" loading="lazy">` : '<div class="noart"></div>'}
      <div class="meta"><div class="t ellipsis">${i + 1}. ${esc(q.title)}</div><div class="a ellipsis">${esc(q.artist)} · 🎤 ${esc(q.singer || 'Anyone')}${q.mode === 'karaoke' ? ' · karaoke' : ''}</div></div>
      ${q.addedBy === myId || q.singer === me ? '<div class="acts"><button class="sm" data-del>✕</button></div>' : ''}</div>`).join('')
    : '<p class="small dim">Nothing queued yet.</p>';
}
$('#queue').addEventListener('click', (e) => {
  if (e.target.matches('[data-del]')) send({ type: 'queue:remove', qid: e.target.closest('.track').dataset.qid });
});

document.querySelectorAll('#srcSeg button').forEach((b) => b.addEventListener('click', () => {
  src = b.dataset.src;
  document.querySelectorAll('#srcSeg button').forEach((x) => x.classList.toggle('active', x === b));
  $('#qGo').classList.toggle('hidden', src !== 'youtube');
  $('#ytOpts').classList.toggle('hidden', src !== 'youtube');
  $('#q').placeholder = src === 'youtube' ? 'Search YouTube or paste a link…' : 'Search for a song…';
  search();
}));
let results = [], qTimer;
// YouTube searches use a small daily allowance, so they only run on Enter (or when a link is pasted)
$('#q').addEventListener('input', () => {
  clearTimeout(qTimer);
  if (src === 'youtube' && !looksLikeYouTubeLink($('#q').value)) return;
  qTimer = setTimeout(search, 300);
});
$('#qForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(qTimer); search(true); });
async function search(explicit = false) {
  const q = $('#q').value.trim();
  $('#searchMsg').textContent = '';
  if (src === 'spotify' && !q) { $('#results').innerHTML = ''; $('#searchMsg').textContent = 'Type to search Spotify.'; return; }
  if (src === 'youtube' && (!q || (!explicit && !looksLikeYouTubeLink(q)))) {
    results = []; $('#results').innerHTML = '';
    $('#searchMsg').textContent = 'Type a song and press Search, or paste a YouTube link.';
    return;
  }
  const url = src === 'library' ? `/api/library?q=${encodeURIComponent(q)}`
    : src === 'spotify' ? `/api/spotify/search?q=${encodeURIComponent(q)}`
    : `/api/youtube/search?${new URLSearchParams({ q, karaoke: $('#ytKaraoke').checked ? '1' : '0' })}`;
  if (src === 'youtube') $('#searchMsg').textContent = 'Searching…';
  const r = await fetch(url);
  const j = await r.json();
  $('#searchMsg').textContent = '';
  if (!r.ok) { results = []; $('#results').innerHTML = ''; $('#searchMsg').textContent = r.status === 401 ? 'The host hasn\'t logged in to Spotify yet.' : j.error; return; }
  results = (src === 'youtube' ? j.results : j).slice(0, 40);
  if (!results.length) $('#searchMsg').textContent = q ? 'No matches.' : 'The host has no local songs yet.';
  $('#results').innerHTML = results.map((t, i) => `
    <div class="track" data-i="${i}">${t.art ? `<img src="${esc(t.art)}" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="noart"></div>'}
      <div class="meta"><div class="t ellipsis">${esc(t.title)}</div><div class="a ellipsis">${esc(t.artist)}${t.source === 'youtube' && t.karaoke ? ' · <span style="color:var(--accent)">karaoke</span>' : ''}</div></div>
      <div class="acts">${t.source === 'youtube' ? '<button class="sm primary" data-mode="original">Add</button>'
        : '<button class="sm" data-mode="original">Original</button><button class="sm primary" data-mode="karaoke">Karaoke</button>'}</div></div>`).join('');
}
$('#results').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]'); if (!b) return;
  const t = results[Number(b.closest('.track').dataset.i)];
  send({ type: 'queue:add', item: { ...t, mode: b.dataset.mode, singer: $('#name').value.trim() || 'Singer' } });
  toast(`Added “${t.title}” to the queue`);
});
