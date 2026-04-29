/**
 * WCYT Playlist Widget
 * Polls the Icecast status endpoint and renders a KEXP-style
 * now-playing + recent-plays display with integrated audio player.
 *
 * To swap in a proxy if CORS fails, change METADATA_URL to your
 * proxy endpoint (e.g. "https://wcyt.org/nowplaying.php").
 */

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const METADATA_URL  = 'https://securestreams2.autopo.st:1069/status-json.xsl';
  const POLL_MS       = 10_000;
  const MAX_HISTORY   = 50;
  const FALLBACK_ART  = 'https://images.squarespace-cdn.com/content/v1/66213a95afc386140701f167/1713453740425-M44AKIWYWNTFZHGQWZDY/WCYT-removebg-preview.png';
  const FALLBACK_ART_2 = '/images/shows/2.0 Logo.png';
  const SHOW_URL      = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRvbq5nlJGzIblU91RLbcNBwChU9jE28xlwM537tunzMWb3hWyHmnuojMZAjKqNdSP8mmoDXdzp4U0a/pub?output=csv';
  const SHOW_TTL_MS   = 45 * 60 * 1000; // auto-clear after 45 minutes

  // ── BSI output files (album/year data from Simian) ────────────────────────
  // Raw GitHub URL bypasses the GitHub Pages CDN — updates within seconds of a push
  const RAW_BASE = 'https://raw.githubusercontent.com/dunnand/WCYT-Website/main';
  const BSI_FILES = [
    '/Point_Display_OUT.htm', // station 0 — The Point
    '/2_Display_OUT.htm',     // station 1 — 2.0
  ];

  // ── DJ Panel (JSONBin) ────────────────────────────────────────────
  // After setting up JSONBin, paste your Bin ID here.
  const DJPANEL_BIN_ID  = '69dfdf65856a6821893a19f8'; // e.g. '6613abc123def456'
  const DJPANEL_KEY     = '$2a$10$3JxMllL6YGZtbEqwOQTbFeww2P.sNZ.b.aPWPreit5UwyM1pFHxie';
  const DJPANEL_URL     = DJPANEL_BIN_ID
    ? `https://api.jsonbin.io/v3/b/${DJPANEL_BIN_ID}/latest`
    : '';

  // ── Last.fm config ────────────────────────────────────────────────────────
  // Register free API keys at https://www.last.fm/api/account/create
  const LASTFM_KEY    = 'cdd7c1932d8d41d9ec8918ef01b617c9';
  const LASTFM_SECRET = 'b91a01a7583f831133adff6cf4831390';
  const LASTFM_API    = 'https://ws.audioscrobbler.com/2.0/';

  const STATIONS = [
    {
      id:         'wcyt',
      label:      'WCYT THE POINT 91FM',
      short:      'The Point',
      name:       'The Point 91 FM',
      tagline:    'Where Music is the Point',
      stream:     'https://securestreams2.autopo.st:1069/WCYT.mp3',
      mount:      'WCYT.mp3',
    },
    {
      id:         '2pt0',
      label:      '2.0 NEXT LEVEL OF RADIO',
      short:      '2.0',
      name:       '2.0 – The Next Level of Radio',
      tagline:    'The Next Level of Radio',
      stream:     'https://securestreams2.autopo.st:1069/wcythd2.mp3',
      mount:      'wcythd2.mp3',
    },
  ];

  // Titles/artists that should never appear in the playlist display.
  const BLOCKED_TERMS = [
    'liner',
    'legal id',
    'btyb',
    'sponsor',
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let currentSong    = null;
  let songHistory    = [];
  let currentSong2   = null;   // now-playing for station 2
  let songHistory2   = [];     // recent plays for station 2
  let bsiRecent1     = [];     // recently played from BSI file, station 0
  let bsiRecent2     = [];     // recently played from BSI file, station 1
  const ART_CACHE_KEY = 'wcyt-art-cache';
  const ART_CACHE_MAX = 500;
  let artCache = (() => {
    try { return JSON.parse(localStorage.getItem(ART_CACHE_KEY) || '{}'); } catch { return {}; }
  })();
  function saveArtCache() {
    try {
      const keys = Object.keys(artCache);
      if (keys.length > ART_CACHE_MAX) {
        const trimmed = {};
        keys.slice(-ART_CACHE_MAX).forEach(k => { trimmed[k] = artCache[k]; });
        artCache = trimmed;
      }
      localStorage.setItem(ART_CACHE_KEY, JSON.stringify(artCache));
    } catch {}
  }
  let currentShowWCYT = null;  // { name: string, expiresAt: Date } | null  (The Point)
  let currentShow2    = null;  // { name: string, expiresAt: Date } | null  (2.0)
  let heroEl            = null;
  let compactEl         = null;
  let fullEl            = null;
  let stickyEl          = null;
  let stickyVisible     = false;
  let pendingAutoResume = false;
  let corsWarned        = false;
  let pollTimer         = null;
  let tickTimer         = null;
  let activeStation     = 0;   // index into STATIONS

  // ── DJ Panel state ────────────────────────────────────────────────
  let djPanel = { wcyt: null, '2pt0': null };

  async function fetchDJPanel() {
    if (!DJPANEL_URL) return;
    try {
      const res  = await fetch(DJPANEL_URL, { cache: 'no-store', headers: { 'X-Master-Key': DJPANEL_KEY } });
      const data = await res.json();
      const rec  = data.record || {};
      djPanel['wcyt'] = rec['wcyt']  || null;
      djPanel['2pt0'] = rec['2pt0'] || null;
      render();
    } catch (err) {
      console.warn('[WCYTPlaylist] DJ panel fetch error:', err);
    }
  }

  const DJ_EXPIRE_MS = 30 * 60 * 1000; // 30 minutes

  function getDJPanel(stationIdx) {
    const key = stationIdx === 0 ? 'wcyt' : '2pt0';
    const p   = djPanel[key];
    if (!p || !p.active) return null;
    if (p.updatedAt && Date.now() - new Date(p.updatedAt).getTime() > DJ_EXPIRE_MS) return null;
    return p;
  }

  // ── Last.fm state ─────────────────────────────────────────────────────────
  let lastfmSession  = null;   // { key, name } | null
  let lfmCurrent     = null;   // { artist, title, startedAt } | null
  let lfmListenMs    = 0;      // ms of current song actually heard
  let lfmListenTick  = null;   // timestamp audio started for current accumulation

  // ── Audio player state ────────────────────────────────────────────────────
  let audio          = null;
  let audioState     = 'stopped';

  function getAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.addEventListener('waiting',  () => setAudioState('buffering'));
      audio.addEventListener('playing',  () => setAudioState('playing'));
      audio.addEventListener('pause',    () => setAudioState('stopped'));
      audio.addEventListener('ended',    () => setAudioState('stopped'));
      audio.addEventListener('error',    () => setAudioState('stopped'));
    }
    return audio;
  }

  function setAudioState(state) {
    // Track listen time for scrobbling
    if (state === 'playing' && audioState !== 'playing') {
      lfmListenTick = Date.now();
    } else if (state !== 'playing' && audioState === 'playing') {
      if (lfmListenTick) { lfmListenMs += Date.now() - lfmListenTick; lfmListenTick = null; }
    }
    audioState = state;
    updatePlayerButtons();
    updateBarsAnimation();
    renderSticky();
  }

  function savePlayerState() {
    try {
      sessionStorage.setItem('wcyt-player', JSON.stringify({
        station: activeStation,
        playing: audioState === 'playing' || audioState === 'buffering',
        showWCYT: currentShowWCYT ? { name: currentShowWCYT.name, expiresAt: currentShowWCYT.expiresAt.toISOString() } : null,
        show2:    currentShow2    ? { name: currentShow2.name,    expiresAt: currentShow2.expiresAt.toISOString()    } : null,
      }));
    } catch {}
  }

  function togglePlay() {
    const a = getAudio();
    if (audioState === 'playing' || audioState === 'buffering') {
      a.pause();
      a.src = '';
    } else {
      a.src = STATIONS[activeStation].stream;
      a.play().catch(() => setAudioState('stopped'));
      setAudioState('buffering');
    }
    savePlayerState();
  }

  function switchStation(idx) {
    if (idx === activeStation) return;
    activeStation = idx;
    const a = getAudio();
    const wasPlaying = audioState === 'playing' || audioState === 'buffering';
    a.pause();
    a.src = '';
    setAudioState('stopped');
    if (wasPlaying) {
      a.src = STATIONS[activeStation].stream;
      a.play().catch(() => setAudioState('stopped'));
      setAudioState('buffering');
    }
    savePlayerState();
    render();
  }

  function updatePlayerButtons() {
    document.querySelectorAll('[data-wcyt-playbtn]').forEach(btn => {
      btn.setAttribute('data-wcyt-playbtn', audioState);
      btn.setAttribute('aria-label', audioState === 'playing' ? 'Pause' : 'Play');
      btn.innerHTML = btnIcon(audioState);
    });
  }

  function updateBarsAnimation() {
    const playing = audioState === 'playing';
    document.querySelectorAll('.wcyt-bars span').forEach(bar => {
      bar.style.animationPlayState = 'running';
    });
  }

  const PAUSE_SVG = '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><rect x="0" y="0" width="3.5" height="16" rx="1.5"/><rect x="8.5" y="0" width="3.5" height="16" rx="1.5"/></svg>';
  const PLAY_SVG  = '<span class="wcyt-btn-icon">&#9654;</span>';

  function btnIcon(state) {
    if (state === 'buffering') return '<span class="wcyt-btn-spinner"></span>';
    if (state === 'playing')   return PAUSE_SVG;
    return PLAY_SVG;
  }

  function playBtnHTML(size) {
    const cls = size === 'lg' ? 'wcyt-play-btn wcyt-play-btn--lg' : 'wcyt-play-btn';
    return `<button
      class="${cls}"
      data-wcyt-playbtn="${audioState}"
      aria-label="${audioState === 'playing' ? 'Pause' : 'Play'}"
      onclick="WCYTPlaylist.togglePlay()"
    >${btnIcon(audioState)}</button>`;
  }

  // ── Last.fm MD5 + API helpers ─────────────────────────────────────────────

  function lfmMd5(input) {
    function safeAdd(x, y) {
      const lsw = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff);
    }
    const rol = (n, s) => (n << s) | (n >>> (32 - s));
    const cmn = (q, a, b, x, s, t) => safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    const ff  = (a,b,c,d,x,s,t) => cmn((b & c) | (~b & d), a, b, x, s, t);
    const gg  = (a,b,c,d,x,s,t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
    const hh  = (a,b,c,d,x,s,t) => cmn(b ^ c ^ d, a, b, x, s, t);
    const ii  = (a,b,c,d,x,s,t) => cmn(c ^ (b | ~d), a, b, x, s, t);
    const str = unescape(encodeURIComponent(input));
    const M   = [];
    for (let i = 0; i < str.length * 8; i += 8) M[i >> 5] = (M[i >> 5] || 0) | (str.charCodeAt(i / 8) & 0xff) << (i % 32);
    M[str.length * 8 >> 5] |= 0x80 << (str.length * 8 % 32);
    M[(((str.length * 8 + 64) >>> 9) << 4) + 14] = str.length * 8;
    let [a, b, c, d] = [1732584193, -271733879, -1732584194, 271733878];
    for (let i = 0, n = M.length; i < n; i += 16) {
      const [oa, ob, oc, od] = [a, b, c, d];
      const w = [...M.slice(i, i + 16), ...Array(16).fill(0)].slice(0, 16);
      a=ff(a,b,c,d,w[0],7,-680876936);d=ff(d,a,b,c,w[1],12,-389564586);c=ff(c,d,a,b,w[2],17,606105819);b=ff(b,c,d,a,w[3],22,-1044525330);
      a=ff(a,b,c,d,w[4],7,-176418897);d=ff(d,a,b,c,w[5],12,1200080426);c=ff(c,d,a,b,w[6],17,-1473231341);b=ff(b,c,d,a,w[7],22,-45705983);
      a=ff(a,b,c,d,w[8],7,1770035416);d=ff(d,a,b,c,w[9],12,-1958414417);c=ff(c,d,a,b,w[10],17,-42063);b=ff(b,c,d,a,w[11],22,-1990404162);
      a=ff(a,b,c,d,w[12],7,1804603682);d=ff(d,a,b,c,w[13],12,-40341101);c=ff(c,d,a,b,w[14],17,-1502002290);b=ff(b,c,d,a,w[15],22,1236535329);
      a=gg(a,b,c,d,w[1],5,-165796510);d=gg(d,a,b,c,w[6],9,-1069501632);c=gg(c,d,a,b,w[11],14,643717713);b=gg(b,c,d,a,w[0],20,-373897302);
      a=gg(a,b,c,d,w[5],5,-701558691);d=gg(d,a,b,c,w[10],9,38016083);c=gg(c,d,a,b,w[15],14,-660478335);b=gg(b,c,d,a,w[4],20,-405537848);
      a=gg(a,b,c,d,w[9],5,568446438);d=gg(d,a,b,c,w[14],9,-1019803690);c=gg(c,d,a,b,w[3],14,-187363961);b=gg(b,c,d,a,w[8],20,1163531501);
      a=gg(a,b,c,d,w[13],5,-1444681467);d=gg(d,a,b,c,w[2],9,-51403784);c=gg(c,d,a,b,w[7],14,1735328473);b=gg(b,c,d,a,w[12],20,-1926607734);
      a=hh(a,b,c,d,w[5],4,-378558);d=hh(d,a,b,c,w[8],11,-2022574463);c=hh(c,d,a,b,w[11],16,1839030562);b=hh(b,c,d,a,w[14],23,-35309556);
      a=hh(a,b,c,d,w[1],4,-1530992060);d=hh(d,a,b,c,w[4],11,1272893353);c=hh(c,d,a,b,w[7],16,-155497632);b=hh(b,c,d,a,w[10],23,-1094730640);
      a=hh(a,b,c,d,w[13],4,681279174);d=hh(d,a,b,c,w[0],11,-358537222);c=hh(c,d,a,b,w[3],16,-722521979);b=hh(b,c,d,a,w[6],23,76029189);
      a=hh(a,b,c,d,w[9],4,-640364487);d=hh(d,a,b,c,w[12],11,-421815835);c=hh(c,d,a,b,w[15],16,530742520);b=hh(b,c,d,a,w[2],23,-995338651);
      a=ii(a,b,c,d,w[0],6,-198630844);d=ii(d,a,b,c,w[7],10,1126891415);c=ii(c,d,a,b,w[14],15,-1416354905);b=ii(b,c,d,a,w[5],21,-57434055);
      a=ii(a,b,c,d,w[12],6,1700485571);d=ii(d,a,b,c,w[3],10,-1894986606);c=ii(c,d,a,b,w[10],15,-1051523);b=ii(b,c,d,a,w[1],21,-2054922799);
      a=ii(a,b,c,d,w[8],6,1873313359);d=ii(d,a,b,c,w[15],10,-30611744);c=ii(c,d,a,b,w[6],15,-1560198380);b=ii(b,c,d,a,w[13],21,1309151649);
      a=ii(a,b,c,d,w[4],6,-145523070);d=ii(d,a,b,c,w[11],10,-1120210379);c=ii(c,d,a,b,w[2],15,718787259);b=ii(b,c,d,a,w[9],21,-343485551);
      a=safeAdd(a,oa); b=safeAdd(b,ob); c=safeAdd(c,oc); d=safeAdd(d,od);
    }
    let hex = '';
    [a, b, c, d].forEach(n => { for (let i = 0; i < 4; i++) hex += ((n >> (i * 8)) & 0xff).toString(16).padStart(2, '0'); });
    return hex;
  }

  function lfmSign(params) {
    return lfmMd5(
      Object.keys(params).sort()
        .filter(k => k !== 'format')
        .map(k => k + params[k])
        .join('') + LASTFM_SECRET
    );
  }

  async function lfmPost(params) {
    if (!LASTFM_KEY || !LASTFM_SECRET) return null;
    params.api_key = LASTFM_KEY;
    params.api_sig  = lfmSign(params);
    params.format   = 'json';
    try {
      const res = await fetch(LASTFM_API, { method: 'POST', body: new URLSearchParams(params) });
      return res.json();
    } catch { return null; }
  }

  function lfmLoad() {
    try {
      const s = JSON.parse(localStorage.getItem('wcyt-lastfm') || 'null');
      if (s?.key) lastfmSession = s;
    } catch {}
  }

  function lfmConnect() {
    if (!LASTFM_KEY) return;
    if (lastfmSession) {
      lastfmSession = null;
      localStorage.removeItem('wcyt-lastfm');
      renderSticky();
      return;
    }
    const cb = encodeURIComponent(location.href.split('?')[0] + '?lfmcb=1');
    const popup = window.open(
      `https://www.last.fm/api/auth/?api_key=${LASTFM_KEY}&cb=${cb}`,
      'lfm-auth', 'width=800,height=600,left=200,top=100'
    );
    window.addEventListener('message', function h(e) {
      if (e.data?.type !== 'wcyt-lastfm') return;
      window.removeEventListener('message', h);
      lastfmSession = e.data.session;
      localStorage.setItem('wcyt-lastfm', JSON.stringify(lastfmSession));
      renderSticky();
    });
  }

  async function lfmHandleCallback() {
    const p     = new URLSearchParams(location.search);
    const token = p.get('token');
    if (!p.get('lfmcb') || !token || !window.opener) return;
    const data = await lfmPost({ method: 'auth.getSession', token });
    if (data?.session) {
      window.opener.postMessage(
        { type: 'wcyt-lastfm', session: { key: data.session.key, name: data.session.name } },
        '*'
      );
    }
    window.close();
  }

  async function lfmNowPlaying(artist, title) {
    if (!lastfmSession || !artist) return;
    await lfmPost({ method: 'track.updateNowPlaying', sk: lastfmSession.key, artist, track: title });
  }

  async function lfmScrobbleTrack(artist, title, startedAt) {
    if (!lastfmSession || !artist) return;
    await lfmPost({
      method:    'track.scrobble',
      sk:        lastfmSession.key,
      artist,
      track:     title,
      timestamp: String(Math.floor(startedAt / 1000)),
    });
  }

  function lfmOnSongStart(artist, title) {
    if (!lastfmSession || !LASTFM_KEY) return;
    lfmCurrent    = { artist, title, startedAt: Date.now() };
    lfmListenMs   = 0;
    lfmListenTick = (audioState === 'playing') ? Date.now() : null;
    lfmNowPlaying(artist, title);
  }

  function lfmOnSongEnd() {
    if (!lfmCurrent || !lastfmSession || !LASTFM_KEY) return;
    const extra = lfmListenTick ? Date.now() - lfmListenTick : 0;
    if (lfmListenMs + extra >= 30_000) {
      lfmScrobbleTrack(lfmCurrent.artist, lfmCurrent.title, lfmCurrent.startedAt);
    }
    lfmCurrent = null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function parseTitle(raw) {
    if (!raw || !raw.trim()) return { artist: '', title: 'On Air' };
    const idx = raw.indexOf(' - ');
    if (idx === -1) return { artist: '', title: raw.trim() };
    return {
      artist: raw.slice(0, idx).trim(),
      title:  raw.slice(idx + 3).trim(),
    };
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function relativeTime(date) {
    const secs = Math.floor((Date.now() - date) / 1000);
    if (secs < 60)  return 'just started';
    if (secs < 120) return '1 min ago';
    return Math.floor(secs / 60) + ' min ago';
  }

  function artCacheKey(artist, title) {
    return (artist + '|' + title).toLowerCase();
  }

  function isBlocked(raw, parsed) {
    const haystack = [
      (raw   ?? '').toLowerCase(),
      (parsed.artist ?? '').toLowerCase(),
      (parsed.title  ?? '').toLowerCase(),
    ].join(' ');
    return BLOCKED_TERMS.some(term => haystack.includes(term));
  }

  // ── Manual art overrides ──────────────────────────────────────────────────
  // For artists whose music isn't on iTunes (e.g. Bandcamp-only releases).
  // Key: normalized artist name (lowercase, no punctuation). Value: image URL.
  const ART_OVERRIDES = {
    'cindylee': 'https://f4.bcbits.com/img/a1091823768_10.jpg',
  };

  function artOverride(artist) {
    const key = normArtist(artist);
    return ART_OVERRIDES[key] ?? null;
  }

  // ── Album art (iTunes Search API only) ───────────────────────────────────
  // iTunes serves the actual cover art regardless of content, so we maintain
  // a manual blocklist of albums with known explicit/NSFW artwork.
  // When a song matches a blocked album, art returns null (shows logo fallback).
  // Format: ['artist normalized', 'album normalized'] — both lowercased, no punctuation.
  const BLOCKED_ART = [
    // Nudity
    ['pixies',                    'surfer rosa'],
    ['janes addiction',           'nothings shocking'],
    ['janes addiction',           'ritual de lo habitual'],
    ['nirvana',                   'nevermind'],
    ['nirvana',                   'in utero'],
    ['red hot chili peppers',     'mothers milk'],
    ['red hot chili peppers',     'by the way'],
    ['blind faith',               'blind faith'],
    ['the slits',                 'cut'],
    ['pulp',                      'this is hardcore'],
    ['sky ferreira',              'night time my time'],
    ['lorde',                     'solar power'],
    ['biffy clyro',               'the vertigo of bliss'],
    ['marilyn manson',            'mechanical animals'],
    ['the strokes',               'is this it'],
    ['the black crowes',          'amorica'],
    ['bow wow wow',               'see jungle see jungle go join your gang yeah city all over go ape crazy'],
    ['roxy music',                'country life'],
    ['roger waters',              'the pros and cons of hitch hiking'],
    // Additional blocked covers
    ['lucius',                    'wildewoman'],
    ['methyl ethel',              'everything is forgotten'],
    ['of montreal',               'skeletal lamping'],
    ['of montreal',               'innocence reaches'],
    ['pulp',                      'this'],
    ['sigur ros',                 'med sud i eyrum vid spilum endalaust'],
    ['sufjan stevens',            'a beginners mind'],
    ['the damned',                ''],
    ['the drums',                 'jonny'],
    ['tv girl',                   'death of a party girl'],
    ['avalon emerson',            'perpetual emotion machine'],
    ['arctic monkeys',            'help'],
    // Graphic / violent / sexual
    ['death grips',               'no love deep web'],
    ['guns n roses',              'appetite for destruction'],
    ['tool',                      'undertow'],
    ['dead kennedys',             'frankenchrist'],
    ['nofx',                      'heavy petting zoo'],
    ['chumbawamba',               'anarchy'],
    ['pantera',                   'far beyond driven'],
    ['slayer',                    'christ illusion'],
    ['ween',                      'chocolate cheese'],
	['the strokes',				  'is this it'],
	['suki waterhour',			  'good looking'],
  ];

  function artIsBlocked(artist, album) {
    const norm = s => stripDiacritics(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const a = norm(artist);
    const b = norm(album);
    return BLOCKED_ART.some(([ba, bb]) => a.includes(ba) && b.includes(bb));
  }

  // Album types that are never the original release — hard reject
  const ITUNES_REJECT = [
    'lullaby', 'karaoke', 'tribute', 'cover version', 'covers',
    'instrumental version', 'made famous', 'originally performed',
    // Workout / fitness compilations
    'running', 'workout', 'fitness', 'gym', 'cardio', 'yoga', 'meditation',
    // Generic filler compilations
    "now that's what i call", 'hits of', 'music of', 'sounds of', 'songs of',
    'lounge', 'chillout', 'chill out',
  ];
  // Secondary releases — prefer originals over these, but fall back if nothing else
  const ITUNES_SECONDARY = [
    'soundtrack', 'motion picture', 'original score', 'compilation',
    'greatest hits', 'best of', 'collection', 'anthology',
    'the very best', 'essential', 'platinum', 'gold', 'singles',
    'retrospective', 'kompilation',
  ];

  // Strip accents/diacritics so "Björk" → "Bjork" for search/matching
  function stripDiacritics(s) {
    return (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function normArtist(s) {
    return stripDiacritics(s ?? '').toLowerCase()
      .replace(/\s*&\s*/g, 'and')
      .replace(/[^a-z0-9]/g, '');
  }

  async function fetchArtFromiTunes(artist, title, albumLine) {
    const na = normArtist(artist);
    const nt = stripDiacritics(title).toLowerCase();

    // Parse album name and year from BSI album line (e.g. "Weezer • 1994")
    const albumMatch = (albumLine ?? '').match(/^(.+?)\s*[•·]\s*(\d{4})\s*$/);
    const albumName  = albumMatch ? albumMatch[1].trim() : (albumLine ?? '').trim();
    const albumYear  = albumMatch ? albumMatch[2] : '';

    const isSecondary = r => { const col = (r.collectionName ?? '').toLowerCase(); return ITUNES_SECONDARY.some(t => col.includes(t)); };

    const filterCandidates = results => (results ?? []).filter(r => {
      if (!normArtist(r.artistName).includes(na)) return false;
      const col = (r.collectionName ?? '').toLowerCase();
      if (ITUNES_REJECT.some(t => col.includes(t))) return false;
      if (artIsBlocked(r.artistName, r.collectionName ?? '')) {
        console.log('[WCYTPlaylist] art blocked:', r.artistName, '/', r.collectionName);
        return false;
      }
      console.log('[WCYTPlaylist] art candidate:', r.artistName, '/', r.collectionName, r.artworkUrl100);
      return true;
    });

    const pickMatch = candidates => {
      // 1. Album name + year match (disambiguates self-titled albums e.g. Weezer)
      if (albumName && albumYear) {
        const na_album = normArtist(albumName);
        const byBoth = candidates.find(r => {
          const rc = normArtist(r.collectionName ?? '');
          const ry = (r.releaseDate ?? '').slice(0, 4);
          return (rc.includes(na_album) || na_album.includes(rc)) && ry === albumYear;
        });
        if (byBoth) return byBoth;
      }
      // 2. Album name match only
      if (albumName) {
        const na_album = normArtist(albumName);
        const byAlbum = candidates.find(r => {
          const rc = normArtist(r.collectionName ?? '');
          return rc.includes(na_album) || na_album.includes(rc);
        });
        if (byAlbum) return byAlbum;
      }
      // 3. Non-secondary first, then secondary
      return candidates.find(r => !isSecondary(r)) ?? candidates.find(r => isSecondary(r));
    };

    const toArtUrl = match => match?.artworkUrl100
      ? match.artworkUrl100.replace('100x100bb', '500x500bb')
      : null;

    // First try: combined artist + title search
    const term1 = encodeURIComponent(`${stripDiacritics(artist)} ${stripDiacritics(title)}`);
    const res1  = await fetch(`https://itunes.apple.com/search?term=${term1}&entity=song&limit=10&country=US`);
    const data1 = await res1.json();
    const match1 = pickMatch(filterCandidates(data1.results));
    if (match1) return toArtUrl(match1);

    // Fallback: artist-only search, then match title
    const term2 = encodeURIComponent(stripDiacritics(artist));
    const res2  = await fetch(`https://itunes.apple.com/search?term=${term2}&entity=song&limit=50&country=US`);
    const data2 = await res2.json();
    const byTitle = filterCandidates(data2.results).filter(r =>
      stripDiacritics(r.trackName ?? '').toLowerCase() === nt
    );
    return toArtUrl(pickMatch(byTitle));
  }

  async function fetchArtMusicBrainz(artist, title) {
    try {
      const q   = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
      const res = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${q}&limit=5&fmt=json&inc=release-groups`, {
        headers: { 'User-Agent': 'WCYTDisplay/1.0 (dunnand@gmail.com)' }
      });
      const data = await res.json();
      const rgidsSeen = new Set();
      for (const rec of (data.recordings ?? [])) {
        for (const rel of (rec.releases ?? [])) {
          const rgid = rel['release-group']?.id;
          if (!rgid || rgidsSeen.has(rgid)) continue;
          rgidsSeen.add(rgid);
          const url  = `https://coverartarchive.org/release-group/${rgid}/front-500.jpg`;
          const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
          if (head.ok) return url;
        }
      }
    } catch {}
    return null;
  }

  async function fetchArt(artist, title, albumLine = '') {
    const key = artCacheKey(artist, title);
    if (key in artCache) return artCache[key];
    const override = artOverride(artist);
    if (override) { artCache[key] = override; saveArtCache(); return override; }
    artCache[key] = null; // in-memory null so we don't double-fetch this session
    try {
      artCache[key] = await fetchArtFromiTunes(artist, title, albumLine);
    } catch {
      // iTunes down — show logo fallback, don't try MusicBrainz
    }
    if (artCache[key]) saveArtCache(); // only persist successes
    return artCache[key];
  }

  // ── Current show (Google Sheet) ───────────────────────────────────────────

  function parseCSVRow(row) {
    const out = [];
    let cur = '', inQ = false;
    for (const ch of row) {
      if (ch === '"')       { inQ = !inQ; }
      else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else                  { cur += ch; }
    }
    out.push(cur);
    return out;
  }

  function isStation2(stationVal) {
    const v = (stationVal ?? '').trim().toLowerCase();
    return v === '2' || v === '2.0' || v.includes('next level') || v.includes('2.0');
  }

  function applyShowEntry(tsRaw, stationVal, showName, imageUrl) {
    const CLEAR_WORDS = ['clear', 'end', 'done', 'off'];
    const isClear     = !showName || CLEAR_WORDS.includes(showName.toLowerCase());
    const submittedAt = new Date(tsRaw);
    const expiresAt   = new Date(submittedAt.getTime() + SHOW_TTL_MS);
    const entry       = (!isClear && Date.now() < expiresAt.getTime())
      ? { name: showName, expiresAt, imageUrl: imageUrl || null }
      : null;

    if (isStation2(stationVal)) {
      currentShow2 = entry;
    } else {
      currentShowWCYT = entry;
    }
  }

  async function fetchCurrentShow() {
    try {
      // Append timestamp to bust Google's server-side CSV cache
      const res  = await fetch(SHOW_URL + '&_t=' + Date.now(), { cache: 'no-store' });
      const text = await res.text();
      const lines = text.trim().split('\n').filter(Boolean);

      if (lines.length < 2) { currentShowWCYT = null; currentShow2 = null; render(); return; }

      // Columns: timestamp(0), email(1), station(2), show/dj name(3)
      const headers     = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());
      const stationCol  = headers.findIndex(h => h.includes('station'));
      const resolvedStn = stationCol !== -1 ? stationCol : 2;

      // Find show column — prefer 'show' or 'dj' keyword first to avoid
      // colliding with 'station name' or other columns that contain 'name'
      const byShowDj = headers.findIndex((h, i) => i !== resolvedStn && (h.includes('show') || h.includes('dj')));
      const byName   = headers.findIndex((h, i) => i !== resolvedStn && h.includes('name'));
      const resolvedShw = byShowDj !== -1 ? byShowDj
                        : byName   !== -1 ? byName
                        : resolvedStn + 1;
      const imageCol = headers.findIndex(h => h.includes('image') || h.includes('photo') || h.includes('pic'));

      console.log('[WCYTPlaylist] Show sheet headers:', headers);
      console.log('[WCYTPlaylist] stationCol:', resolvedStn, '| showCol:', resolvedShw);

      // Reset both stations, then replay all non-expired entries (last entry per station wins)
      currentShowWCYT = null;
      currentShow2    = null;

      for (let i = 1; i < lines.length; i++) {
        const cols      = parseCSVRow(lines[i]);
        const tsRaw     = (cols[0]              ?? '').trim();
        const stationV  = (cols[resolvedStn]    ?? '').trim();
        const showName  = (cols[resolvedShw]    ?? '').trim();
        const imageUrl  = imageCol !== -1 ? (cols[imageCol] ?? '').trim() : '';
        applyShowEntry(tsRaw, stationV, showName, imageUrl);
      }

      render();
    } catch (err) { console.warn('[WCYTPlaylist] fetchCurrentShow error:', err); }
  }

  // ── Fetch album/year from BSI output file ────────────────────────────────

  async function fetchBSIData(url) {
    try {
      const res    = await fetch(RAW_BASE + url + '?t=' + Date.now(), { cache: 'no-store' });
      const html   = await res.text();
      const doc    = new DOMParser().parseFromString(html, 'text/html');
      const albumLine = doc.querySelector('.album')?.textContent.trim() || '';
      const bsiTitle  = doc.querySelector('.title')?.textContent.trim()  || '';
      const blocks = doc.querySelectorAll('.sidebar-content');
      const lines  = (blocks[1]?.innerHTML || '').split(/<br\s*\/?>/i);
      const all = [];
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        if (BLOCKED_TERMS.some(b => text.toLowerCase().includes(b))) continue;
        const m = text.match(/^(\d+:\d+\s*[ap]m)\s*-\s*(.+?)\s*-\s*(.+?)(?:\s*\(\d{4}\))?\s*$/i);
        if (!m) continue;
        all.push({ time: m[1], artist: m[2].trim(), title: m[3].trim() });
      }
      // BSI lists oldest first — reverse so most recent is at top
      const recent = all.reverse().slice(0, 3);
      return { albumLine, bsiTitle, recent };
    } catch { return { albumLine: '', bsiTitle: '', recent: [] }; }
  }

  // ── Fetch stream metadata ─────────────────────────────────────────────────

  async function fetchNowPlaying() {
    try {
      const res = await fetch(METADATA_URL, { cache: 'no-store' });
      const buf = await res.arrayBuffer();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { text = new TextDecoder('latin1').decode(buf); }

      let data;
      try { data = JSON.parse(text); }
      catch (parseErr) {
        console.warn('[WCYTPlaylist] JSON parse failed. Raw response (first 500 chars):', text?.slice(0, 500));
        return; // skip poll, keep current display
      }

      let sources = data?.icestats?.source ?? [];
      if (!Array.isArray(sources)) sources = [sources];

      const findSource = mount =>
        sources.find(s => (s.listenurl ?? '').toLowerCase().includes(mount.toLowerCase()));

      // Fetch BSI data (album/year + recently played) for both stations
      const [bsi1, bsi2] = await Promise.all([
        fetchBSIData(BSI_FILES[0]),
        fetchBSIData(BSI_FILES[1]),
      ]);
      bsiRecent1 = bsi1.recent;
      bsiRecent2 = bsi2.recent;
      // Prefetch art for recent items into cache so next render has them
      [...bsiRecent1, ...bsiRecent2].forEach(s => fetchArt(s.artist, s.title));

      // Station 1 — WCYT (drives history + full playlist page)
      const rawTitle1 = findSource(STATIONS[0].mount)?.title ?? null;
      console.log('[WCYTPlaylist] raw title WCYT:', rawTitle1);
      const parsed1tmp  = parseTitle(rawTitle1);
      const bsiMatch1   = bsi1.bsiTitle && bsi1.bsiTitle.trim().toLowerCase() === parsed1tmp.title.trim().toLowerCase();
      const album1      = bsiMatch1 ? bsi1.albumLine : '';
      handleNewTitle(rawTitle1, album1);

      // Station 2 — track current song + history
      const raw2    = findSource(STATIONS[1].mount)?.title ?? null;
      const parsed2 = parseTitle(raw2);
      const bsiMatch2 = bsi2.bsiTitle && bsi2.bsiTitle.trim().toLowerCase() === parsed2.title.trim().toLowerCase();
      const album2    = bsiMatch2 ? bsi2.albumLine : '';
      if (!isBlocked(raw2, parsed2) && (parsed2.artist || parsed2.title !== 'On Air')) {
        const key2 = artCacheKey(parsed2.artist, parsed2.title);
        const cur2  = currentSong2 ? artCacheKey(currentSong2.artist, currentSong2.title) : null;
        if (key2 !== cur2) {
          if (currentSong2) {
            if (activeStation === 1) lfmOnSongEnd();
            songHistory2.unshift({ ...currentSong2, endedAt: new Date() });
            if (songHistory2.length > MAX_HISTORY) songHistory2.pop();
          }
          const artUrl = parsed2.artist ? await fetchArt(parsed2.artist, parsed2.title, album2) : null;
          currentSong2 = { ...parsed2, startedAt: new Date(), artUrl, albumLine: album2 };
          if (activeStation === 1) lfmOnSongStart(parsed2.artist, parsed2.title);
          if (activeStation === 1) render();
        } else if (currentSong2 && album2 && currentSong2.albumLine !== album2) {
          currentSong2.albumLine = album2;
          if (activeStation === 1) render();
        }
      } else {
        currentSong2 = null;
        if (activeStation === 1) render();
      }
    } catch (err) {
      if (!corsWarned) {
        corsWarned = true;
        console.warn(
          '[WCYTPlaylist] Could not fetch metadata.\n' +
          'If this is a CORS error, set up a proxy and update METADATA_URL in playlist-widget.js.\n' +
          'Error:', err.message
        );
      }
      setErrorState();
    }
  }

  async function handleNewTitle(raw, albumLine = '') {
    const parsed = parseTitle(raw);

    if (isBlocked(raw, parsed)) return;

    if (!currentSong) {
      const artUrl = parsed.artist ? await fetchArt(parsed.artist, parsed.title, albumLine) : null;
      currentSong = { ...parsed, startedAt: new Date(), artUrl, albumLine };
      if (activeStation === 0) lfmOnSongStart(parsed.artist, parsed.title);
      render();
      return;
    }

    const currentKey = artCacheKey(currentSong.artist, currentSong.title);
    const newKey     = artCacheKey(parsed.artist, parsed.title);
    if (newKey === currentKey) {
      // Same song — update album line if BSI just refreshed
      if (albumLine && currentSong.albumLine !== albumLine) {
        currentSong.albumLine = albumLine;
        if (activeStation === 0) render();
      }
      return;
    }

    if (activeStation === 0) lfmOnSongEnd();
    songHistory.unshift({ ...currentSong, endedAt: new Date() });
    if (songHistory.length > MAX_HISTORY) songHistory.pop();

    // Clear immediately, render blank while art loads
    currentSong = { ...parsed, startedAt: new Date(), artUrl: null, albumLine: '' };
    if (activeStation === 0) render();

    const artUrl = parsed.artist ? await fetchArt(parsed.artist, parsed.title, albumLine) : null;
    currentSong = { ...parsed, startedAt: new Date(), artUrl, albumLine };
    if (activeStation === 0) lfmOnSongStart(parsed.artist, parsed.title);
    render();
  }

  // ── Shared elements ───────────────────────────────────────────────────────

  function backdropDiv(artUrl) {
    if (!artUrl) return '';
    return `<div class="wcyt-backdrop" style="background-image:url('${esc(artUrl)}')"></div>`;
  }

  function artImg(artUrl, size, cssClass) {
    const src        = artUrl || FALLBACK_ART;
    const isFallback = !artUrl;
    return `<img
      class="${cssClass}${isFallback ? ' wcyt-art-fallback' : ''}"
      src="${esc(src)}"
      width="${size}" height="${size}"
      alt="Album art"
      loading="lazy"
      onerror="this.src='${FALLBACK_ART}';this.classList.add('wcyt-art-fallback')"
    >`;
  }

  // ── Render: Hero ──────────────────────────────────────────────────────────

  function stationSwitcher() {
    return `
      <div class="wcyt-station-switcher" role="group" aria-label="Select station">
        ${STATIONS.map((s, i) => `
          <button
            class="wcyt-station-btn${i === activeStation ? ' wcyt-station-btn--active' : ''}"
            onclick="WCYTPlaylist.switchStation(${i})"
            aria-pressed="${i === activeStation}"
          >${i === activeStation ? `<span class="wcyt-bars" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>` : ''}${esc(s.label)}</button>
        `).join('')}
      </div>
    `;
  }

  function renderHero() {
    if (!heroEl) return;

    const song       = currentSong;
    const history    = songHistory.slice(0, 3);
    const station    = STATIONS[activeStation];
    const isWCYT     = activeStation === 0;
    const currentShow = isWCYT ? currentShowWCYT : currentShow2;
    const djP        = getDJPanel(activeStation);  // real-time DJ panel data (takes priority)

    // DJ panel state
    const showArt  = djP?.imageUrl || currentShow?.imageUrl || null;
    const showName = djP?.showName || currentShow?.name     || null;
    const songObj  = isWCYT ? song : currentSong2;

    // Manual override clears when a new song starts after it was set.
    // Show image stays up the whole time the DJ is active, and only gives
    // way to song art once the override expires (new song detected).
    const manualSetAt     = djP?.manualSetAt ? new Date(djP.manualSetAt) : null;
    const manualStale     = manualSetAt && songObj?.startedAt > manualSetAt;
    const overridesActive = !manualStale;
    const showDJImage     = djP && !manualStale;

    const dispArt    = (showDJImage && showArt)
                     ? showArt
                     : (songObj?.artUrl || showArt || null);
    const dispArtist = (djP?.manualArtist && overridesActive) ? djP.manualArtist
                     : (songObj?.artist || null);
    const dispTitle  = (djP?.manualTitle  && overridesActive) ? djP.manualTitle
                     : (songObj?.title   || null);

    heroEl.innerHTML = `
      <div class="wcyt-hero">
        ${dispArt ? backdropDiv(dispArt) : ''}
        <div class="wcyt-hero-inner">

          ${stationSwitcher()}

          ${showName ? `
            <div class="wcyt-hero-show">
              <span class="wcyt-hero-show-dot"></span>
              <span class="wcyt-hero-show-label">NOW ON AIR</span>
              <span class="wcyt-hero-show-name">${esc(showName)}</span>
            </div>
          ` : ''}

          ${isWCYT ? `
            ${(song || djP) ? `
              ${artImg(dispArt, 220, 'wcyt-hero-art')}
              <div class="wcyt-hero-artist">${esc(dispArtist || 'WCYT')}</div>
              <div class="wcyt-hero-title">${esc(dispTitle || 'On Air')}</div>
              ${(songObj?.albumLine && !djP?.manualTitle) ? `<div class="wcyt-hero-album">${esc(songObj.albumLine)}</div>` : ''}
              <div class="wcyt-hero-controls">
                ${(!djP?.onBreak && !djP?.manualTitle && song) ? `
                  <span class="wcyt-age wcyt-hero-age" data-started="${song.startedAt.toISOString()}">
                    ${relativeTime(song.startedAt)}
                  </span>
                ` : ''}
                ${playBtnHTML('lg')}
                <a href="${activeStation === 1 ? '/playlist?s=2' : '/playlist'}" class="wcyt-hero-playlist-link">Full playlist &rarr;</a>
              </div>
            ` : `<div class="wcyt-hero-loading">Loading&hellip;</div>`}

            ${bsiRecent1.length ? `
              <div class="wcyt-hero-recent">
                <div class="wcyt-hero-recent-label">RECENTLY PLAYED</div>
                <ul class="wcyt-hero-recent-list">
                  ${bsiRecent1.map(s => `
                    <li>
                      ${artImg(artCache[artCacheKey(s.artist, s.title)] || null, 96, 'wcyt-hero-recent-art')}
                      <span class="wcyt-hero-recent-track">
                        <span class="wcyt-hero-recent-artist">${esc(s.artist)}</span>
                        <span class="wcyt-hero-recent-sep">&middot;</span>
                        <span class="wcyt-hero-recent-title">${esc(s.title)}</span>
                      </span>
                      <span class="wcyt-hero-recent-time">${esc(s.time)}</span>
                    </li>
                  `).join('')}
                </ul>
              </div>
            ` : ''}
          ` : `
            <div class="wcyt-hero-s2">
              ${(currentSong2 || djP) ? `
                ${artImg(dispArt || FALLBACK_ART_2, 180, 'wcyt-hero-art')}
                <div class="wcyt-hero-artist">${esc(dispArtist || '2.0')}</div>
                <div class="wcyt-hero-title">${esc(dispTitle || 'On Air')}</div>
              ` : `<img src="${FALLBACK_ART_2}" class="wcyt-hero-art" width="180" height="180" alt="2.0 Next Level of Radio">`}
                <div class="wcyt-hero-controls">
                <span class="wcyt-age wcyt-hero-age"
                  ${currentSong2 && !djP?.manualTitle ? `data-started="${currentSong2.startedAt.toISOString()}"` : ''}>
                  ${(currentSong2 && !djP?.manualTitle) ? relativeTime(currentSong2.startedAt) : 'Live now'}
                </span>
                ${playBtnHTML('lg')}
                <a href="/playlist?s=2" class="wcyt-hero-playlist-link">Full playlist &rarr;</a>
              </div>
            </div>

            ${bsiRecent2.length ? `
              <div class="wcyt-hero-recent">
                <div class="wcyt-hero-recent-label">RECENTLY PLAYED</div>
                <ul class="wcyt-hero-recent-list">
                  ${bsiRecent2.map(s => `
                    <li>
                      ${artImg(artCache[artCacheKey(s.artist, s.title)] || null, 96, 'wcyt-hero-recent-art')}
                      <span class="wcyt-hero-recent-track">
                        <span class="wcyt-hero-recent-artist">${esc(s.artist)}</span>
                        <span class="wcyt-hero-recent-sep">&middot;</span>
                        <span class="wcyt-hero-recent-title">${esc(s.title)}</span>
                      </span>
                      <span class="wcyt-hero-recent-time">${esc(s.time)}</span>
                    </li>
                  `).join('')}
                </ul>
              </div>
            ` : ''}
          `}

        </div>

        <a class="wcyt-hero-scroll" href="#wcyt-page-content" aria-label="Scroll down">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </a>
      </div>
    `;

    updateBarsAnimation();
  }

  // ── Render: Compact ───────────────────────────────────────────────────────

  function renderCompact() {
    if (!compactEl) return;

    const song    = currentSong;
    const history = songHistory.slice(0, 5);
    const compactShowArt = currentShowWCYT?.imageUrl || null;

    compactEl.innerHTML = `
      <div class="wcyt-compact">
        <div class="wcyt-compact-now">
          ${song ? backdropDiv(compactShowArt || song.artUrl) : ''}
          <div class="wcyt-compact-header">
            <span class="wcyt-label">NOW PLAYING</span>
            <span class="wcyt-bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
          </div>
          ${song ? `
            <div class="wcyt-compact-song">
              ${artImg(compactShowArt || song.artUrl, 140, 'wcyt-compact-art')}
              <div class="wcyt-compact-song-text">
                <div class="wcyt-artist">${esc(song.artist || 'WCYT')}</div>
                <div class="wcyt-title">${esc(song.title)}</div>
                <div class="wcyt-age" data-started="${song.startedAt.toISOString()}">
                  ${relativeTime(song.startedAt)}
                </div>
              </div>
              ${playBtnHTML()}
            </div>
          ` : `<div class="wcyt-loading">Loading&hellip;</div>`}
        </div>
        ${history.length ? `
          <div class="wcyt-compact-history">
            <div class="wcyt-section-label">RECENT PLAYS</div>
            <ul class="wcyt-history-list">
              ${history.map(s => `
                <li>
                  ${artImg(s.artUrl, 36, 'wcyt-history-art')}
                  <span class="wcyt-history-time">${formatTime(s.startedAt)}</span>
                  <span class="wcyt-history-track">
                    <span class="wcyt-history-artist">${esc(s.artist || 'WCYT')}</span>
                    ${s.artist ? ' &middot; ' : ''}
                    <span class="wcyt-history-title">${esc(s.title)}</span>
                  </span>
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}
        <div class="wcyt-compact-footer">
          <a href="${activeStation === 1 ? '/playlist?s=2' : '/playlist'}" class="wcyt-full-link">Full playlist &rarr;</a>
        </div>
      </div>
    `;

    updateBarsAnimation();
  }

  // ── Render: Full ──────────────────────────────────────────────────────────

  function renderFull() {
    if (!fullEl) return;

    const song    = activeStation === 1 ? currentSong2  : currentSong;
    const history = activeStation === 1 ? songHistory2  : songHistory;
    const fullShow    = activeStation === 1 ? currentShow2 : currentShowWCYT;
    const fullShowArt = fullShow?.imageUrl || null;

    fullEl.innerHTML = `
      <div class="wcyt-full">
        <div class="wcyt-full-now-card">
          ${song ? backdropDiv(fullShowArt || song.artUrl) : ''}
          <div class="wcyt-full-card-header">
            <span class="wcyt-label">NOW PLAYING</span>
            <span class="wcyt-bars wcyt-bars--lg" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
          </div>
          ${song ? `
            <div class="wcyt-full-song">
              ${artImg(fullShowArt || song.artUrl, 340, 'wcyt-full-art')}
              <div class="wcyt-full-song-text">
                <div class="wcyt-full-artist">${esc(song.artist || 'WCYT')}</div>
                <div class="wcyt-full-title">${esc(song.title)}</div>
                ${song.albumLine ? `<div class="wcyt-full-album">${esc(song.albumLine)}</div>` : ''}
                <div class="wcyt-full-meta">
                  <span class="wcyt-age" data-started="${song.startedAt.toISOString()}">
                    Started ${relativeTime(song.startedAt)}
                  </span>
                  ${playBtnHTML()}
                </div>
              </div>
            </div>
          ` : `<div class="wcyt-loading">Loading&hellip;</div>`}
        </div>

      </div>
    `;

    updateBarsAnimation();
  }

  // ── Error state ───────────────────────────────────────────────────────────

  function setErrorState() {
    const msg = `
      <div class="wcyt-error">
        <span>&#9888;</span> Metadata unavailable &mdash;
        <a href="${STREAM_URL}" target="_blank" rel="noopener">listen live</a>
      </div>
    `;
    if (heroEl    && !currentSong) heroEl.innerHTML    = msg;
    if (compactEl && !currentSong) compactEl.innerHTML = msg;
    if (fullEl    && !currentSong) fullEl.innerHTML    = msg;
  }

  // ── Relative time ticker ──────────────────────────────────────────────────

  function tickAges() {
    document.querySelectorAll('.wcyt-age[data-started]').forEach(el => {
      const d = new Date(el.dataset.started);
      const isHero = el.classList.contains('wcyt-hero-age');
      const isFull = el.closest('.wcyt-full-song');
      el.textContent = (isHero || isFull)
        ? 'Started ' + relativeTime(d)
        : relativeTime(d);
    });
  }

  // ── Sticky player ─────────────────────────────────────────────────────────

  const STICKY_CSS = `
    #wcyt-sticky{position:fixed;bottom:0;left:0;right:0;z-index:9999;
      background:#111;border-top:1px solid rgba(255,255,255,.12);
      display:flex;align-items:center;padding:0 12px 0 10px;height:68px;gap:10px;
      transform:translateY(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);
      box-shadow:0 -4px 32px rgba(0,0,0,.6);}
    #wcyt-sticky.wcyt-sticky--show{transform:translateY(0);}
    #wcyt-sticky-art{width:46px;height:46px;border-radius:5px;object-fit:cover;
      background:#333;flex-shrink:0;}
    #wcyt-sticky-info{flex:1;min-width:0;overflow:hidden;}
    #wcyt-sticky-station{font-size:10px;font-weight:700;letter-spacing:.1em;
      text-transform:uppercase;color:#c8102e;margin-bottom:2px;}
    #wcyt-sticky-title{font-size:13px;font-weight:600;color:#fff;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #wcyt-sticky-artist{font-size:12px;color:#999;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #wcyt-sticky-show{font-size:10px;color:#c8102e;font-weight:600;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      letter-spacing:.04em;margin-top:1px;}
    #wcyt-sticky-controls{display:flex;align-items:center;gap:8px;flex-shrink:0;}
    .wcyt-sticky-stn{display:flex;gap:4px;}
    .wcyt-sticky-stn-btn{font-size:10px;font-weight:700;letter-spacing:.05em;
      padding:3px 8px;border-radius:12px;border:1px solid #444;
      background:transparent;color:#aaa;cursor:pointer;white-space:nowrap;}
    .wcyt-sticky-stn-btn--on{border-color:#c8102e;color:#fff;background:rgba(200,16,46,.18);}
    .wcyt-sticky-play{width:38px;height:38px;border-radius:50%;background:#c8102e;
      border:none;color:#fff;font-size:13px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .wcyt-sticky-play:hover{background:#a50d25;}
    .wcyt-sticky-close{background:none;border:none;color:#555;font-size:18px;
      cursor:pointer;padding:4px;line-height:1;flex-shrink:0;}
    .wcyt-sticky-close:hover{color:#fff;}
    .wcyt-sticky-lfm{background:none;border:none;cursor:pointer;padding:4px;
      color:#555;font-size:10px;font-weight:700;letter-spacing:.06em;
      line-height:1;flex-shrink:0;border-radius:4px;transition:color .2s;}
    .wcyt-sticky-lfm:hover{color:#d51007;}
    .wcyt-sticky-lfm--on{color:#d51007 !important;}
  `;

  function initStickyPlayer() {
    const style = document.createElement('style');
    style.textContent = STICKY_CSS;
    document.head.appendChild(style);

    stickyEl = document.createElement('div');
    stickyEl.id = 'wcyt-sticky';
    document.body.appendChild(stickyEl);

    // Restore session state
    try {
      const saved = JSON.parse(sessionStorage.getItem('wcyt-player') || 'null');
      if (saved) {
        activeStation     = saved.station ?? 0;
        pendingAutoResume = !!saved.playing;
        if (saved.showWCYT) {
          const exp = new Date(saved.showWCYT.expiresAt);
          if (Date.now() < exp.getTime()) currentShowWCYT = { name: saved.showWCYT.name, expiresAt: exp };
        }
        if (saved.show2) {
          const exp = new Date(saved.show2.expiresAt);
          if (Date.now() < exp.getTime()) currentShow2 = { name: saved.show2.name, expiresAt: exp };
        }
      }
    } catch {}

    window.addEventListener('beforeunload', savePlayerState);
  }

  function renderSticky() {
    if (!stickyEl) return;
    const song        = activeStation === 0 ? currentSong : currentSong2;
    const station     = STATIONS[activeStation];
    const isPlaying   = audioState === 'playing' || audioState === 'buffering';
    const currentShow = activeStation === 0 ? currentShowWCYT : currentShow2;

    if ((song || isPlaying) && !stickyVisible) {
      stickyVisible = true;
      stickyEl.classList.add('wcyt-sticky--show');
    }

    stickyEl.innerHTML = `
      <img id="wcyt-sticky-art"
        src="${esc(song?.artUrl || FALLBACK_ART)}"
        onerror="this.src='${FALLBACK_ART}'"
        alt="Album art">
      <div id="wcyt-sticky-info">
        <div id="wcyt-sticky-station">${esc(station.short)}</div>
        <div id="wcyt-sticky-title">${esc(song?.title || 'Live Radio')}</div>
        <div id="wcyt-sticky-artist">${esc(song?.artist || station.name)}</div>
        ${currentShow ? `<div id="wcyt-sticky-show">ON AIR: ${esc(currentShow.name)}</div>` : ''}
      </div>
      <div id="wcyt-sticky-controls">
        <div class="wcyt-sticky-stn">
          ${STATIONS.map((s, i) => `
            <button class="wcyt-sticky-stn-btn${i === activeStation ? ' wcyt-sticky-stn-btn--on' : ''}"
              onclick="WCYTPlaylist.switchStation(${i})">${esc(s.short)}</button>
          `).join('')}
        </div>
        <button class="wcyt-sticky-play" onclick="WCYTPlaylist.togglePlay()"
          aria-label="${isPlaying ? 'Pause' : 'Play'}">
          ${audioState === 'buffering'
            ? '<span class="wcyt-btn-spinner"></span>'
            : isPlaying ? PAUSE_SVG : '&#9654;'}
        </button>
        <button class="wcyt-sticky-lfm${lastfmSession ? ' wcyt-sticky-lfm--on' : ''}"
          onclick="WCYTPlaylist.lfmConnect()"
          title="${lastfmSession ? 'Scrobbling as ' + lastfmSession.name + ' · click to disconnect' : 'Connect Last.fm to scrobble'}">LastFM</button>
        <button class="wcyt-sticky-close" onclick="WCYTPlaylist.closeSticky()" aria-label="Close">&#x2715;</button>
      </div>
    `;
  }

  // ── Combined render ───────────────────────────────────────────────────────

  function render() {
    renderHero();
    renderCompact();
    renderFull();
    renderSticky();
  }

  // ── Escape HTML ───────────────────────────────────────────────────────────

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.WCYTPlaylist = {
    /**
     * @param {HTMLElement|null} hero    - full-screen hero container (homepage)
     * @param {HTMLElement|null} compact - compact widget container
     * @param {HTMLElement|null} full    - full playlist page container
     */
    init(hero, compact, full, initialStation) {
      heroEl    = hero;
      compactEl = compact;
      fullEl    = full;
      if (initialStation === 0 || initialStation === 1) activeStation = initialStation;
      lfmLoad();
      lfmHandleCallback();
      initStickyPlayer();
      fetchNowPlaying().then(() => {
        if (pendingAutoResume) {
          pendingAutoResume = false;
          const a = getAudio();
          a.src = STATIONS[activeStation].stream;
          a.play().catch(() => setAudioState('stopped'));
          setAudioState('buffering');
        }
      });
      fetchCurrentShow();
      fetchDJPanel();
      pollTimer = setInterval(() => { fetchNowPlaying(); fetchCurrentShow(); }, POLL_MS);
      setInterval(fetchDJPanel, 30_000); // DJ panel — poll every 30s for timely on-air updates
      tickTimer = setInterval(tickAges, 30_000);
    },
    togglePlay()       { togglePlay(); },
    switchStation(idx) { switchStation(idx); },
    lfmConnect()       { lfmConnect(); },
    closeSticky() {
      stickyVisible = false;
      if (stickyEl) stickyEl.classList.remove('wcyt-sticky--show');
      const a = getAudio();
      a.pause(); a.src = '';
      setAudioState('stopped');
      savePlayerState();
    },
    fetchArt(artist, title) { return fetchArt(artist, title); },
    _getState()        { return { currentSong, songHistory, artCache, audioState, activeStation, currentShowWCYT, currentShow2 }; },
    _mockSong(artist, title) { handleNewTitle(`${artist} - ${title}`); },
  };
})();
