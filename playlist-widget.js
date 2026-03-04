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
  const SHOW_URL      = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRvbq5nlJGzIblU91RLbcNBwChU9jE28xlwM537tunzMWb3hWyHmnuojMZAjKqNdSP8mmoDXdzp4U0a/pub?output=csv';
  const SHOW_TTL_MS   = 60 * 60 * 1000; // auto-clear after 1 hour

  const STATIONS = [
    {
      id:       'wcyt',
      label:    'WCYT 91 FM',
      name:     'The Point 91 FM',
      tagline:  'Where Music is the Point',
      stream:   'https://securestreams2.autopo.st:1069/WCYT.mp3',
      mount:    'WCYT.mp3',
    },
    {
      id:       '2pt0',
      label:    '2.0 Next Level of Radio',
      name:     '2.0 – The Next Level of Radio',
      tagline:  'The Next Level of Radio',
      stream:   'https://securestreams2.autopo.st:1069/wcythd2.mp3',
      mount:    'wcythd2.mp3',
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
  let artCache       = {};
  let currentShow    = null;   // { name: string, expiresAt: Date } | null
  let heroEl         = null;
  let compactEl      = null;
  let fullEl         = null;
  let corsWarned     = false;
  let pollTimer      = null;
  let tickTimer      = null;
  let activeStation  = 0;   // index into STATIONS

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
    audioState = state;
    updatePlayerButtons();
    updateBarsAnimation();
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
      bar.style.animationPlayState = playing ? 'running' : 'paused';
    });
  }

  function btnIcon(state) {
    if (state === 'buffering') return '<span class="wcyt-btn-spinner"></span>';
    if (state === 'playing')   return '<span class="wcyt-btn-icon">&#9646;&#9646;</span>';
    return '<span class="wcyt-btn-icon">&#9654;</span>';
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

  // ── Album art (iTunes Search API only) ───────────────────────────────────
  // iTunes only — Apple enforces content guidelines on all artwork so covers
  // are always safe. MusicBrainz/Cover Art Archive stores unedited original
  // artwork which can include explicit imagery (e.g. Pixies – Surfer Rosa).

  // Album types that are not the original release
  const ITUNES_REJECT = [
    'lullaby', 'karaoke', 'tribute', 'cover version',
    'instrumental version', 'made famous', 'originally performed',
  ];

  function normArtist(s) {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  async function fetchArtFromiTunes(artist, title) {
    const term = encodeURIComponent(`${artist} ${title}`);
    const res  = await fetch(
      `https://itunes.apple.com/search?term=${term}&entity=song&limit=10&country=US`
    );
    const data = await res.json();
    const na   = normArtist(artist);

    const match = (data.results ?? []).find(r => {
      // Artist name must contain the searched artist (blocks lullaby covers, tributes)
      if (!normArtist(r.artistName).includes(na))  return false;
      // Reject cover/tribute/lullaby collection names
      const col = (r.collectionName ?? '').toLowerCase();
      if (ITUNES_REJECT.some(t => col.includes(t)))  return false;
      return true;
      // Note: we intentionally skip the explicit flag — it refers to lyrics,
      // not the album artwork, so filtering on it blocks real releases.
    });

    return match?.artworkUrl100
      ? match.artworkUrl100.replace('100x100bb', '500x500bb')
      : null;
  }

  async function fetchArt(artist, title) {
    const key = artCacheKey(artist, title);
    if (key in artCache) return artCache[key];
    artCache[key] = null;
    try { artCache[key] = await fetchArtFromiTunes(artist, title); } catch {}
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

  async function fetchCurrentShow() {
    try {
      // Append timestamp to bust Google's server-side CSV cache
      const res  = await fetch(SHOW_URL + '&_t=' + Date.now(), { cache: 'no-store' });
      const text = await res.text();
      const lines = text.trim().split('\n').filter(Boolean);

      if (lines.length < 2) { currentShow = null; render(); return; }

      // Find the show name column — skip Timestamp and Email columns
      const headers = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());
      let showCol   = headers.findIndex(h => h !== 'timestamp' && !h.includes('email'));
      if (showCol === -1) showCol = headers.length - 1; // fallback: last column

      const cols     = parseCSVRow(lines[lines.length - 1]);
      const tsRaw    = (cols[0] ?? '').trim();
      const showName = (cols[showCol] ?? '').trim();

      const prev = currentShow?.name ?? null;

      // Typing "clear", "end", "done", or "off" clears the show immediately
      const CLEAR_WORDS = ['clear', 'end', 'done', 'off'];
      if (!showName || CLEAR_WORDS.includes(showName.toLowerCase())) {
        currentShow = null;
        if (prev !== null) render();
        return;
      }

      const submittedAt = new Date(tsRaw);
      const expiresAt   = new Date(submittedAt.getTime() + SHOW_TTL_MS);

      currentShow = Date.now() < expiresAt.getTime()
        ? { name: showName, expiresAt }
        : null;

      if ((currentShow?.name ?? null) !== prev) render();
    } catch { /* leave unchanged */ }
  }

  // ── Fetch stream metadata ─────────────────────────────────────────────────

  async function fetchNowPlaying() {
    try {
      const res  = await fetch(METADATA_URL, { cache: 'no-store' });
      const data = await res.json();

      let sources = data?.icestats?.source ?? [];
      if (!Array.isArray(sources)) sources = [sources];

      const findSource = mount =>
        sources.find(s => (s.listenurl ?? '').toLowerCase().includes(mount.toLowerCase()));

      // Station 1 — WCYT (drives history + full playlist page)
      handleNewTitle(findSource(STATIONS[0].mount)?.title ?? null);

      // Station 2 — track current song + history
      const raw2    = findSource(STATIONS[1].mount)?.title ?? null;
      const parsed2 = parseTitle(raw2);
      if (!isBlocked(raw2, parsed2) && (parsed2.artist || parsed2.title !== 'On Air')) {
        const key2 = artCacheKey(parsed2.artist, parsed2.title);
        const cur2  = currentSong2 ? artCacheKey(currentSong2.artist, currentSong2.title) : null;
        if (key2 !== cur2) {
          if (currentSong2) {
            songHistory2.unshift({ ...currentSong2, endedAt: new Date() });
            if (songHistory2.length > MAX_HISTORY) songHistory2.pop();
          }
          const artUrl = parsed2.artist ? await fetchArt(parsed2.artist, parsed2.title) : null;
          currentSong2 = { ...parsed2, startedAt: new Date(), artUrl };
          if (activeStation === 1) render();
        }
      } else {
        currentSong2 = null;
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

  async function handleNewTitle(raw) {
    const parsed = parseTitle(raw);

    if (isBlocked(raw, parsed)) return;

    if (!currentSong) {
      const artUrl = parsed.artist ? await fetchArt(parsed.artist, parsed.title) : null;
      currentSong = { ...parsed, startedAt: new Date(), artUrl };
      render();
      return;
    }

    const currentKey = artCacheKey(currentSong.artist, currentSong.title);
    const newKey     = artCacheKey(parsed.artist, parsed.title);
    if (newKey === currentKey) return;

    songHistory.unshift({ ...currentSong, endedAt: new Date() });
    if (songHistory.length > MAX_HISTORY) songHistory.pop();

    const artUrl = parsed.artist ? await fetchArt(parsed.artist, parsed.title) : null;
    currentSong = { ...parsed, startedAt: new Date(), artUrl };
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
          >${esc(s.label)}</button>
        `).join('')}
      </div>
    `;
  }

  function renderHero() {
    if (!heroEl) return;

    const song    = currentSong;
    const history = songHistory.slice(0, 3);
    const station = STATIONS[activeStation];
    const isWCYT  = activeStation === 0;

    heroEl.innerHTML = `
      <div class="wcyt-hero">
        ${isWCYT ? (song ? backdropDiv(song.artUrl) : '') : (currentSong2 ? backdropDiv(currentSong2.artUrl) : '')}
        <div class="wcyt-hero-inner">

          <div class="wcyt-hero-eyebrow">
            <span class="wcyt-bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
            <span>${esc(isWCYT ? 'THE POINT 91 FM \u00b7 WCYT' : '2.0 \u00b7 THE NEXT LEVEL OF RADIO')}</span>
          </div>

          ${stationSwitcher()}

          ${currentShow ? `
            <div class="wcyt-hero-show">
              <span class="wcyt-hero-show-dot"></span>
              <span class="wcyt-hero-show-label">NOW ON AIR</span>
              <span class="wcyt-hero-show-name">${esc(currentShow.name)}</span>
            </div>
          ` : ''}

          ${isWCYT ? `
            ${song ? `
              ${artImg(song.artUrl, 220, 'wcyt-hero-art')}
              <div class="wcyt-hero-artist">${esc(song.artist || 'WCYT')}</div>
              <div class="wcyt-hero-title">${esc(song.title)}</div>
              <div class="wcyt-hero-controls">
                <span class="wcyt-age wcyt-hero-age" data-started="${song.startedAt.toISOString()}">
                  ${relativeTime(song.startedAt)}
                </span>
                ${playBtnHTML('lg')}
                <a href="/playlist" class="wcyt-hero-playlist-link">Full playlist &rarr;</a>
              </div>
            ` : `<div class="wcyt-hero-loading">Loading&hellip;</div>`}

            ${history.length ? `
              <div class="wcyt-hero-recent">
                <div class="wcyt-hero-recent-label">RECENT PLAYS</div>
                <ul class="wcyt-hero-recent-list">
                  ${history.map(s => `
                    <li>
                      ${artImg(s.artUrl, 32, 'wcyt-hero-recent-art')}
                      <span class="wcyt-hero-recent-track">
                        <span class="wcyt-hero-recent-artist">${esc(s.artist || 'WCYT')}</span>
                        <span class="wcyt-hero-recent-sep">&middot;</span>
                        <span class="wcyt-hero-recent-title">${esc(s.title)}</span>
                      </span>
                      <span class="wcyt-hero-recent-time">${formatTime(s.startedAt)}</span>
                    </li>
                  `).join('')}
                </ul>
              </div>
            ` : ''}
          ` : `
            <div class="wcyt-hero-s2">
              <div class="wcyt-hero-s2-num">2.0</div>
              <div class="wcyt-hero-s2-tagline">The Next Level of Radio</div>
              ${currentSong2 ? `
                ${artImg(currentSong2.artUrl, 180, 'wcyt-hero-art')}
                <div class="wcyt-hero-artist">${esc(currentSong2.artist || '2.0')}</div>
                <div class="wcyt-hero-title">${esc(currentSong2.title)}</div>
              ` : ''}
                <div class="wcyt-hero-controls">
                <span class="wcyt-age wcyt-hero-age"
                  ${currentSong2 ? `data-started="${currentSong2.startedAt.toISOString()}"` : ''}>
                  ${currentSong2 ? relativeTime(currentSong2.startedAt) : 'Live now'}
                </span>
                ${playBtnHTML('lg')}
              </div>
            </div>

            ${songHistory2.length ? `
              <div class="wcyt-hero-recent">
                <div class="wcyt-hero-recent-label">RECENT PLAYS</div>
                <ul class="wcyt-hero-recent-list">
                  ${songHistory2.slice(0, 3).map(s => `
                    <li>
                      ${artImg(s.artUrl, 32, 'wcyt-hero-recent-art')}
                      <span class="wcyt-hero-recent-track">
                        <span class="wcyt-hero-recent-artist">${esc(s.artist || '2.0')}</span>
                        <span class="wcyt-hero-recent-sep">&middot;</span>
                        <span class="wcyt-hero-recent-title">${esc(s.title)}</span>
                      </span>
                      <span class="wcyt-hero-recent-time">${formatTime(s.startedAt)}</span>
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

    compactEl.innerHTML = `
      <div class="wcyt-compact">
        <div class="wcyt-compact-now">
          ${song ? backdropDiv(song.artUrl) : ''}
          <div class="wcyt-compact-header">
            <span class="wcyt-label">NOW PLAYING</span>
            <span class="wcyt-bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
          </div>
          ${song ? `
            <div class="wcyt-compact-song">
              ${artImg(song.artUrl, 140, 'wcyt-compact-art')}
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
          <a href="/playlist" class="wcyt-full-link">Full playlist &rarr;</a>
        </div>
      </div>
    `;

    updateBarsAnimation();
  }

  // ── Render: Full ──────────────────────────────────────────────────────────

  function renderFull() {
    if (!fullEl) return;

    const song    = currentSong;
    const history = songHistory;

    fullEl.innerHTML = `
      <div class="wcyt-full">
        <div class="wcyt-full-now-card">
          ${song ? backdropDiv(song.artUrl) : ''}
          <div class="wcyt-full-card-header">
            <span class="wcyt-label">NOW PLAYING</span>
            <span class="wcyt-bars wcyt-bars--lg" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
          </div>
          ${song ? `
            <div class="wcyt-full-song">
              ${artImg(song.artUrl, 260, 'wcyt-full-art')}
              <div class="wcyt-full-song-text">
                <div class="wcyt-full-artist">${esc(song.artist || 'WCYT')}</div>
                <div class="wcyt-full-title">${esc(song.title)}</div>
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

        <div class="wcyt-full-history-section">
          <div class="wcyt-full-history-header">RECENT PLAYS</div>
          ${history.length ? `
            <ul class="wcyt-full-history-list">
              ${history.map(s => `
                <li class="wcyt-full-history-item">
                  ${artImg(s.artUrl, 48, 'wcyt-history-art wcyt-history-art--full')}
                  <span class="wcyt-history-time">${formatTime(s.startedAt)}</span>
                  <span class="wcyt-full-history-track">
                    <span class="wcyt-full-history-artist">${esc(s.artist || 'WCYT')}</span>
                    <span class="wcyt-full-history-title">${esc(s.title)}</span>
                  </span>
                </li>
              `).join('')}
            </ul>
          ` : `
            <p class="wcyt-history-empty">
              Song history will appear here as tracks change.<br>
              Leave this page open to build up the playlist.
            </p>
          `}
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

  // ── Combined render ───────────────────────────────────────────────────────

  function render() {
    renderHero();
    renderCompact();
    renderFull();
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
    init(hero, compact, full) {
      heroEl    = hero;
      compactEl = compact;
      fullEl    = full;
      fetchNowPlaying();
      fetchCurrentShow();
      pollTimer = setInterval(() => { fetchNowPlaying(); fetchCurrentShow(); }, POLL_MS);
      tickTimer = setInterval(tickAges, 30_000);
    },
    togglePlay()       { togglePlay(); },
    switchStation(idx) { switchStation(idx); },
    _getState()        { return { currentSong, songHistory, artCache, audioState, activeStation }; },
    _mockSong(artist, title) { handleNewTitle(`${artist} - ${title}`); },
  };
})();
