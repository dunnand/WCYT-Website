/**
 * WCYT DJ Panel backend — Google Apps Script
 *
 * Stores the DJ on-air state AND the show library (names + logos) in
 * Script Properties, and saves uploaded logo images to a Google Drive
 * folder called "WCYT Show Logos".
 *
 * FIRST-TIME SETUP (~3 minutes):
 *   1. Go to https://script.google.com → New project
 *   2. Delete the starter code, paste this whole file, save (name it "WCYT DJ Panel")
 *   3. Run ▶ the `authorize` function once and approve the permissions popup
 *      (it will warn the app is unverified — Advanced → Go to WCYT DJ Panel)
 *   4. Deploy → New deployment → type: Web app
 *        - Execute as:      Me
 *        - Who has access:  Anyone
 *   5. Copy the Web app URL (ends in /exec)
 *   6. Paste that URL into SCRIPT_URL in dj.html and DJPANEL_URL in playlist-widget.js
 *
 * UPDATING THE CODE LATER (keeps the same /exec URL):
 *   1. Paste the new code over the old, save
 *   2. If the update adds new permissions (like Drive), Run ▶ `authorize` once
 *   3. Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy
 *
 * The panel password is verified here (by SHA-256 hash), so nothing secret
 * lives in the public website files. To change the password later, update
 * PASSWORD_HASH here AND in dj.html, then redeploy a new version.
 */

// SHA-256 of the DJ panel password (same hash as in dj.html)
const PASSWORD_HASH = 'd6242d92fd958617bd2530f19bc9c95ac147c87b77968b30553e4dc61e2b3117';

const DEFAULT_STATE = '{"wcyt":{"active":false},"2pt0":{"active":false}}';

const LOGO_FOLDER_NAME = 'WCYT Show Logos';

// Seed library — the shows that existed before the library moved into this
// backend. Used only the first time, when no 'shows' property exists yet.
const DEFAULT_SHOWS = [
  { name: '2.0 Default',                url: 'https://wcyt.org/images/shows/2.0 Logo.png' },
  { name: 'The Point Default',          url: 'https://wcyt.org/images/shows/91fm.png' },
  { name: 'The Last Dance',             url: 'https://wcyt.org/images/shows/The Last Dance.png' },
  { name: 'Off The Theories',           url: 'https://wcyt.org/images/shows/OffTheTheories-1.png' },
  { name: 'The Davon & Vaughn Show',    url: 'https://wcyt.org/images/shows/DavonVaughnShow.png' },
  { name: 'Grand Gear',                 url: 'https://wcyt.org/images/shows/GrandGear.png' },
  { name: 'Reel Talk',                  url: 'https://wcyt.org/images/shows/ReelTalk.png' },
  { name: "If I'm Being Honest Podcast", url: "https://wcyt.org/images/shows/If I'm Being Honest Podcast.png" },
  { name: 'Spartan Sports',             url: 'https://wcyt.org/images/shows/Spartan Sports WCYT 911.png' },
  { name: 'Out of the Huddle',          url: 'https://wcyt.org/images/shows/Out of the Huddle.png' },
];

// Run this once from the editor after pasting new code, to grant Drive access.
function authorize() {
  getLogoFolder();
  Logger.log('Authorized. Logo folder ready: ' + LOGO_FOLDER_NAME);
}

// ── Public read — the DJ panel, playlist widget, and studio display poll this
function doGet() {
  const state = PropertiesService.getScriptProperties().getProperty('state') || DEFAULT_STATE;
  return jsonOut({ record: JSON.parse(state), shows: getShows() });
}

// ── Password-protected writes ──────────────────────────────────────────
// The DJ panel posts { password, action, ... }. Actions:
//   (none)       { station, patch, historyEntry } — merge on-air state (original behavior)
//   'addShow'    { name, imageData? }             — imageData is a data: URL; omitted = default logo
//   'updateShow' { id, name?, imageData? }
//   'deleteShow' { id }
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut({ ok: false, error: 'bad request' }); }

  if (sha256Hex(body.password || '') !== PASSWORD_HASH) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    switch (body.action) {
      case 'addShow':    return jsonOut(addShow(body));
      case 'updateShow': return jsonOut(updateShow(body));
      case 'deleteShow': return jsonOut(deleteShow(body));
      default:           return jsonOut(patchState(body));
    }
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ── On-air state ───────────────────────────────────────────────────────
function patchState(body) {
  const props = PropertiesService.getScriptProperties();
  const state = JSON.parse(props.getProperty('state') || DEFAULT_STATE);
  const station = body.station === '2pt0' ? '2pt0' : 'wcyt';
  state[station] = Object.assign({}, state[station], body.patch,
    { updatedAt: new Date().toISOString() });
  if (body.historyEntry) {
    const hist = Array.isArray(state.history) ? state.history : [];
    hist.unshift(body.historyEntry);
    state.history = hist.slice(0, 20);
  }
  props.setProperty('state', JSON.stringify(state));
  return { ok: true, record: state };
}

// ── Show library ───────────────────────────────────────────────────────
function getShows() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('shows');
  if (raw) return JSON.parse(raw);
  const seeded = DEFAULT_SHOWS.map(s => ({ id: Utilities.getUuid(), name: s.name, url: s.url }));
  props.setProperty('shows', JSON.stringify(seeded));
  return seeded;
}

function saveShows(shows) {
  PropertiesService.getScriptProperties().setProperty('shows', JSON.stringify(shows));
}

function addShow(body) {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'name required' };
  const shows = getShows();
  const url = body.imageData
    ? saveLogoToDrive(body.imageData, name)
    : 'https://wcyt.org/images/shows/91fm.png';
  shows.push({ id: Utilities.getUuid(), name: name, url: url });
  saveShows(shows);
  return { ok: true, shows: shows };
}

function updateShow(body) {
  const shows = getShows();
  const show = shows.find(s => s.id === body.id);
  if (!show) return { ok: false, error: 'show not found' };
  if (body.name && String(body.name).trim()) show.name = String(body.name).trim();
  if (body.imageData) {
    trashDriveLogo(show.url);
    show.url = saveLogoToDrive(body.imageData, show.name);
  }
  saveShows(shows);
  return { ok: true, shows: shows };
}

function deleteShow(body) {
  const shows = getShows();
  const show = shows.find(s => s.id === body.id);
  if (!show) return { ok: false, error: 'show not found' };
  trashDriveLogo(show.url);
  saveShows(shows.filter(s => s.id !== body.id));
  return { ok: true, shows: shows.filter(s => s.id !== body.id) };
}

// ── Drive storage for uploaded logos ───────────────────────────────────
function getLogoFolder() {
  const it = DriveApp.getFoldersByName(LOGO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(LOGO_FOLDER_NAME);
}

// imageData is a data: URL from the panel (already resized in the browser).
// Returns a public image URL.
function saveLogoToDrive(imageData, showName) {
  const m = String(imageData).match(/^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/);
  if (!m) throw new Error('bad image data');
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], showName + '.' + ext);
  const file = getLogoFolder().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

// Only trashes files this script created (lh3.googleusercontent.com URLs);
// repo-hosted images (wcyt.org/images/...) are left alone.
function trashDriveLogo(url) {
  const m = String(url || '').match(/^https:\/\/lh3\.googleusercontent\.com\/d\/([-\w]+)/);
  if (!m) return;
  try { DriveApp.getFileById(m[1]).setTrashed(true); } catch (e) {}
}

// ── Helpers ────────────────────────────────────────────────────────────
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}
