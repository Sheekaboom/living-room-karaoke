// Pure YouTube helpers shared by the server, host, phone and tests (no DOM, no network).

/** Extract an 11-char video ID from a URL, a "youtu.be" link, a Shorts link or a bare ID. */
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/) || [])[1] || null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** True if a search box entry is a link or a bare video ID rather than search words. */
export function looksLikeYouTubeLink(q) {
  const s = String(q || '').trim();
  if (/(youtu\.be\/|youtube(-nocookie)?\.com\/)/i.test(s)) return !!parseYouTubeId(s);
  // bare 11-char IDs: require a digit, '-', '_' or mixed case so ordinary words aren't mistaken for IDs
  return /^[\w-]{11}$/.test(s) && (/[\d_-]/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s.slice(1))));
}

/** ISO-8601 duration (PT1H2M3S) -> milliseconds. */
export function parseIsoDuration(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
export const decodeEntities = (s) => String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, e) => {
  if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
  return all;
});

export const isKaraokeTitle = (t) => /karaoke|instrumental|sing[\s-]?along|off[\s-]?vocal|backing track|minus one|no vocals?/i.test(t || '');

/**
 * Best guess at "artist" and "title" from a video title + channel, for lyrics lookup.
 * "Adele - Hello (Karaoke Version)" -> {artist:'Adele', title:'Hello'}
 */
export function guessArtistTitle(videoTitle, channel = '') {
  let t = decodeEntities(videoTitle);
  t = t.replace(/[\(\[【][^\)\]】]*(karaoke|instrumental|lyrics?|official|video|audio|hd|4k|version|sing ?along|remaster|visuali[sz]er|mv|with vocals|no vocals|backing)[^\)\]】]*[\)\]】]/gi, ' ');
  t = t.replace(/\s*[|｜].*$/, '').replace(/\s+(karaoke|instrumental)(\s+version)?\s*$/i, '');
  t = t.replace(/\s*(ft\.?|feat\.?)\s+[^-–]*$/i, '').replace(/\s{2,}/g, ' ').trim();
  const parts = t.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').replace(/^["“']|["”']$/g, '').trim() };
  const ch = String(channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const looksLikeKaraokeChannel = /karaoke|sing king|zoom|stingray|kara|instrumental/i.test(ch);
  return { artist: looksLikeKaraokeChannel ? '' : ch, title: t.replace(/^["“']|["”']$/g, '').trim() };
}

/** Map YouTube API search + videos.list items to our track shape. */
export function mapVideo(item) {
  const sn = item.snippet || {};
  const title = decodeEntities(sn.title);
  return {
    source: 'youtube', id: item.id, title, artist: decodeEntities(sn.channelTitle || ''), album: '',
    duration: parseIsoDuration(item.contentDetails?.duration),
    art: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
    karaoke: isKaraokeTitle(title),
  };
}

/** Today's date in US Pacific time (YouTube quotas reset at midnight PT). */
export function pacificDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}
