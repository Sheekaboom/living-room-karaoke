# 02 — Protocol

Status: Implemented

All WebSocket traffic is JSON on `/ws`. Every message has a `type`. Unknown types MUST be ignored (forward compatibility). The server assigns each connection an 8-char `id`.

## Connection
| Direction | Message | Notes |
|---|---|---|
| S→C | `{type:'welcome', id}` | First message on every connection. |
| C→S | `{type:'hello', role:'host'\|'mic', name}` | Name truncated to 30 chars. A new host replaces the old one (old socket closed with code `4000`). |
| S→mic | `{type:'host-ready', hostId}` | Sent on hello if a host exists, and to all mics when a host connects. Mics (re)start WebRTC on receipt. |
| S→all | `{type:'host-gone'}` | Host disconnected. |
| S→host | `{type:'peer-gone', id}` | A mic disconnected. |
| S→all | `{type:'state', state:{queue, now, hostOnline, singers:[{id,name,range}]}}` | Sent after any change. |

## WebRTC signalling (relay only, the server never parses SDP)
| Direction | Message |
|---|---|
| mic→S→host | `{type:'signal', to:'host', data:{sdp}\|{candidate}}` → host receives `{type:'signal', from, name, data}` |
| host→S→mic | `{type:'signal', to:<micId>, data}` |

Rules: the **mic is always the offerer**. ICE servers are empty (LAN only). The mic rewrites the Opus `fmtp` of the host's answer to `maxaveragebitrate=128000;usedtx=0;useinbandfec=1;maxplaybackrate=48000` and sets `maxBitrate=128000` on its sender. The host sets `receiver.jitterBufferTarget = 0` (fallback `playoutDelayHint = 0`).

## Queue
| Message (C→S) | Who | Effect |
|---|---|---|
| `{type:'queue:add', item}` | anyone | `item = {source:'local'\|'spotify', id, title, artist, album, duration(ms), art, mode:'original'\|'karaoke', singer}`. Server assigns `qid` and records `addedBy`. If `singer` is a string (even empty) it's kept as-is, otherwise the sender's name is used. |
| `{type:'queue:remove', qid}` | anyone | |
| `{type:'queue:move', qid, dir:-1\|1}` | anyone | |
| `{type:'queue:mode', qid, mode}` | anyone | |
| `{type:'now', now, shift?}` | host | Sets now-playing; removes `shift` qid from the queue. `now:null` clears lyrics. |

## Live feeds (host → phones)
| Message | Rate | Payload |
|---|---|---|
| `{type:'lyric', cur, next, next2}` | on line change | Server caches the last one for late joiners. |
| `{type:'ref', midi}` | ≤ 20/s, AI songs only | Reference vocal pitch as fractional MIDI **including** the current key change. Phones treat it as stale after 400 ms. |
| `{type:'relay', to, msg}` (host→S) | — | Server forwards `msg` verbatim to one client. Used for `{type:'report', report}` (see [05](05-training.md#report-object)). |

## Phone → host
| Message | Effect |
|---|---|
| `{type:'control', action, value?}` | Relayed to host with `from`. Actions: `playpause`, `skip`, `restart`, `micvol` (value 0–3, sender's own mic only), `loop` (toggle current line), `speed` (0.7–1, local files), `practice` (value = lyric line index of the **last finished** song; host replays it looping that line at 85%). |
| `{type:'profile', range:{low,high}}` | Stored on the connection, included in `state.singers`. Sent after every hello. |

## Server → clients (other)
`{type:'stems', track}` when a Demucs job changes state; `{type:'library-changed'}` after uploads.

## REST
| Method & path | Access | Purpose |
|---|---|---|
| `GET /api/info` | any | `{micUrls, qr, demucs, spotify:{configured,loggedIn,redirectUri}, isHostOrigin}` |
| `GET /api/library?q=` | any | ≤ 300 tracks: `{source:'local', id, title, artist, album, duration, art, stems:'none'\|'queued'\|'running'\|'ready'\|'error', stemProgress, vocalRange}` |
| `GET /api/track/:id` | any | One track (same shape). |
| `POST /api/library/rescan` | any | Rescan `MUSIC_DIR`. |
| `POST /api/upload` (multipart `files[]`) | any | ≤ 50 files, ≤ 300 MB each, audio extensions only. |
| `GET /media/:id/original\|instrumental\|vocals` | any | Range-capable audio. |
| `GET /api/art/:id` | any | Embedded cover or an SVG placeholder. |
| `POST /api/separate/:id` | any | Queue a Demucs job (400 if Demucs missing). |
| `POST /api/vocal-range/:id` `{low,high}` | host | Save a song's lead-vocal range (MIDI). |
| `GET /api/lyrics?artist&title&album&duration` | any | `{synced:[[sec, text]]\|null, plain, instrumental}` |
| `POST /api/spotify/config` `{clientId}` | host | |
| `GET /spotify/login`, `/spotify/callback` | host | PKCE flow, redirect URI fixed to `http://127.0.0.1:<HTTP_PORT>/spotify/callback`. |
| `POST /api/spotify/logout` | host | |
| `GET /api/spotify/token` | host | Access token for the Web Playback SDK. |
| `GET /api/spotify/search?q=` | any | ≤ 10 tracks (Spotify dev-mode cap). |
| `GET /api/spotify/karaoke?title&artist&duration&id` | any | Ranked karaoke/instrumental candidates (see [04](04-playback-and-sources.md)). |

## Compatibility rules
- Adding fields or message types: allowed any time.
- Renaming or removing: deprecate first (keep handling the old form for one release) and note it in the changelog.
