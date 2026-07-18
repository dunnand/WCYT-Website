/**
 * WCYT DJ Panel backend — Google Apps Script
 *
 * Replaces JSONBin (which rate-limited us). Stores the DJ on-air state in
 * Script Properties and serves it as JSON.
 *
 * SETUP (one time, ~3 minutes):
 *   1. Go to https://script.google.com → New project
 *   2. Delete the starter code, paste this whole file, save (name it "WCYT DJ Panel")
 *   3. Deploy → New deployment → type: Web app
 *        - Execute as:      Me
 *        - Who has access:  Anyone
 *   4. Copy the Web app URL (ends in /exec)
 *   5. Paste that URL into SCRIPT_URL in dj.html and DJPANEL_URL in playlist-widget.js
 *
 * The panel password is verified here (by SHA-256 hash), so nothing secret
 * lives in the public website files. To change the password later, update
 * PASSWORD_HASH here AND in dj.html, then Deploy → Manage deployments →
 * edit → New version.
 */

// SHA-256 of the DJ panel password (same hash as in dj.html)
const PASSWORD_HASH = 'd6242d92fd958617bd2530f19bc9c95ac147c87b77968b30553e4dc61e2b3117';

const DEFAULT_STATE = '{"wcyt":{"active":false},"2pt0":{"active":false}}';

// Public read — the playlist widget polls this
function doGet() {
  const state = PropertiesService.getScriptProperties().getProperty('state') || DEFAULT_STATE;
  return jsonOut({ record: JSON.parse(state) });
}

// Password-protected write — the DJ panel posts { password, station, patch, historyEntry }
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut({ ok: false, error: 'bad request' }); }

  if (sha256Hex(body.password || '') !== PASSWORD_HASH) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
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
    return jsonOut({ ok: true, record: state });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}
