/*!
 * WCYT Shared Navigation
 * Include via <script src="/nav.js"></script> before </body>
 * Injects the full site nav and hides any existing Squarespace header.
 */
(function () {
  /* ── CSS ────────────────────────────────────────────────────────────── */
  const css = `
    :root {
      --nav-bg:      #0d0d0d;
      --nav-border:  #1a1a1a;
      --nav-hover:   #c8102e;
      --nav-drop:    #111111;
      --nav-drop-b:  #222222;
      --nav-text:    #ffffff;
      --nav-muted:   #aaaaaa;
      --nav-font:    'Space Grotesk', sans-serif;
    }

    /* ── bar ── */
    #wcyt-nav {
      position: sticky;
      top: 0;
      z-index: 9999;
      background: var(--nav-bg);
      border-bottom: 1px solid var(--nav-border);
      height: 96px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 32px;
      font-family: var(--nav-font);
    }

    /* ── logo ── */
    #wcyt-nav .wn-logo img {
      height: 80px;
      display: block;
    }

    /* ── desktop links ── */
    #wcyt-nav .wn-links {
      display: flex;
      align-items: center;
      gap: 4px;
      list-style: none;
    }
    #wcyt-nav .wn-links a,
    #wcyt-nav .wn-links button {
      font-family: var(--nav-font);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.03em;
      color: var(--nav-muted);
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 6px;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: color .2s, background .2s;
      white-space: nowrap;
    }
    #wcyt-nav .wn-links a:hover,
    #wcyt-nav .wn-links button:hover {
      color: var(--nav-text);
      background: rgba(255,255,255,.06);
    }
    #wcyt-nav .wn-links .wn-active > a {
      color: var(--nav-text);
    }

    /* ── folder (dropdown) ── */
    #wcyt-nav .wn-folder {
      position: relative;
    }
    #wcyt-nav .wn-folder-btn svg {
      width: 12px;
      height: 12px;
      transition: transform .2s;
      flex-shrink: 0;
    }
    #wcyt-nav .wn-folder.open .wn-folder-btn svg {
      transform: rotate(180deg);
    }
    #wcyt-nav .wn-folder-menu {
      display: none;
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      background: var(--nav-drop);
      border: 1px solid var(--nav-drop-b);
      border-radius: 10px;
      padding: 6px;
      min-width: 160px;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    #wcyt-nav .wn-folder.open .wn-folder-menu {
      display: block;
    }
    #wcyt-nav .wn-folder-menu a {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--nav-muted);
      padding: 8px 12px;
      border-radius: 6px;
      transition: color .15s, background .15s;
      text-decoration: none;
    }
    #wcyt-nav .wn-folder-menu a:hover {
      color: var(--nav-text);
      background: rgba(255,255,255,.07);
    }

    /* ── hamburger ── */
    #wcyt-nav .wn-burger {
      display: none;
      flex-direction: column;
      justify-content: center;
      gap: 5px;
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
    }
    #wcyt-nav .wn-burger span {
      display: block;
      width: 22px;
      height: 2px;
      background: var(--nav-muted);
      border-radius: 2px;
      transition: background .2s;
    }
    #wcyt-nav .wn-burger:hover span { background: var(--nav-text); }

    /* ── mobile menu ── */
    #wcyt-mobile-menu {
      display: none;
      position: fixed;
      top: 64px;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--nav-bg);
      z-index: 9998;
      overflow-y: auto;
      padding: 16px 20px 40px;
      font-family: var(--nav-font);
    }
    #wcyt-mobile-menu.open { display: block; }

    #wcyt-mobile-menu a {
      display: block;
      font-size: 16px;
      font-weight: 500;
      color: var(--nav-muted);
      padding: 14px 4px;
      border-bottom: 1px solid var(--nav-border);
      text-decoration: none;
      transition: color .2s;
    }
    #wcyt-mobile-menu a:hover { color: var(--nav-text); }

    #wcyt-mobile-menu .wm-section {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #444;
      padding: 20px 4px 6px;
    }
    #wcyt-mobile-menu .wm-sub a {
      font-size: 15px;
      padding: 12px 16px;
      border-bottom: 1px solid #181818;
    }

    /* ── responsive ── */
    @media (max-width: 680px) {
      #wcyt-nav .wn-links  { display: none; }
      #wcyt-nav .wn-burger { display: flex; }
      #wcyt-nav { padding: 0 20px; height: 64px; }
      #wcyt-nav .wn-logo img { height: 44px; }
    }
  `;

  /* ── NAV STRUCTURE ──────────────────────────────────────────────────── */
  const NAV_LINKS = [
    { label: 'Home', href: '/' },
    {
      label: 'Listen', href: '/',
      children: [
        { label: 'Live Radio',  href: '/' },
        { label: 'Podcasts',    href: '/podcasts' },
        { label: 'Live Stream', href: 'https://www.youtube.com/@HomesteadHighSchoolMedia', external: true },
        { label: 'Sports',      href: '/sports' },
      ]
    },
    { label: 'Contact', href: '/contact' },
    {
      label: 'About', href: '/about',
      children: [
        { label: 'About Us', href: '/about' },
        { label: 'Our Team', href: '/team' },
        { label: 'Awards',   href: '/awards' },
        { label: 'FCC Filing', href: 'https://publicfiles.fcc.gov/fm-profile/wcyt', external: true },
      ]
    },
  ];

  /* ── HELPERS ─────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const LOGO_SRC = 'https://images.squarespace-cdn.com/content/v1/66213a95afc386140701f167/1713453740425-M44AKIWYWNTFZHGQWZDY/WCYT-removebg-preview.png';

  const chevronSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`;

  /* ── BUILD NAV ───────────────────────────────────────────────────────── */
  function buildNav() {
    const linksHtml = NAV_LINKS.map(item => {
      if (item.children) {
        const items = item.children.map(c =>
          `<a href="${esc(c.href)}"${c.external ? ' target="_blank" rel="noopener"' : ''}>${esc(c.label)}</a>`
        ).join('');
        return `
          <li class="wn-folder">
            <button class="wn-folder-btn">${esc(item.label)} ${chevronSvg}</button>
            <div class="wn-folder-menu">${items}</div>
          </li>`;
      }
      return `<li><a href="${esc(item.href)}">${esc(item.label)}</a></li>`;
    }).join('');

    const nav = document.createElement('nav');
    nav.id = 'wcyt-nav';
    nav.setAttribute('aria-label', 'Site navigation');
    nav.innerHTML = `
      <a class="wn-logo" href="/" aria-label="The Point 91 FM – Home">
        <img src="${esc(LOGO_SRC)}" alt="WCYT The Point 91 FM">
      </a>
      <ul class="wn-links">${linksHtml}</ul>
      <button class="wn-burger" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>`;
    return nav;
  }

  /* ── BUILD MOBILE MENU ───────────────────────────────────────────────── */
  function buildMobile() {
    let html = '';
    for (const item of NAV_LINKS) {
      if (item.children) {
        html += `<div class="wm-section">${esc(item.label)}</div><div class="wm-sub">`;
        for (const c of item.children) {
          html += `<a href="${esc(c.href)}"${c.external ? ' target="_blank" rel="noopener"' : ''}>${esc(c.label)}</a>`;
        }
        html += `</div>`;
      } else {
        html += `<a href="${esc(item.href)}">${esc(item.label)}</a>`;
      }
    }
    const el = document.createElement('div');
    el.id = 'wcyt-mobile-menu';
    el.innerHTML = html;
    return el;
  }

  /* ── INJECT ──────────────────────────────────────────────────────────── */
  function inject() {
    // CSS
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Hide Squarespace header if present
    const sqHeader = document.querySelector('header#header');
    if (sqHeader) sqHeader.style.cssText = 'display:none!important';

    const nav = buildNav();
    const mobile = buildMobile();

    // Insert before first child of body
    document.body.insertBefore(mobile, document.body.firstChild);
    document.body.insertBefore(nav, document.body.firstChild);

    // Remove any existing simple .site-nav (custom pages)
    document.querySelectorAll('.site-nav').forEach(el => el.remove());

    /* ── INTERACTIONS ─────────────────────────────────────────────────── */
    // Desktop dropdowns
    nav.querySelectorAll('.wn-folder').forEach(folder => {
      const btn = folder.querySelector('.wn-folder-btn');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const open = folder.classList.contains('open');
        // close all
        nav.querySelectorAll('.wn-folder.open').forEach(f => f.classList.remove('open'));
        if (!open) folder.classList.add('open');
      });
    });
    document.addEventListener('click', () => {
      nav.querySelectorAll('.wn-folder.open').forEach(f => f.classList.remove('open'));
    });

    // Hamburger
    const burger = nav.querySelector('.wn-burger');
    burger.addEventListener('click', () => {
      const open = mobile.classList.toggle('open');
      burger.setAttribute('aria-expanded', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    // Close mobile on link click
    mobile.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        mobile.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
