// Living-room karaoke server
//  - http://127.0.0.1:3000   -> host screen (laptop/TV). Loopback http so Spotify login works.
//  - https://<lan-ip>:3443   -> phones (HTTPS is required for the browser to allow the mic)
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import multer from 'multer';
import { parseFile } from 'music-metadata';
import QRCode from 'qrcode';
import { parseYouTubeId, looksLikeYouTubeLink, mapVideo, decodeEntities, isKaraokeTitle, pacificDay } from './public/youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '.data'));
const STEMS_DIR = path.join(DATA_DIR, 'stems');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac', '.webm']);
const SPOTIFY_REDIRECT = `http://127.0.0.1:${HTTP_PORT}/spotify/callback`;
const SPOTIFY_SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';

for (const d of [MUSIC_DIR, DATA_DIR, STEMS_DIR, CERT_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- config ----------
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
if (process.env.SPOTIFY_CLIENT_ID) config.spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
if (process.env.YOUTUBE_API_KEY) config.youtubeApiKey = process.env.YOUTUBE_API_KEY;
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
// measured vocal range of each song's lead vocal (filled in by the host after it plays an AI-split song)
const RANGES_FILE = path.join(DATA_DIR, 'vocal-ranges.json');
let vocalRanges = {};
try { vocalRanges = JSON.parse(fs.readFileSync(RANGES_FILE, 'utf8')); } catch {}

// ---------- network ----------
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
const isLoopback = (req) => {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

async function getCert() {
  const ips = lanIPs();
  const metaFile = path.join(CERT_DIR, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (JSON.stringify(meta.ips) === JSON.stringify(ips) && new Date(meta.expires) > new Date()) {
      return { key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')), cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')) };
    }
  } catch {}
  const notAfter = new Date(Date.now() + 825 * 864e5);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'karaoke.local' }], {
    keySize: 2048,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' },
        ...ips.map((ip) => ({ type: 7, ip })),
      ] },
    ],
  });
  fs.writeFileSync(path.join(CERT_DIR, 'key.pem'), pems.private);
  fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ ips, expires: notAfter }));
  return { key: pems.private, cert: pems.cert };
}

// ---------- local library ----------
const library = new Map(); // id -> track
const idFor = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);

async function walk(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function findStems(id) {
  const dir = path.join(STEMS_DIR, id);
  const res = {};
  const look = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) look(p);
      else if (/^no_vocals\./.test(e.name)) res.instrumental = p;
      else if (/^vocals\./.test(e.name)) res.vocals = p;
    }
  };
  look(dir);
  return res.instrumental ? res : null;
}

async function scanLibrary() {
  const files = await walk(MUSIC_DIR);
  const seen = new Set();
  for (const file of files) {
    const rel = path.relative(MUSIC_DIR, file);
    const id = idFor(rel);
    seen.add(id);
    const stat = await fsp.stat(file);
    const prev = library.get(id);
    if (prev && prev.mtime === stat.mtimeMs) { prev.stems = findStems(id); continue; }
    let meta = {};
    try { meta = await parseFile(file, { skipCovers: true, duration: true }); } catch {}
    const base = path.basename(file, path.extname(file));
    // "Artist - Title" filename fallback
    const [fa, ft] = base.includes(' - ') ? base.split(/ - (.+)/) : [null, base];
    library.set(id, {
      id, file, rel, mtime: stat.mtimeMs,
      title: meta.common?.title || ft || base,
      artist: meta.common?.artist || fa || '',
      album: meta.common?.album || '',
      duration: Math.round((meta.format?.duration || 0) * 1000),
      stems: findStems(id),
    });
  }
  for (const id of library.keys()) if (!seen.has(id)) library.delete(id);
  return library.size;
}

const publicTrack = (t) => ({
  source: 'local', id: t.id, title: t.title, artist: t.artist, album: t.album,
  duration: t.duration, art: `/api/art/${t.id}`,
  stems: t.stems ? 'ready' : (jobs.get(t.id)?.status || 'none'),
  stemProgress: jobs.get(t.id)?.progress || 0,
  vocalRange: vocalRanges[t.id] || null,
});

