#!/usr/bin/env node
// Stand-in for `demucs` in tests: same CLI shape and output layout, but "separates" by mid/side.
import fs from 'node:fs';
import path from 'node:path';
import { readWav, writeWav } from './fixtures.mjs';
const a = process.argv.slice(2);
if (a.includes('--help')) process.exit(0);
const out = a[a.indexOf('-o') + 1], src = a.at(-1);
const dir = path.join(out, 'htdemucs'); fs.mkdirSync(dir, { recursive: true });
for (const p of [10, 50, 100]) { process.stderr.write(`${p}%|████| ${p}/100\r`); await new Promise((r) => setTimeout(r, 300)); }
const { ch: [L, R], sr } = readWav(src);
const side = L.map((v, i) => 0.5 * (v - R[i])), mid = L.map((v, i) => 0.5 * (v + R[i]));
writeWav(path.join(dir, 'no_vocals.wav'), [side, side.map((v) => -v)], sr);
writeWav(path.join(dir, 'vocals.wav'), [mid, mid], sr);
