// Mock YouTube Data API + oEmbed server, and a stand-in for the YouTube IFrame player.
import http from 'node:http';

export const VIDEOS = {
  aaaaaaaaaa1: { title: 'Robot Band - Test Melody (Karaoke Version)', channel: 'Sing Bot', duration: 'PT6S' },
  bbbbbbbbbb2: { title: 'Robot Band &amp; Friends - Second Song', channel: 'Robot Band', duration: 'PT6S' },
  blockedvid3: { title: 'Blocked Video', channel: 'Nobody', duration: 'PT3M' },
};

export function startYouTubeMock() {
  const calls = { search: 0, videos: 0, oembed: 0, lastQuery: '' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/yt/search') {
      calls.search++; calls.lastQuery = u.searchParams.get('q');
      if (u.searchParams.get('key') !== 'AIzaTEST_KEY_0123456789abcdefghijklmnop') return json(400, { error: { errors: [{ reason: 'keyInvalid' }], message: 'bad key' } });
      return json(200, { items: ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'blockedvid3'].map((id) => ({ id: { kind: 'youtube#video', videoId: id } })) });
    }
    if (u.pathname === '/yt/videos') {
      calls.videos++;
      const items = u.searchParams.get('id').split(',').filter((id) => VIDEOS[id]).map((id) => ({
        id, snippet: { title: VIDEOS[id].title, channelTitle: VIDEOS[id].channel, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
        contentDetails: { duration: VIDEOS[id].duration }, status: { embeddable: true },
      }));
      return json(200, { items });
    }
    if (u.pathname === '/oembed') {
      calls.oembed++;
      const id = new URL(u.searchParams.get('url')).searchParams.get('v');
      if (!VIDEOS[id]) return json(404, {});
      return json(200, { title: VIDEOS[id].title, author_name: VIDEOS[id].channel, thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    }
    // LRCLIB mock: synced lyrics only for the second YouTube video
    if (u.pathname === '/lrclib/api/get') {
      calls.lyrics = (calls.lyrics || 0) + 1;
      if (u.searchParams.get('artist_name') === 'Robot Band & Friends' && u.searchParams.get('track_name') === 'Second Song')
        return json(200, { syncedLyrics: '[00:00.30] Hello little robot\n[00:02.00] Sing the second line\n[00:04.00] And the third one', plainLyrics: 'x' });
      return json(404, {});
    }
    if (u.pathname === '/lrclib/api/search') return json(200, []);
    json(404, {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, calls, close: () => srv.close() })));
}

/** Injected into the host page before any script runs: a minimal YT.Player with real-time playback. */
export function fakeYouTubePlayer() {
  window.__ytLog = [];
  class Player {
    constructor(el, opts) {
      this.opts = opts; this.state = -1; this.t0 = 0; this.pos = 0; this.rate = 1; this.vol = 100; this.dur = 6; this.id = null;
      window.__ytLog.push(['create']);
      setTimeout(() => opts.events.onReady({ target: this }), 50);
      this.timer = setInterval(() => {
        if (this.state === 1 && this.getCurrentTime() >= this.dur) { this.state = 0; this.pos = this.dur; this.emit(0); }
      }, 100);
    }
    emit(s) { this.opts.events.onStateChange({ data: s, target: this }); }
    loadVideoById(id) {
      this.id = id; this.pos = 0; window.__ytLog.push(['load', id]);
      if (id === 'blockedvid3') return setTimeout(() => this.opts.events.onError({ data: 150, target: this }), 100);
      this.state = 3; this.emit(3);
      setTimeout(() => { this.t0 = performance.now(); this.state = 1; this.emit(1); }, 150);
    }
    getCurrentTime() { return this.state === 1 ? this.pos + ((performance.now() - this.t0) / 1000) * this.rate : this.pos; }
    getDuration() { return this.dur; }
    getPlayerState() { return this.state; }
    playVideo() { if (this.state !== 1) { this.t0 = performance.now(); this.state = 1; this.emit(1); } }
    pauseVideo() { if (this.state === 1) { this.pos = this.getCurrentTime(); this.state = 2; this.emit(2); } }
    stopVideo() { this.pos = 0; this.state = 5; window.__ytLog.push(['stop']); }
    seekTo(s) { this.pos = s; this.t0 = performance.now(); window.__ytLog.push(['seek', s]); }
    setVolume(v) { this.vol = v; }
    setPlaybackRate(r) { this.pos = this.getCurrentTime(); this.t0 = performance.now(); this.rate = r; }
    getAvailablePlaybackRates() { return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]; }
  }
  window.YT = { Player };
}