// ---------- Demucs vocal separation ----------
const jobs = new Map(); // id -> {status, progress, error}
let demucsCmd = null;
function tryCmd(cmd, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      const t = setTimeout(() => { p.kill(); resolve(false); }, 20000);
      p.on('error', () => { clearTimeout(t); resolve(false); });
      p.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
    } catch { resolve(false); }
  });
}
async function detectDemucs() {
  const candidates = process.env.DEMUCS_CMD
    ? [process.env.DEMUCS_CMD.split(' ')]
    : [['demucs'], ['python3', '-m', 'demucs'], ['python', '-m', 'demucs'], ['py', '-m', 'demucs']];
  for (const c of candidates) {
    if (await tryCmd(c[0], [...c.slice(1), '--help'])) { demucsCmd = c; return; }
  }
}

const separateQueue = [];
let separating = false;
function enqueueSeparation(id) {
  const t = library.get(id);
  if (!t || t.stems || jobs.get(id)?.status === 'queued' || jobs.get(id)?.status === 'running') return;
  jobs.set(id, { status: 'queued', progress: 0 });
  separateQueue.push(id);
  broadcast({ type: 'stems', track: publicTrack(t) });
  runNextSeparation();
}
function runNextSeparation() {
  if (separating || !separateQueue.length) return;
  const id = separateQueue.shift();
  const t = library.get(id);
  if (!t) return runNextSeparation();
  separating = true;
  const job = { status: 'running', progress: 0 };
  jobs.set(id, job);
  broadcast({ type: 'stems', track: publicTrack(t) });
  const out = path.join(STEMS_DIR, id);
  const args = [...demucsCmd.slice(1), '--two-stems=vocals', '--mp3', '--mp3-bitrate', '256',
    '-o', out, '--filename', '{stem}.{ext}', t.file];
  const p = spawn(demucsCmd[0], args);
  let lastSent = 0, errTail = '';
  const onData = (buf) => {
    const s = buf.toString();
    errTail = (errTail + s).slice(-2000);
    const m = [...s.matchAll(/(\d{1,3})%\|/g)].pop();
    if (m) {
      job.progress = Number(m[1]);
      if (Date.now() - lastSent > 1000) { lastSent = Date.now(); broadcast({ type: 'stems', track: publicTrack(t) }); }
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  const done = (code) => {
    separating = false;
    t.stems = findStems(id);
    if (t.stems) jobs.delete(id);
    else jobs.set(id, { status: 'error', progress: 0, error: errTail.split('\n').filter(Boolean).slice(-3).join(' ') || `exit ${code}` });
    broadcast({ type: 'stems', track: publicTrack(t) });
    runNextSeparation();
  };
  p.on('error', (e) => { errTail = e.message; done(-1); });
  p.on('exit', done);
}

// ---------- lyrics (LRCLIB, free & keyless) ----------
const lyricsCache = new Map();
function parseLRC(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) lines.push([Number(m[1]) * 60 + Number(m[2]), text]);
  }
  return lines.sort((a, b) => a[0] - b[0]);
}
async function lrclib(pathAndQuery) {
  const r = await fetch(`${process.env.LRCLIB_BASE || 'https://lrclib.net'}${pathAndQuery}`, { headers: { 'User-Agent': 'LivingRoomKaraoke/1.0' } });
  if (!r.ok) return null;
  return r.json();
}
async function getLyrics({ artist = '', title = '', album = '', duration = 0 }) {
  const key = `${artist}|${title}`.toLowerCase();
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  const cleanTitle = title.replace(/\s*[\(\[][^\)\]]*(remaster|version|live|edit|mono|stereo|feat)[^\)\]]*[\)\]]/gi, '').replace(/\s+-\s+.*remaster.*$/i, '').trim();
  let hit = null;
  try {
    const q = new URLSearchParams({ artist_name: artist, track_name: cleanTitle });
    if (album) q.set('album_name', album);
    if (duration) q.set('duration', String(Math.round(duration / 1000)));
    hit = await lrclib(`/api/get?${q}`);
    if (!hit?.syncedLyrics) {
      const list = await lrclib(`/api/search?${new URLSearchParams({ track_name: cleanTitle, artist_name: artist })}`)
        || [];
      const withSync = list.filter((x) => x.syncedLyrics);
      const dur = duration / 1000;
      withSync.sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur));
      hit = withSync[0] || hit || list[0] || null;
    }
  } catch (e) { console.warn('lyrics lookup failed:', e.message); }
  const res = {
    synced: hit?.syncedLyrics ? parseLRC(hit.syncedLyrics) : null,
    plain: hit?.plainLyrics || null,
    instrumental: !!hit?.instrumental,
  };
  if (hit) lyricsCache.set(key, res);
  return res;
}

