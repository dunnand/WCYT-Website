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

  // ── State ─────────────────────────────────────────────────────────────────
  let currentSong  = null;   // { artist, title, startedAt, artUrl }
  let songHistory  = [];     // [{ artist, title, startedAt, endedAt, artUrl }]
  let artCache     = {};     // "artist|title" → artUrl (or null)
  let compactEl    = null;
  let fullEl       = null;
  let corsWarned   = false;
  let pollTimer    = null;
  let tickTimer    = null;

  // ── Audio player state ────────────────────────────────────────────────────
  let audio        = null;   // single HTMLAudioElement shared across widgets
  let audioState   = 'stopped';  // 'stopped' | 'buffering' | 'playing'

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
      a.src = '';           // release stream connection
    } else {
      a.src = STREAM_URL;
      a.play().catch(() => setAudioState('stopped'));
      setAudioState('buffering');
    }
  }

  // Update all play buttons without a full re-render
  function updatePlayerButtons() {
    document.querySelectorAll('[data-wcyt-playbtn]').forEach(btn => {
      btn.setAttribute('data-wcyt-playbtn', audioState);
      btn.setAttribute('aria-label', audioState === 'playing' ? 'Pause' : 'Play');
      btn.innerHTML = btnIcon(audioState);
    });
  }

  // Pause/resume the equalizer bar animation based on play state
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

  function playBtnHTML() {
    return `<button
      class="wcyt-play-btn"
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

  // ── Album art (iTunes Search API) ─────────────────────────────────────────

  async function fetchArt(artist, title) {
    const key = artCacheKey(artist, title);
    if (key in artCache) return artCache[key];

    artCache[key] = null;

    try {
      const term = encodeURIComponent(`${artist} ${title}`);
      const url  = `https://itunes.apple.com/search?term=${term}&entity=song&limit=5&country=US`;
      const res  = await fetch(url);
      const data = await res.json();

      const match = (data.results ?? []).find(r =>
        r.trackExplicitness !== 'explicit' &&
        r.collectionExplicitness !== 'explicit'
      );

      if (match?.artworkUrl100) {
        artCache[key] = match.artworkUrl100.replace('100x100bb', '500x500bb');
      }
    } catch {
      // leave as null
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

  // ── Art image element ─────────────────────────────────────────────────────

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

  // ── Render: Compact ───────────────────────────────────────────────────────

  function renderCompact() {
    if (!compactEl) return;

    const song    = currentSong;
    const history = songHistory.slice(0, 5);

    compactEl.innerHTML = `
      <div class="wcyt-compact">
        <div class="wcyt-compact-now">
          <div class="wcyt-compact-header">
            <span class="wcyt-label">NOW PLAYING</span>
            <span class="wcyt-bars" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
          </div>
          ${song ? `
            <div class="wcyt-compact-song">
              ${artImg(song.artUrl, 64, 'wcyt-compact-art')}
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
          <div class="wcyt-full-card-header">
            <span class="wcyt-label">NOW PLAYING</span>
            <span class="wcyt-bars wcyt-bars--lg" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
            </span>
          </div>
          ${song ? `
            <div class="wcyt-full-song">
              ${artImg(song.artUrl, 120, 'wcyt-full-art')}
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
    if (compactEl && !currentSong) compactEl.innerHTML = msg;
    if (fullEl    && !currentSong) fullEl.innerHTML    = msg;
  }

  // ── Relative time ticker ──────────────────────────────────────────────────

  function tickAges() {
    document.querySelectorAll('.wcyt-age[data-started]').forEach(el => {
      const d = new Date(el.dataset.started);
      el.textContent = el.closest('.wcyt-full-song')
        ? 'Started ' + relativeTime(d)
        : relativeTime(d);
    });
  }

  // ── Combined render ───────────────────────────────────────────────────────

  function render() {
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
    init(compact, full) {
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
