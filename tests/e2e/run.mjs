// End-to-end test: starts an isolated server, drives the host screen and a simulated phone in headless Chrome.
//   CHROME_PATH=/path/to/chrome npm run test:e2e
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { makeSong, makeVoice } from './fixtures.mjs';
import { startYouTubeMock, fakeYouTubePlayer } from './youtube-mocks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Set CHROME_PATH to a Chrome/Chromium binary.'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-e2e-'));
const music = path.join(tmp, 'music'); fs.mkdirSync(music);
makeSong(path.join(music, 'Robot Band - Test Melody.wav'));
const voice = path.join(tmp, 'voice.wav'); makeVoice(voice);
const HTTP = 3190, HTTPS = 3593;
const ytMock = await startYouTubeMock();
const server = spawn(process.execPath, ['server.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HTTP_PORT: HTTP, HTTPS_PORT: HTTPS, MUSIC_DIR: music, DATA_DIR: path.join(tmp, 'data'), DEMUCS_CMD: `${process.execPath} ${path.join(here, 'fake-demucs.mjs')}`,
    YOUTUBE_API_BASE: `http://127.0.0.1:${ytMock.port}/yt`, YOUTUBE_OEMBED_URL: `http://127.0.0.1:${ytMock.port}/oembed`, YOUTUBE_API_KEY: '',
    LRCLIB_BASE: `http://127.0.0.1:${ytMock.port}/lrclib` },
});
let serverLog = ''; server.stdout.on('data', (d) => (serverLog += d)); server.stderr.on('data', (d) => (serverLog += d));
await new Promise((r, j) => { const t = setInterval(() => { if (serverLog.includes('Demucs found')) { clearInterval(t); r(); } }, 100); setTimeout(() => j(new Error('server did not start:\n' + serverLog)), 30000); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };
const setRange = (page, sel, v) => page.evaluate((sel, v) => { const c = document.querySelector(sel); c.value = v; c.dispatchEvent(new Event(c.tagName === 'SELECT' ? 'change' : 'input')); }, sel, v);
const click = (page, sel) => page.evaluate((sel) => document.querySelector(sel).click(), sel);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${voice}`,
    '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const host = await browser.newPage(); await host.setViewport({ width: 1400, height: 860 });
  const mic = await browser.newPage(); await mic.setViewport({ width: 390, height: 1000, isMobile: true, deviceScaleFactor: 2 });
  await host.evaluateOnNewDocument(fakeYouTubePlayer);
  for (const [n, p] of [['host', host], ['mic', mic]]) {
    p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && !/lrclib|Failed to load resource/.test(m.text()) && errors.push(`${n}: ${m.text()}`));
  }

  // ── host + phone connect ──
  await host.goto(`http://127.0.0.1:${HTTP}/`, { waitUntil: 'networkidle0' });
  await click(host, '#startBtn'); await sleep(1500);
  await mic.goto(`https://127.0.0.1:${HTTPS}/`, { waitUntil: 'networkidle0' });
  await mic.evaluate(() => localStorage.setItem('karaoke-range', JSON.stringify({ low: 52, high: 64 })));
  await mic.type('#name', 'Sam'); await click(mic, '#joinBtn'); await sleep(3500);
  const peer = (await host.evaluate(() => [...karaoke.peers.values()].map((p) => ({ state: p.pc.connectionState, midi: p.last?.midi }))))[0];
  check('phone mic connects over WebRTC', peer?.state === 'connected');
  check('host WASM pitch tracker hears E4 from the phone', Math.abs((peer?.midi ?? 0) - 64) < 0.3, `midi ${peer?.midi?.toFixed(2)}`);
  check('phone profile (range) reaches the host', await host.evaluate(() => karaoke.party.singers[0]?.range?.low === 52));
  check('phone tuner shows E4', (await mic.$eval('#tuner .tn-note', (e) => e.textContent)) === 'E4');

  // ── spectral removal on a queued karaoke song ──
  await mic.waitForSelector('#results button[data-mode=karaoke]');
  await click(mic, '#results button[data-mode=karaoke]'); await sleep(400);
  check('phone can queue a song', (await host.evaluate(() => karaoke.party.queue.length)) === 1);
  await host.evaluate(() => karaoke.playNext()); await sleep(2500);
  const spec = () => host.evaluate(async () => {
    const { ctx, nodes } = karaoke; const sp = ctx.createChannelSplitter(2), an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
    nodes.musicVol.connect(sp); sp.connect(an, 1);
    const bin = (f) => Math.round(f / (ctx.sampleRate / an.fftSize)); const d = new Float32Array(an.frequencyBinCount); let voc = 0, side = 0;
    for (let k = 0; k < 15; k++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatFrequencyData(d);
      const pk = (f) => Math.max(...[-2, -1, 0, 1, 2].map((o) => d[bin(f) + o])); voc += Math.max(pk(440), pk(523.25), pk(659.25), pk(880)); side += pk(330); }
    nodes.musicVol.disconnect(sp); return { voc: voc / 15, side: side / 15 };
  });
  const on = await spec(); await setRange(host, '#cut', 0); await sleep(300); const offv = await spec(); await setRange(host, '#cut', 1);
  check('spectral removal cuts the centred vocal by > 30 dB', offv.voc - on.voc > 30, `${(offv.voc - on.voc).toFixed(1)} dB`);
  check('spectral removal leaves side instruments (< 3 dB change)', Math.abs(offv.side - on.side) < 3, `${(offv.side - on.side).toFixed(1)} dB`);

  // ── loop + speed from the phone ──
  await click(mic, '[data-c=loop]'); await sleep(300);
  const loop = await host.evaluate(() => karaoke.current.loop);
  check('phone toggles a loop on the host', !!loop);
  await sleep(Math.max(0, (loop.b - (await host.evaluate(() => karaoke.position()))) * 1000) + 1500);
  const posAfter = await host.evaluate(() => karaoke.position());
  check('loop jumps back to its start', posAfter >= loop.a - 0.2 && posAfter < loop.b, `pos ${posAfter.toFixed(2)} in [${loop.a.toFixed(2)}, ${loop.b.toFixed(2)}]`);
  await click(mic, '[data-c=loop]');
  await setRange(mic, '#phoneSpeed', '0.8'); await sleep(300);
  check('phone sets playback speed', (await host.evaluate(() => karaoke.nodes.musicEl.playbackRate)) === 0.8);
  await host.evaluate(() => karaoke.songEnded()); await sleep(500);

  // ── AI split, scoring, after-song report, vocal range + key suggestion ──
  await click(host, '[data-tab=library]'); await sleep(600);
  await click(host, '#libList button[data-a=ai]'); await sleep(4000);
  check('AI split finishes', (await host.$eval('#libList .acts', (e) => e.textContent)).startsWith('AI'));
  await click(host, '#upNext [data-close]').catch(() => {});
  await host.evaluate(() => { document.querySelector('#singerPick').value = 'Sam'; document.querySelector('#libList button[data-a=karaoke]').click(); }); await sleep(300);
  await host.evaluate(() => karaoke.playNext()); await sleep(7000);
  check('AI mode is used for the separated song', await host.evaluate(() => karaoke.current.ai));
  await host.evaluate(() => karaoke.songEnded()); await sleep(800);
  const rep = await host.$eval('#upNext', (e) => e.textContent);
  check('after-song report shows on the host', /pitch accuracy/.test(rep) && /Tuning/.test(rep));
  if (process.env.SCREENSHOTS) await host.screenshot({ path: path.join(process.env.SCREENSHOTS, 'host-report.png') });
  await sleep(500);
  const hist = await mic.evaluate(() => JSON.parse(localStorage.getItem('karaoke-history') || '[]'));
  const r = hist.find((h) => h.type === 'song')?.report;
  check('report is delivered to the phone and saved', !!r, r ? `accuracy ${Math.round(r.accuracy * 100)}%, range ${r.range.lowName}–${r.range.highName}` : '');
  // steady E4 against an A4-C5-E5-A5 melody: E matches 1 note in 4, others get no/half credit
  check('accuracy is plausible for the test melody (15–45%)', r && r.accuracy > 0.15 && r.accuracy < 0.45);
  check('phone shows the report card', (await mic.$eval('#lastReport', (e) => e.textContent)).includes('Your report'));
  const tr = await host.evaluate(() => fetch('/api/library').then((x) => x.json()).then((l) => l[0]));
  await click(host, '#upNext [data-close]').catch(() => {});
  await host.evaluate((t) => karaoke.practiceLine(t, 0), tr); await sleep(2500);
  const prac = await host.evaluate(() => ({ rate: karaoke.nodes.musicEl.playbackRate, loop: !!karaoke.current?.loop, playing: !karaoke.nodes.musicEl.paused }));
  check('practice replay loops at 85% speed', prac.rate === 0.85 && prac.loop && prac.playing, JSON.stringify(prac));
  await host.evaluate(() => karaoke.songEnded()); await sleep(300);
  check('song vocal range saved after an AI-split play', tr.vocalRange && tr.vocalRange.low > 65 && tr.vocalRange.high < 82, JSON.stringify(tr.vocalRange));
  await click(host, '#upNext [data-close]').catch(() => {});
  await host.evaluate(() => { document.querySelector('#libList button[data-a=karaoke]').click(); }); await sleep(300);
  await host.evaluate(() => karaoke.playNext()); await sleep(1500);
  const np = await host.$eval('#npMode', (e) => e.textContent);
  // singer 52–64 (centre 58) vs song ~69–81 (centre 75): 17 down = 5 down + an octave
  check('key suggestion offered for the singer (−5)', /Suggested key for Sam: -5/.test(np), np.trim());

  // ── practice: hold-a-note drill on the phone ──
  await host.evaluate(() => karaoke.songEnded());
  await click(mic, '#viewSeg [data-view=practice]'); await sleep(300);
  // default target is the middle of 52..64 = 58; step up to E4 (64)
  for (let i = 0; i < 6; i++) await click(mic, '[data-hold="1"]');
  check('hold-a-note target set to E4', (await mic.$eval('[data-holdnote]', (e) => e.textContent)) === 'E4');
  await click(mic, '[data-start=hold]'); await sleep(800);
  check('phone is muted to the room during drills', await host.evaluate(() => [...karaoke.peers.values()][0].rms < 0.01));
  await sleep(6500);
  const drillMsg = await mic.$eval('[data-drill=hold] .drill-msg', (e) => e.textContent);
  check('hold drill scores a steady E4 as 100%', /Score 100%/.test(drillMsg), drillMsg.slice(0, 90));
  await sleep(1000);
  check('mic is back on for the room after the drill', await host.evaluate(() => [...karaoke.peers.values()][0].rms > 0.05));
  await click(mic, '[data-start=range]');
  const rangeMsg = await mic.waitForFunction(() => /very close|Couldn't/.test(document.querySelector('[data-drill=range] .drill-msg')?.textContent || ''), { timeout: 15000 })
    .then(() => mic.$eval('[data-drill=range] .drill-msg', (e) => e.textContent)).catch(() => 'timed out');
  check('range finder rejects a single repeated note', /very close/.test(rangeMsg), rangeMsg.slice(0, 60));
  await click(mic, '#viewSeg [data-view=progress]'); await sleep(300);
  check('progress tab lists songs and drills', await mic.$eval('#progress', (e) => /Test Melody/.test(e.textContent) && /Hold a note/.test(e.textContent)));

  // ── YouTube ──
  await click(mic, '#viewSeg [data-view=sing]');
  await click(mic, '#srcSeg [data-src=youtube]'); await sleep(200);
  await mic.evaluate(() => { const q = document.querySelector('#q'); q.value = 'robot melody'; q.dispatchEvent(new Event('input')); }); await sleep(600);
  check('YouTube does not search while typing', ytMock.calls.search === 0);
  await mic.evaluate(() => document.querySelector('#qForm').requestSubmit()); await sleep(600);
  check('YouTube search without an API key explains what to do', /API key/.test(await mic.$eval('#searchMsg', (e) => e.textContent)) && ytMock.calls.search === 0);
  // paste a link: works without a key via oEmbed
  await mic.evaluate(() => { const q = document.querySelector('#q'); q.value = 'https://youtu.be/bbbbbbbbbb2?si=x'; q.dispatchEvent(new Event('input')); }); await sleep(900);
  const pasted = await mic.$$eval('#results .track .t', (els) => els.map((e) => e.textContent));
  check('pasted YouTube link resolves without a key (oEmbed)', pasted.length === 1 && pasted[0] === 'Robot Band & Friends - Second Song' && ytMock.calls.oembed === 1, pasted.join(','));
  // host adds the API key in Setup
  await click(host, '[data-tab=setup]');
  await host.evaluate(() => { document.querySelector('#ytKey').value = 'AIzaTEST_KEY_0123456789abcdefghijklmnop'; document.querySelector('#ytSave').click(); }); await sleep(600);
  check('host saves a YouTube API key', /Saved/.test(await host.$eval('#ytSetupMsg', (e) => e.textContent)));
  await mic.evaluate(() => { const q = document.querySelector('#q'); q.value = 'robot melody'; document.querySelector('#qForm').requestSubmit(); }); await sleep(900);
  const found = await mic.$$eval('#results .track .t', (els) => els.map((e) => e.textContent));
  check('YouTube search returns embeddable videos', found.length === 3 && ytMock.calls.search === 1, found.join(' | '));
  check('"karaoke versions only" adds "karaoke" to the query', ytMock.calls.lastQuery === 'robot melody karaoke', ytMock.calls.lastQuery);
  await host.evaluate(() => { document.querySelector('[data-tab=youtube]').click(); document.querySelector('#ytSearch').value = 'robot melody'; document.querySelector('#ytForm').requestSubmit(); }); await sleep(800);
  check('repeat YouTube search is served from cache', ytMock.calls.search === 1 && /cache/.test(await host.$eval('#ytHint', (e) => e.textContent)));
  // queue: blocked video first, then a karaoke video, then a second video
  await host.evaluate(() => { const b = document.querySelectorAll('#ytList button[data-a=add]'); b[2].click(); b[0].click(); b[1].click(); }); await sleep(500);
  check('YouTube videos are queued', (await host.evaluate(() => karaoke.party.queue.filter((q) => q.source === 'youtube').length)) === 3);
  await host.evaluate(() => karaoke.playNext()); await sleep(1500);
  const afterBlocked = await host.evaluate(() => ({ cur: karaoke.current?.item.id ?? null, log: window.__ytLog.map((x) => x.join(':')) }));
  check('embedding-blocked video is skipped with a message', afterBlocked.cur === null && afterBlocked.log.includes('load:blockedvid3'), JSON.stringify(afterBlocked));
  await host.evaluate(() => document.querySelector('#upNext [data-go]').click()); await sleep(1200);
  const yv = await host.evaluate(() => ({ kind: karaoke.current?.kind, id: karaoke.current?.item.id, shown: !document.querySelector('#ytBox').classList.contains('hidden'),
    vol: karaoke.yt.vol, lyricsHidden: document.querySelector('.lyricsBox').classList.contains('nolyrics'), note: document.querySelector('#npMode').textContent }));
  check('YouTube video plays on the stage', yv.kind === 'youtube' && yv.id === 'aaaaaaaaaa1' && yv.shown, JSON.stringify(yv));
  check('karaoke video hides the lyrics overlay (lyrics are in the video)', yv.lyricsHidden && /Karaoke video/.test(yv.note));
  check('music volume is applied to the YouTube player', yv.vol === 80);
  await click(mic, '[data-c=playpause]'); await sleep(400);
  check('phone pauses the YouTube video', (await host.evaluate(() => karaoke.yt.getPlayerState())) === 2);
  await click(mic, '[data-c=playpause]'); await sleep(300);
  await setRange(host, '#speed', '0.8'); await sleep(200);
  check('speed snaps to a rate YouTube supports', (await host.evaluate(() => karaoke.yt.rate)) === 0.75);
  await setRange(host, '#speed', '1');
  await sleep(6500); // fake video is 6 s long
  const ended = await host.evaluate(() => ({ cur: karaoke.current, shown: !document.querySelector('#ytBox').classList.contains('hidden'), upnext: document.querySelector('#upNext').textContent }));
  check('end of a YouTube video advances to the next-up card', ended.cur === null && !ended.shown && /Second Song/.test(ended.upnext));
  await host.evaluate(() => document.querySelector('#upNext [data-go]').click()); await sleep(1000);
  check('next YouTube video starts', (await host.evaluate(() => karaoke.current?.item.id)) === 'bbbbbbbbbb2');
  await sleep(1500);
  const ov = await host.evaluate(() => ({ hidden: document.querySelector('.lyricsBox').classList.contains('nolyrics'), text: document.querySelector('#lyrics').textContent }));
  check('non-karaoke video overlays synced lyrics (title parsed to artist/title)', !ov.hidden && /little robot|second line/.test(ov.text), ov.text.trim().slice(0, 60));
  check('phone receives the lyric feed for a YouTube video', /robot|second line|third/i.test(await mic.$eval('#lyr', (e) => e.textContent)));
  if (process.env.SCREENSHOTS) { await host.bringToFront(); await host.screenshot({ path: path.join(process.env.SCREENSHOTS, 'host-youtube.png') }); }
  await host.evaluate(() => karaoke.songEnded());

  if (process.env.SCREENSHOTS) {
    await mic.bringToFront();
    await mic.screenshot({ path: path.join(process.env.SCREENSHOTS, 'phone-progress.png'), fullPage: true });
    await click(mic, '#viewSeg [data-view=practice]'); await mic.screenshot({ path: path.join(process.env.SCREENSHOTS, 'phone-practice.png'), fullPage: true });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
  ytMock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