// ---------- Spotify (Authorization Code + PKCE; no client secret needed) ----------
const pkce = new Map(); // state -> verifier
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let spotifyAccess = null; // {token, expires}

async function spotifyTokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.spotifyClientId, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
  spotifyAccess = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  if (j.refresh_token) { config.spotifyRefresh = j.refresh_token; saveConfig(); }
  return spotifyAccess.token;
}
async function spotifyToken() {
  if (spotifyAccess && spotifyAccess.expires > Date.now()) return spotifyAccess.token;
  if (!config.spotifyRefresh || !config.spotifyClientId) return null;
  try { return await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: config.spotifyRefresh }); }
  catch (e) { console.warn('Spotify refresh failed:', e.message); delete config.spotifyRefresh; saveConfig(); return null; }
}
async function spotifyGet(url) {
  const tok = await spotifyToken();
  if (!tok) { const e = new Error('Not logged in to Spotify'); e.status = 401; throw e; }
  const r = await fetch(`https://api.spotify.com/v1${url}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) { const e = new Error(`Spotify ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
  return r.json();
}
const mapSpotifyTrack = (t) => ({
  source: 'spotify', id: t.uri, spotifyId: t.id, title: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', '),
  album: t.album?.name || '', duration: t.duration_ms,
  art: t.album?.images?.at(-2)?.url || t.album?.images?.[0]?.url || '',
});
async function spotifySearch(q) {
  const j = await spotifyGet(`/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`);
  return (j.tracks?.items || []).filter(Boolean).map(mapSpotifyTrack);
}
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
async function findKaraokeVersions({ title, artist, duration, id }) {
  const t = norm(title);
  const mainArtist = norm((artist || '').split(',')[0]);
  const queries = [`${t} karaoke`, `${t} ${mainArtist} karaoke`, `${t} instrumental`, `${t} ${mainArtist} instrumental`];
  const seen = new Map();
  for (const q of queries) {
    try { for (const r of await spotifySearch(q)) if (!seen.has(r.id)) seen.set(r.id, r); } catch (e) { if (e.status === 401) throw e; }
  }
  const scored = [];
  for (const r of seen.values()) {
    if (r.id === id) continue;
    const name = r.title.toLowerCase(), all = `${name} ${r.album} ${r.artist}`.toLowerCase();
    if (!norm(r.title).includes(t) && !t.includes(norm(r.title))) continue;
    let s = 0;
    if (/karaoke/.test(all)) s += 4;
    if (/instrumental/.test(all)) s += 3;
    if (!/karaoke|instrumental/.test(all)) continue; // probably just the original or a cover
    if (/originally performed|in the style of|made famous/.test(all) || all.includes(mainArtist)) s += 2;
    if (/backing vocal|with vocal|guide vocal|demo/.test(all)) s -= 2;
    if (/acapella|a cappella/.test(all)) s -= 10;
    const dd = Math.abs((r.duration || 0) - (duration || 0)) / 1000;
    if (duration) s += dd < 8 ? 3 : dd < 20 ? 1.5 : dd < 45 ? 0 : -2;
    scored.push({ ...r, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 8);
}

// ---------- YouTube (Data API v3 for search, oEmbed for pasted links) ----------
const YT_BASE = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const YT_OEMBED = process.env.YOUTUBE_OEMBED_URL || 'https://www.youtube.com/oembed';
const YT_DAILY_SEARCHES = 100; // default search.list allowance per Google Cloud project
const YT_CACHE_FILE = path.join(DATA_DIR, 'youtube-cache.json');
const YT_CACHE_TTL = 24 * 3600e3;
let ytCache = {};
try { ytCache = JSON.parse(fs.readFileSync(YT_CACHE_FILE, 'utf8')); } catch {}
const ytSearchesToday = () => (config.ytQuota?.day === pacificDay() ? config.ytQuota.searches : 0);
function saveYtCache() {
  const entries = Object.entries(ytCache).filter(([, v]) => Date.now() - v.at < YT_CACHE_TTL).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
  ytCache = Object.fromEntries(entries);
  fs.writeFile(YT_CACHE_FILE, JSON.stringify(ytCache), () => {});
}
async function ytApi(endpoint, params) {
  const r = await fetch(`${YT_BASE}/${endpoint}?${new URLSearchParams({ ...params, key: config.youtubeApiKey })}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j.error?.errors?.[0]?.reason || '';
    const e = new Error(/quota/i.test(reason) ? 'Daily YouTube search limit reached (it resets at midnight Pacific). You can still paste YouTube links.'
      : /keyInvalid|badRequest/i.test(reason) || r.status === 400 ? 'YouTube rejected the API key. Check it in Setup.'
      : `YouTube error ${r.status}: ${j.error?.message || reason}`);
    e.status = r.status === 403 && /quota/i.test(reason) ? 429 : r.status;
    throw e;
  }
  return j;
}
async function ytVideos(ids) {
  if (!ids.length) return [];
  const j = await ytApi('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: '50' });
  const byId = new Map((j.items || []).map((v) => [v.id, v]));
  return ids.map((id) => byId.get(id)).filter((v) => v && v.status?.embeddable !== false).map(mapVideo);
}
async function ytSearch(q, karaoke) {
  const query = karaoke && !/karaoke|instrumental/i.test(q) ? `${q} karaoke` : q;
  const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = ytCache[key];
  if (hit && Date.now() - hit.at < YT_CACHE_TTL) return { results: hit.results, cached: true };
  if (!config.youtubeApiKey) { const e = new Error('YouTube search needs an API key (host: Setup tab). You can still paste a YouTube link.'); e.status = 400; e.needsKey = true; throw e; }
  const j = await ytApi('search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '15', q: query });
  config.ytQuota = { day: pacificDay(), searches: ytSearchesToday() + 1 };
  saveConfig();
  const ids = (j.items || []).map((x) => x.id?.videoId).filter(Boolean);
  const results = await ytVideos(ids);
  ytCache[key] = { at: Date.now(), results };
  saveYtCache();
  return { results, cached: false };
}
async function ytResolve(input) {
  const id = parseYouTubeId(input);
  if (!id) { const e = new Error("That doesn't look like a YouTube link."); e.status = 400; throw e; }
  if (config.youtubeApiKey) {
    const [v] = await ytVideos([id]);
    if (!v) { const e = new Error("That video can't be played here (private, removed, or the owner blocks embedding)."); e.status = 404; throw e; }
    return v;
  }
  const r = await fetch(`${YT_OEMBED}?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' })}`);
  if (!r.ok) { const e = new Error("That video can't be played here (private, removed, or the owner blocks embedding)."); e.status = 404; throw e; }
  const j = await r.json();
  const title = decodeEntities(j.title || id);
  return { source: 'youtube', id, title, artist: decodeEntities(j.author_name || ''), album: '', duration: 0,
    art: j.thumbnail_url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, karaoke: isKaraokeTitle(title) };
}

// ---------- shared party state ----------
const state = { queue: [], now: null, lyric: null, singers: [] };
const clients = new Map(); // id -> {ws, role, name}
let hostId = null;
function broadcast(msg, filter = () => true) {
  const s = JSON.stringify(msg);
  for (const c of clients.values()) if (filter(c) && c.ws.readyState === 1) c.ws.send(s);
}
const publicState = () => ({
  queue: state.queue, now: state.now, hostOnline: !!hostId,
  singers: [...clients.entries()].filter(([, c]) => c.role === 'mic').map(([id, c]) => ({ id, name: c.name, range: c.range || null })),
});
const sendState = () => broadcast({ type: 'state', state: publicState() });

function handleWs(ws, req) {
  const id = crypto.randomUUID().slice(0, 8);
  const client = { ws, role: 'guest', name: 'Guest', local: isLoopback(req) };
  clients.set(id, client);
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  send({ type: 'welcome', id });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'hello':
        client.role = m.role === 'host' ? 'host' : 'mic';
        client.name = String(m.name || 'Singer').slice(0, 30);
        if (client.role === 'host') {
          if (hostId && clients.get(hostId)) clients.get(hostId).ws.close(4000, 'Another host screen took over');
          hostId = id;
          broadcast({ type: 'host-ready', hostId: id }, (c) => c.role === 'mic');
        } else if (hostId) send({ type: 'host-ready', hostId });
        sendState();
        if (state.lyric) send({ type: 'lyric', ...state.lyric });
        break;
      case 'signal': { // WebRTC relay
        const target = m.to === 'host' ? clients.get(hostId) : clients.get(m.to);
        if (target) target.ws.send(JSON.stringify({ type: 'signal', from: id, name: client.name, data: m.data }));
        break;
      }
      case 'queue:add': {
        const it = m.item || {};
        if (!it.source || !it.id) return;
        state.queue.push({
          qid: crypto.randomUUID().slice(0, 8), source: it.source, id: it.id, title: String(it.title || ''),
          artist: String(it.artist || ''), album: String(it.album || ''), duration: Number(it.duration) || 0,
          art: String(it.art || ''), mode: it.mode === 'karaoke' ? 'karaoke' : 'original',
          singer: String(typeof it.singer === 'string' ? it.singer : client.name).slice(0, 30), addedBy: id,
        });
        sendState();
        break;
      }
      case 'queue:remove':
        state.queue = state.queue.filter((q) => q.qid !== m.qid); sendState(); break;
      case 'queue:move': {
        const i = state.queue.findIndex((q) => q.qid === m.qid);
        const j = i + (m.dir < 0 ? -1 : 1);
        if (i >= 0 && j >= 0 && j < state.queue.length) [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
        sendState();
        break;
      }
      case 'queue:mode': {
        const q = state.queue.find((x) => x.qid === m.qid);
        if (q) q.mode = m.mode === 'karaoke' ? 'karaoke' : 'original';
        sendState();
        break;
      }
      case 'now': // host only
        if (id !== hostId) return;
        state.now = m.now || null;
        if (m.shift) state.queue = state.queue.filter((q) => q.qid !== m.shift);
        if (!state.now) state.lyric = null;
        sendState();
        break;
      case 'lyric':
        if (id !== hostId) return;
        state.lyric = { cur: m.cur || '', next: m.next || '', next2: m.next2 || '' };
        broadcast({ type: 'lyric', ...state.lyric }, (c) => c.role === 'mic');
        break;
      case 'profile': { // phone -> server: singer's measured comfortable range
        const r = m.range;
        client.range = r && Number.isFinite(r.low) && Number.isFinite(r.high) && r.high > r.low ? { low: +r.low, high: +r.high } : null;
        sendState();
        break;
      }
      case 'relay': { // host -> one phone (reports etc.)
        if (id !== hostId) return;
        const target = clients.get(m.to);
        if (target && target.ws.readyState === 1) target.ws.send(JSON.stringify(m.msg));
        break;
      }
      case 'ref': // host -> all phones: reference pitch for the tuner (~20/s)
        if (id !== hostId) return;
        broadcast({ type: 'ref', midi: m.midi ?? null, note: m.note ?? null }, (c) => c.role === 'mic');
        break;
      case 'control': // phone -> host transport / own mic volume
        if (hostId && clients.get(hostId)) clients.get(hostId).ws.send(JSON.stringify({ type: 'control', from: id, action: m.action, value: m.value }));
        break;
    }
  });
  ws.on('close', () => {
    clients.delete(id);
    if (id === hostId) { hostId = null; broadcast({ type: 'host-gone' }); }
    else if (hostId && clients.get(hostId)) clients.get(hostId).ws.send(JSON.stringify({ type: 'peer-gone', id }));
    sendState();
  });
}

// ---------- HTTP app ----------
const app = express();
app.use(express.json());
const hostOnly = (req, res, next) => (isLoopback(req) ? next() : res.status(403).json({ error: 'Only available on the host computer' }));

app.get('/', (req, res) => res.redirect(isLoopback(req) && !req.secure ? '/host.html' : '/mic.html'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', async (req, res) => {
  const ips = lanIPs();
  const urls = ips.map((ip) => `https://${ip}:${HTTPS_PORT}/mic.html`);
  res.json({
    micUrls: urls,
    qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 360 }) : null,
    demucs: !!demucsCmd,
    spotify: { configured: !!config.spotifyClientId, loggedIn: !!config.spotifyRefresh, redirectUri: SPOTIFY_REDIRECT },
    youtube: { configured: !!config.youtubeApiKey, searchesToday: ytSearchesToday(), dailyLimit: YT_DAILY_SEARCHES },
    isHostOrigin: isLoopback(req),
  });
});

