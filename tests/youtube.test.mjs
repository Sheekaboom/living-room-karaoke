import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeId, looksLikeYouTubeLink, parseIsoDuration, guessArtistTitle, decodeEntities, isKaraokeTitle, mapVideo } from '../public/youtube.js';

test('parseYouTubeId handles common link shapes', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [id, `https://www.youtube.com/watch?v=${id}`, `youtube.com/watch?v=${id}&t=42s`, `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`, `https://music.youtube.com/watch?v=${id}&list=x`])
    assert.equal(parseYouTubeId(u), id, u);
  assert.equal(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeId('hello world'), null);
});

test('looksLikeYouTubeLink does not mistake words for IDs', () => {
  assert.ok(looksLikeYouTubeLink('https://youtu.be/dQw4w9WgXcQ'));
  assert.ok(looksLikeYouTubeLink('dQw4w9WgXcQ'));
  assert.ok(!looksLikeYouTubeLink('bohemianrha'));
  assert.ok(!looksLikeYouTubeLink('Bohemianrha'));
  assert.ok(!looksLikeYouTubeLink('let it go karaoke'));
});

test('ISO durations', () => {
  assert.equal(parseIsoDuration('PT4M13S'), 253000);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723000);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration('PT45S'), 45000);
});

test('artist/title guessing for lyrics', () => {
  assert.deepEqual(guessArtistTitle('Adele - Hello (Karaoke Version)', 'Sing King'), { artist: 'Adele', title: 'Hello' });
  assert.deepEqual(guessArtistTitle('Queen – Bohemian Rhapsody [Official Video Remastered]', 'Queen Official'), { artist: 'Queen', title: 'Bohemian Rhapsody' });
  assert.deepEqual(guessArtistTitle('Mr. Brightside | Karaoke', 'Sing King'), { artist: '', title: 'Mr. Brightside' });
  assert.deepEqual(guessArtistTitle('Dancing Queen', 'ABBA - Topic'), { artist: 'ABBA', title: 'Dancing Queen' });
  assert.deepEqual(guessArtistTitle('Toto - Africa (Lyrics) ft. Someone', 'x'), { artist: 'Toto', title: 'Africa' });
});

test('entities, karaoke detection, mapping', () => {
  assert.equal(decodeEntities('Don&#39;t Stop Me Now &amp; More'), "Don't Stop Me Now & More");
  assert.ok(isKaraokeTitle('Song (Karaoke Version)'));
  assert.ok(isKaraokeTitle('Song - Instrumental with lyrics'));
  assert.ok(!isKaraokeTitle('Song (Official Video)'));
  const v = mapVideo({ id: 'abcdefghijk', snippet: { title: 'A &amp; B - C (Karaoke)', channelTitle: 'Sing King', thumbnails: { medium: { url: 'x.jpg' } } }, contentDetails: { duration: 'PT3M' } });
  assert.deepEqual(v, { source: 'youtube', id: 'abcdefghijk', title: 'A & B - C (Karaoke)', artist: 'Sing King', album: '', duration: 180000, art: 'x.jpg', karaoke: true });
});
