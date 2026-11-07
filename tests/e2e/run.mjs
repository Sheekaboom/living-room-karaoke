// End-to-end test: starts an isolated server, drives the host screen and a simulated phone in headless Chrome.
//   CHROME_PATH=/path/to/chrome npm run test:e2e
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { makeSong, makeVoice } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Set CHROME_PATH to a Chrome/Chromium binary.'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-e2e-'));
const music = path.join(tmp, 'music'); fs.mkdirSync(music);
makeSong(path.join(music, 'Robot Band - Test Melody.wav'));
const voice = path.join(tmp, 'voice.wav'); makeVoice(voice);
const HTTP = 3190, HTTPS = 3593;
const server = spawn(process.execPath, ['server.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HTTP_PORT: HTTP, HTTPS_PORT: HTTPS, MUSIC_DIR: music, DATA_DIR: path.join(tmp, 'data'), DEMUCS_CMD: `${process.execPath} ${path.join(here, 'fake-demucs.mjs')}` },
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
  await click(mic, '[data-start=range]'); await sleep(5500);
  check('range finder rejects a single repeated note', /very close/.test(await mic.$eval('[data-drill=range] .drill-msg', (e) => e.textContent)));
  await click(mic, '#viewSeg [data-view=progress]'); await sleep(300);
  check('progress tab lists songs and drills', await mic.$eval('#progress', (e) => /Test Melody/.test(e.textContent) && /Hold a note/.test(e.textContent)));

  if (process.env.SCREENSHOTS) {
    await mic.screenshot({ path: path.join(process.env.SCREENSHOTS, 'phone-progress.png'), fullPage: true });
    await click(mic, '#viewSeg [data-view=practice]'); await mic.screenshot({ path: path.join(process.env.SCREENSHOTS, 'phone-practice.png'), fullPage: true });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