// library
app.get('/api/library', (req, res) => {
  const q = norm(String(req.query.q || ''));
  let list = [...library.values()];
  if (q) list = list.filter((t) => norm(`${t.title} ${t.artist} ${t.album}`).includes(q) || norm(t.rel).includes(q));
  list.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title));
  res.json(list.slice(0, 300).map(publicTrack));
});
app.get('/api/track/:id', (req, res) => { const t = library.get(req.params.id); t ? res.json(publicTrack(t)) : res.sendStatus(404); });
app.post('/api/vocal-range/:id', hostOnly, (req, res) => {
  const { low, high } = req.body || {};
  if (!library.has(req.params.id) || !Number.isFinite(low) || !Number.isFinite(high)) return res.sendStatus(400);
  vocalRanges[req.params.id] = { low: Math.round(low * 10) / 10, high: Math.round(high * 10) / 10 };
  fs.writeFileSync(RANGES_FILE, JSON.stringify(vocalRanges));
  res.json(vocalRanges[req.params.id]);
});
app.post('/api/library/rescan', async (req, res) => res.json({ count: await scanLibrary() }));
const upload = multer({
  storage: multer.diskStorage({
    destination: MUSIC_DIR,
    filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')),
  }),
  fileFilter: (req, file, cb) => cb(null, AUDIO_EXT.has(path.extname(file.originalname).toLowerCase())),
  limits: { fileSize: 300 * 1024 * 1024 },
});
app.post('/api/upload', upload.array('files', 50), async (req, res) => {
  await scanLibrary();
  broadcast({ type: 'library-changed' });
  res.json({ added: (req.files || []).length });
});
const sendTrackFile = (pick) => (req, res) => {
  const t = library.get(req.params.id);
  const f = t && pick(t);
  if (!f) return res.sendStatus(404);
  res.sendFile(f, { dotfiles: 'allow' });
};
app.get('/media/:id/original', sendTrackFile((t) => t.file));
app.get('/media/:id/instrumental', sendTrackFile((t) => t.stems?.instrumental));
app.get('/media/:id/vocals', sendTrackFile((t) => t.stems?.vocals));
const artCache = new Map();
const PLACEHOLDER_ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#262638"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#8d8ba6">♪</text></svg>';
app.get('/api/art/:id', async (req, res) => {
  const t = library.get(req.params.id);
  if (!t) return res.set('Cache-Control', 'max-age=3600').type('svg').send(PLACEHOLDER_ART);
  if (!artCache.has(t.id)) {
    try { const m = await parseFile(t.file); const pic = m.common.picture?.[0]; artCache.set(t.id, pic ? { type: pic.format, data: Buffer.from(pic.data) } : null); }
    catch { artCache.set(t.id, null); }
  }
  const a = artCache.get(t.id);
  if (!a) return res.set('Cache-Control', 'max-age=3600').type('svg').send(PLACEHOLDER_ART);
  res.set('Cache-Control', 'max-age=86400').type(a.type).send(a.data);
});
app.post('/api/separate/:id', (req, res) => {
  if (!demucsCmd) return res.status(400).json({ error: 'Demucs is not installed. Run: pip install demucs' });
  if (!library.has(req.params.id)) return res.sendStatus(404);
  enqueueSeparation(req.params.id);
  res.json(publicTrack(library.get(req.params.id)));
});

