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
  const MOUNT_POINT   = 'WCYT';
  const STREAM_URL    = 'https://securestreams2.autopo.st:1069/WCYT.mp3';
  const POLL_MS       = 10_000;
  const MAX_HISTORY   = 50;
  const FALLBACK_ART  = 'https://images.squarespace-cdn.com/content/v1/66213a95afc386140701f167/1713453740425-M44AKIWYWNTFZHGQWZDY/WCYT-removebg-preview.png';

  // Titles/artists that should never appear in the playlist display.
  const BLOCKED_TERMS = [
    'liner',
    'legal id',
    'btyb',
    'sponsor',
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let currentSong  = null;
  let songHistory  = [];
  let artCache     = {};
  let heroEl       = null;
  let compactEl    = null;
  let fullEl       = null;
  let corsWarned   = false;
  let pollTimer    = null;
  let tickTimer    = null;

  // ── Audio player state ────────────────────────────────────────────────────
  let audio        = null;
  let audioState   = 'stopped';

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
      a.src = STREAM_URL;
      a.play().catch(() => setAudioState('stopped'));
      setAudioState('buffering');
    }
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

  // ── Album art ─────────────────────────────────────────────────────────────
  // 1. iTunes Search API  — fast, good for mainstream
  // 2. MusicBrainz + Cover Art Archive — better for indie / obscure artists

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
      if (r.trackExplicitness === 'explicit')      return false;
      if (r.collectionExplicitness === 'explicit') return false;
      // Artist name must contain the searched artist (blocks lullaby covers, tributes)
      if (!normArtist(r.artistName).includes(na))  return false;
      // Reject cover/tribute/lullaby collection names
      const col = (r.collectionName ?? '').toLowerCase();
      if (ITUNES_REJECT.some(t => col.includes(t)))  return false;
      return true;
    });

    return match?.artworkUrl100
      ? match.artworkUrl100.replace('100x100bb', '500x500bb')
      : null;
  }

  async function fetchArtFromMusicBrainz(artist, title) {
    // Search MusicBrainz for the recording
    const q   = encodeURIComponent(`artist:"${artist}" recording:"${title}"`);
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=5`
    );
    if (!res.ok) return null;
    const data = await res.json();

    // Collect up to 3 unique release IDs from the top results
    const seen = new Set();
    const ids  = [];
    for (const rec of (data.recordings ?? []).slice(0, 3)) {
      const rel = (rec.releases ?? [])[0];
      if (rel?.id && !seen.has(rel.id)) { seen.add(rel.id); ids.push(rel.id); }
    }

    // Try each release against Cover Art Archive, return first hit
    for (const id of ids) {
      try {
        const r = await fetch(`https://coverartarchive.org/release/${id}/front`);
        if (r.ok) return r.url; // final URL after redirect
      } catch { /* try next */ }
    }
    return null;
  }

  async function fetchArt(artist, title) {
    const key = artCacheKey(artist, title);
    if (key in artCache) return artCache[key];
    artCache[key] = null;

    try { artCache[key] = await fetchArtFromiTunes(artist, title); } catch {}

    if (!artCache[key]) {
      try { artCache[key] = await fetchArtFromMusicBrainz(artist, title); } catch {}
    }

    return artCache[key];
  }

  // ── Fetch stream metadata ─────────────────────────────────────────────────

  async function fetchNowPlaying() {
    try {
      const res  = await fetch(METADATA_URL, { cache: 'no-store' });
      const data = await res.json();

      let sources = data?.icestats?.source ?? [];
      if (!Array.isArray(sources)) sources = [sources];

      const station = sources.find(s =>
        (s.listenurl ?? '').toUpperCase().includes(MOUNT_POINT.toUpperCase())
      );

      handleNewTitle(station?.title ?? null);
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

  function renderHero() {
    if (!heroEl) return;

    const song    = currentSong;
    const history = songHistory.slice(0, 3);

    heroEl.innerHTML = `
      <div class="wcyt-hero">
        ${song ? backdropDiv(song.artUrl) : ''}
        <div class="wcyt-hero-inner">

          <div class="wcyt-hero-eyebrow">
            <span class="wcyt-bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
            <span>THE POINT 91 FM &middot; WCYT</span>
          </div>

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
      pollTimer = setInterval(fetchNowPlaying, POLL_MS);
      tickTimer = setInterval(tickAges, 30_000);
    },
    togglePlay() { togglePlay(); },
    _getState()  { return { currentSong, songHistory, artCache, audioState }; },
    _mockSong(artist, title) { handleNewTitle(`${artist} - ${title}`); },
  };
})();