// lyrics
app.get('/api/lyrics', async (req, res) => res.json(await getLyrics(req.query)));

// spotify
app.post('/api/spotify/config', hostOnly, (req, res) => {
  const cid = String(req.body.clientId || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(cid)) return res.status(400).json({ error: 'That does not look like a Spotify Client ID (32 hex characters).' });
  if (cid !== config.spotifyClientId) delete config.spotifyRefresh;
  config.spotifyClientId = cid; spotifyAccess = null; saveConfig();
  res.json({ ok: true });
});
app.get('/spotify/login', hostOnly, (req, res) => {
  if (!config.spotifyClientId) return res.redirect('/host.html#spotify-setup');
  if (req.headers.host !== `127.0.0.1:${HTTP_PORT}`) return res.redirect(`http://127.0.0.1:${HTTP_PORT}/spotify/login`);
  const verifier = b64url(crypto.randomBytes(48));
  const st = b64url(crypto.randomBytes(12));
  pkce.set(st, verifier);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  res.redirect(`https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: config.spotifyClientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SPOTIFY_SCOPES, state: st,
  })}`);
});
app.get('/spotify/callback', hostOnly, async (req, res) => {
  const verifier = pkce.get(req.query.state);
  pkce.delete(req.query.state);
  if (req.query.error || !verifier) return res.redirect(`/host.html#spotify-error=${encodeURIComponent(req.query.error || 'bad state')}`);
  try {
    await spotifyTokenRequest({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: SPOTIFY_REDIRECT, code_verifier: verifier });
    res.redirect('/host.html');
  } catch (e) { res.redirect(`/host.html#spotify-error=${encodeURIComponent(e.message)}`); }
});
app.post('/api/spotify/logout', hostOnly, (req, res) => { delete config.spotifyRefresh; spotifyAccess = null; saveConfig(); res.json({ ok: true }); });
app.get('/api/spotify/token', hostOnly, async (req, res) => {
  const token = await spotifyToken();
  token ? res.json({ token, expires: spotifyAccess.expires }) : res.status(401).json({ error: 'Not logged in' });
});
const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
app.get('/api/spotify/search', wrap((req) => spotifySearch(String(req.query.q || ''))));
app.get('/api/spotify/karaoke', wrap((req) => findKaraokeVersions({
  title: String(req.query.title || ''), artist: String(req.query.artist || ''),
  duration: Number(req.query.duration) || 0, id: String(req.query.id || ''),
})));

// youtube
app.post('/api/youtube/config', hostOnly, (req, res) => {
  const key = String(req.body.apiKey || '').trim();
  if (key && !/^[\w-]{30,60}$/.test(key)) return res.status(400).json({ error: "That doesn't look like a Google API key." });
  if (key) config.youtubeApiKey = key; else delete config.youtubeApiKey;
  saveConfig();
  res.json({ ok: true, configured: !!key });
});
app.get('/api/youtube/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    if (looksLikeYouTubeLink(q)) return res.json({ results: [await ytResolve(q)], link: true });
    res.json(await ytSearch(q, req.query.karaoke === '1'));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, needsKey: !!e.needsKey }); }
});
app.get('/api/youtube/resolve', wrap((req) => ytResolve(String(req.query.url || ''))));

// ---------- start ----------
await scanLibrary();
detectDemucs().then(() => console.log(demucsCmd ? `  AI vocal removal: Demucs found (${demucsCmd.join(' ')})` : '  AI vocal removal: Demucs not found (instant mode still works). Install with: pip install demucs'));
const { key, cert } = await getCert();
const httpServer = http.createServer(app);
const httpsServer = https.createServer({ key, cert }, app);
for (const srv of [httpServer, httpsServer]) {
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  wss.on('connection', handleWs);
}
httpServer.listen(HTTP_PORT, () => {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('\n🎤  Karaoke is running!\n');
    console.log(`  Host screen (open on THIS computer):  http://127.0.0.1:${HTTP_PORT}`);
    for (const ip of lanIPs()) console.log(`  Phones (same Wi-Fi):                  https://${ip}:${HTTPS_PORT}`);
    console.log(`  Music folder: ${MUSIC_DIR}  (${library.size} songs)`);
    console.log(`  Spotify: ${config.spotifyClientId ? (config.spotifyRefresh ? 'logged in' : 'client ID set, not logged in') : 'not configured'}`);
  });
});
