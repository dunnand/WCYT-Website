"""
BSI Output File Watcher
Watches local and network BSI output files for changes,
copies network files locally, then auto-commits + pushes
to GitHub so wcyt.org stays current.

Run this on the website PC:
  python bsi_watcher.py
"""

import os
import shutil
import subprocess
import time
import sys
import json
import configparser
import io
import struct
import re
import urllib.request
import urllib.parse

REPO_DIR        = r"C:\Users\Andy\WCYT-Website"
LOG_FILE        = r"C:\Users\Andy\WCYT-Website\bsi_watcher.log"
POLL_INTERVAL   = 2    # seconds between checks
DEBOUNCE        = 5    # seconds to wait after a change before pushing (matches stream delay)
SHOW_IMAGES_DIR = os.path.join(REPO_DIR, "images", "shows")
MANIFEST_FILE   = os.path.join(SHOW_IMAGES_DIR, "manifest.json")
IMAGE_EXTS      = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}

# Local files already written to this PC by Simian
LOCAL_FILES = [
]

# Network files: (network_source_path, local_dest_filename)
# When the source changes, it gets copied locally then committed.
NETWORK_FILES = [
    (r"\\Wcyt\bsi32\WCYT_out.html",          "Point_Display_OUT.htm"),
    (r"\\2point0\bsi32\2_Display_OUT.htm", "2_Display_OUT.htm"),
]

# Backup.ini files to parse → status JSON files
# AutoStep values: 0=off, 1=assist, 2=auto
STATUS_SOURCES = [
    (r"\\Wcyt\bsi32\Backup.ini",          "point_status.json", "point"),
    (r"\\2point0\bsi32\Backup.ini",  "wcyt2_status.json", "wcyt2"),
]

# JSONBin — stores simian status so display page gets instant updates (no CDN cache)
JSONBIN_URL = 'https://api.jsonbin.io/v3/b/69dfdf65856a6821893a19f8'
JSONBIN_KEY = '$2a$10$3JxMllL6YGZtbEqwOQTbFeww2P.sNZ.b.aPWPreit5UwyM1pFHxie'
_simian_status = {}

def push_status_to_jsonbin(station_key, status):
    """Returns True on success, False on failure (so caller can retry next cycle)."""
    _simian_status[station_key] = {k: v for k, v in status.items() if k != 'updatedAt'}
    try:
        _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

        # GET current bin so we don't overwrite DJ panel keys
        get_req = urllib.request.Request(
            JSONBIN_URL + '/latest',
            headers={'X-Master-Key': JSONBIN_KEY, 'User-Agent': _UA},
            method='GET'
        )
        with urllib.request.urlopen(get_req, timeout=10) as resp:
            record = json.loads(resp.read()).get('record', {})

        # Merge in latest simian status and PUT back (preserve keys from other stations)
        existing_status = record.get('simianStatus', {})
        existing_status.update(_simian_status)
        record['simianStatus'] = existing_status
        put_req = urllib.request.Request(
            JSONBIN_URL,
            data=json.dumps(record).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_KEY,
                'User-Agent': _UA,
            },
            method='PUT'
        )
        with urllib.request.urlopen(put_req, timeout=10):
            pass
        log(f"[JSONBin] {station_key}={status['mode']}")
        return True
    except Exception as e:
        log(f"[JSONBin] push failed: {e}")
        return False


def parse_backup_ini(path):
    """Read Backup.ini and return a status dict."""
    try:
        raw = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    # configparser needs a valid key=value on every line; strip bare keys like "AutoStep" (no =)
    lines = [l for l in raw.splitlines() if "=" in l or l.strip().startswith("[")]
    cfg = configparser.RawConfigParser()
    cfg.read_string("\n".join(lines))

    def get(section, key, default=""):
        try:    return cfg.get(section, key)
        except: return default

    log_name  = get("LogStatus",   "LogName").strip()
    playing   = get("LogStatus",   "Playing").strip().lower() == "true"
    row       = get("LogStatus",   "Row").strip()
    log_time  = get("LogStatus",   "LogTime").strip()
    auto_step_raw = get("SystemStatus", "AutoStep").strip()
    try:    auto_step = int(auto_step_raw)
    except: auto_step = 0

    mode_map = {0: "off", 1: "assist", 2: "auto"}
    return {
        "logLoaded": bool(log_name),
        "logFile":   os.path.basename(log_name) if log_name else "",
        "playing":   playing,
        "mode":      mode_map.get(auto_step, "off"),
        "autoStep":  auto_step,
        "row":       row,
        "logTime":   log_time,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }

# ── Logging ───────────────────────────────────────────────────────────────────

def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

# ── Helpers ───────────────────────────────────────────────────────────────────

def get_mtime(path):
    try:
        return os.path.getmtime(path)
    except (FileNotFoundError, OSError):
        return 0

# Hide the subprocess window without blocking credential helpers
_si = subprocess.STARTUPINFO()
_si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
_si.wShowWindow = 0  # SW_HIDE

_GIT_EXE = r"C:\Program Files\Git\mingw64\bin\git.exe"

def git(*args):
    result = subprocess.run(
        [_GIT_EXE] + list(args),
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
        startupinfo=_si
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()

_GIT_LOCK = os.path.join(REPO_DIR, ".git", "index.lock")
_GIT_HEAD = os.path.join(REPO_DIR, ".git", "HEAD")

def _clear_git_lock():
    if os.path.exists(_GIT_LOCK):
        try:
            os.remove(_GIT_LOCK)
            log("Removed stale git index.lock")
        except Exception as e:
            log(f"Could not remove index.lock: {e}")

def _repair_broken_ref():
    """Fix a blank/corrupted branch ref by restoring the last hash from the reflog."""
    try:
        head = open(_GIT_HEAD).read().strip()
        if not head.startswith("ref: "):
            return False
        ref_rel = head[5:]  # e.g. refs/heads/main
        ref_file = os.path.join(REPO_DIR, ".git", ref_rel)
        if open(ref_file).read().strip():
            return False  # ref is fine
        reflog = os.path.join(REPO_DIR, ".git", "logs", ref_rel)
        last_line = open(reflog).readlines()[-1]
        commit_hash = last_line.split()[1]
        open(ref_file, "w").write(commit_hash + "\n")
        log(f"Repaired broken ref {ref_rel} -> {commit_hash[:12]}")
        return True
    except Exception as e:
        log(f"Could not repair broken ref: {e}")
        return False

def push_changes(changed_files):
    """Returns True on success, False on failure (caller keeps pending for retry)."""
    log(f"Changed: {', '.join(changed_files)}")
    _clear_git_lock()
    _repair_broken_ref()

    for f in changed_files:
        code, out, err = git("add", f)
        if code != 0:
            log(f"git add failed: {err}")
            return False

    code, out, err = git("commit", "-m", "Update BSI now-playing output")
    if code != 0:
        if "nothing to commit" in err or "nothing to commit" in out \
                or "no changes added to commit" in err or "no changes added to commit" in out:
            log("Nothing to commit.")
            return True
        log(f"git commit failed: {err or out}")
        return False

    log("Pushing...")
    code, out, err = git("push")
    if code == 0:
        log("Pushed successfully.")
        return True
    log(f"git push failed: {err}")
    return False

def scan_show_images():
    """Return sorted list of image filenames in SHOW_IMAGES_DIR (excluding manifest)."""
    try:
        return sorted(
            f for f in os.listdir(SHOW_IMAGES_DIR)
            if os.path.splitext(f)[1].lower() in IMAGE_EXTS
        )
    except OSError:
        return []

def rebuild_manifest(image_files):
    """Rewrite manifest.json from the current image file list, preserving existing names."""
    try:
        existing = json.loads(open(MANIFEST_FILE, encoding='utf-8').read())
        name_map = {os.path.basename(e['url']): e['name'] for e in existing.get('shows', [])}
    except Exception:
        name_map = {}

    shows = []
    for f in image_files:
        name = name_map.get(f) or os.path.splitext(f)[0]
        shows.append({"name": name, "url": f"/images/shows/{f}"})

    with open(MANIFEST_FILE, 'w', encoding='utf-8') as fh:
        json.dump({"shows": shows}, fh, indent=2, ensure_ascii=False)
    log(f"[manifest] Rebuilt with {len(shows)} images")

# ── WAV art auto-fetch ────────────────────────────────────────────────────────
WAV_DIR            = r'W:\\'
ART_OVERRIDES_FILE = os.path.join(REPO_DIR, 'images', 'art_overrides.json')
WAV_PROGRESS_FILE  = os.path.join(REPO_DIR, 'images', 'wav_art_progress.json')
WAV_SCAN_INTERVAL  = 86400  # once per day
WAV_FETCH_DELAY    = 1.5   # seconds between iTunes requests
MAX_WAV_PER_SCAN   = 20    # max new files processed per cycle

_BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
               'AppleWebKit/537.36 (KHTML, like Gecko) '
               'Chrome/124.0.0.0 Safari/537.36')
_ITUNES_REJECT = [
    'lullaby','karaoke','tribute','cover version','covers',
    'instrumental version','made famous','originally performed',
    'running','workout','fitness','gym','cardio','yoga','meditation',
    "now that's what i call",'hits of','music of','sounds of','songs of',
    'lounge','chillout','chill out',
]

def _strip_diacritics(s):
    import unicodedata
    return unicodedata.normalize('NFD', s or '').encode('ascii', 'ignore').decode('ascii')

def _norm_artist(s):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'\s*&\s*', 'and', _strip_diacritics(s).lower()))

def _norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', '', _strip_diacritics(s).lower())).strip()

def read_wav_xmp(path):
    """Return (artist, title) from WAV XMP metadata, or (None, None)."""
    try:
        with open(path, 'rb') as f:
            data = f.read(1024 * 1024)  # first 1 MB covers all metadata chunks
        idx = data.find(b'_PMX')
        if idx < 0:
            return None, None
        size = struct.unpack_from('<I', data, idx + 4)[0]
        xmp  = data[idx + 8: idx + 8 + min(size, 32768)].decode('utf-8', errors='replace')
        artist_m = re.search(r'<xmpDM:artist>([^<]+)</xmpDM:artist>', xmp)
        title_m  = re.search(r'<dc:title>.*?<rdf:li[^>]*>([^<]+)</rdf:li>', xmp, re.DOTALL)
        artist = artist_m.group(1).strip() if artist_m else None
        title  = title_m.group(1).strip()  if title_m  else None
        return artist, title
    except Exception:
        return None, None

def fetch_wav_art_url(artist, title):
    """Return iTunes art URL (500x500bb) for artist+title, or None."""
    na   = _norm_artist(artist)
    term = urllib.parse.quote(_strip_diacritics(f'{artist} {title}'))
    try:
        req = urllib.request.Request(
            f'https://itunes.apple.com/search?term={term}&entity=song&limit=25&country=US',
            headers={'User-Agent': _BROWSER_UA, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=12) as r:
            results = json.loads(r.read().decode('utf-8')).get('results', [])
    except Exception as e:
        log(f'[WAV-art] iTunes error: {e}')
        return None

    nt   = _norm(title)
    hits = []
    for r in results:
        if na not in _norm_artist(r.get('artistName', '')):
            continue
        col = (r.get('collectionName') or '').lower()
        if any(t in col for t in _ITUNES_REJECT):
            continue
        hits.append(r)

    match = next((r for r in hits if _norm(r.get('trackName', '')) == nt), None) \
            or (hits[0] if hits else None)
    if match:
        url = match.get('artworkUrl100', '')
        return url.replace('100x100bb', '500x500bb') if url else None
    return None

ART_REVIEW_FILE = r'C:\Users\Andy\Desktop\New Art Review.html'

def write_art_review(new_items):
    """Write an HTML page showing newly fetched art and open it in the browser."""
    if not new_items:
        return
    overrides_path = ART_OVERRIDES_FILE.replace('\\', '\\\\')
    cards = ''
    for artist, title, key, url in new_items:
        img_url = url.replace('500x500bb', '300x300bb') if url else ''
        cards += f'''
        <div class="card">
          <img src="{img_url}" onerror="this.style.background='#333';this.removeAttribute('src')">
          <div class="info">
            <div class="artist">{artist}</div>
            <div class="title">{title}</div>
            <div class="key">{key}</div>
          </div>
        </div>'''

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Art Review — {time.strftime('%Y-%m-%d')}</title>
<style>
  body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#1a1d23;color:#e8eaf0;padding:20px;margin:0}}
  h1{{font-size:18px;margin-bottom:6px}}
  .note{{background:#2a2f3a;border:1px solid #363c4a;border-radius:8px;
         padding:14px 18px;margin-bottom:20px;font-size:13px;line-height:1.7;color:#aab}}
  .note code{{background:#1a1d23;padding:2px 6px;border-radius:4px;font-size:12px;color:#7aabf0}}
  .grid{{display:flex;flex-wrap:wrap;gap:14px}}
  .card{{background:#22262f;border:1px solid #363c4a;border-radius:10px;
         overflow:hidden;width:220px}}
  .card img{{width:220px;height:220px;object-fit:cover;display:block;background:#2a2f3a}}
  .info{{padding:10px 12px}}
  .artist{{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
  .title{{font-size:12px;color:#aab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}}
  .key{{font-size:10px;color:#5a6a7a;margin-top:6px;word-break:break-all;
        background:#1a1d23;padding:4px 6px;border-radius:4px}}
</style>
</head>
<body>
<h1>New Album Art — {time.strftime('%B %d, %Y')} ({len(new_items)} songs)</h1>
<div class="note">
  To <strong>remove</strong> art you don't want on the displays:<br>
  1. Open <code>{overrides_path}</code><br>
  2. Find the line containing the <strong>key</strong> shown on the card (grey box)<br>
  3. Delete that entire line and save — the watcher will push the change automatically
</div>
<div class="grid">{cards}
</div>
</body>
</html>"""
    try:
        with open(ART_REVIEW_FILE, 'w', encoding='utf-8') as f:
            f.write(html)
        os.startfile(ART_REVIEW_FILE)
        log(f'[WAV-art] Review page opened: {ART_REVIEW_FILE}')
    except Exception as e:
        log(f'[WAV-art] Could not open review page: {e}')

def scan_and_fetch_new_wav_art():
    """Scan W:\\ for new WAV files and fetch iTunes art for any not yet processed."""
    try:
        progress = json.loads(open(WAV_PROGRESS_FILE, encoding='utf-8').read())
    except Exception:
        progress = {}

    try:
        ov_data   = json.loads(open(ART_OVERRIDES_FILE, encoding='utf-8-sig').read())
    except Exception:
        ov_data   = {'overrides': {}, 'newBlockedArt': []}
    overrides = ov_data.get('overrides', {})

    try:
        all_wavs = [f for f in os.listdir(WAV_DIR) if f.lower().endswith('.wav')]
    except Exception as e:
        log(f'[WAV-art] Cannot scan {WAV_DIR}: {e}')
        return

    # Collect unprocessed files, sort newest-created first so recent additions are handled first
    pending = []
    for fname in all_wavs:
        src = fname[:-4]
        if src not in progress:
            try:
                ct = os.path.getctime(os.path.join(WAV_DIR, fname))
            except Exception:
                ct = 0
            pending.append((ct, fname, src))
    pending.sort(reverse=True)

    if not pending:
        return

    batch = pending[:MAX_WAV_PER_SCAN]
    log(f'[WAV-art] {len(pending)} unprocessed WAVs — scanning {len(batch)}')
    updated   = False
    new_items = []  # (artist, title, key, url) for the review page

    for _, fname, src in batch:
        path   = os.path.join(WAV_DIR, fname)
        artist, title = read_wav_xmp(path)

        if not artist or not title:
            progress[src] = None
        else:
            key = (artist + '|' + title).lower()
            if key in overrides:
                progress[src] = overrides[key]  # already have art — mark done
            else:
                log(f'[WAV-art] {artist} – {title}')
                time.sleep(WAV_FETCH_DELAY)
                url = fetch_wav_art_url(artist, title)
                progress[src] = url
                if url:
                    overrides[key] = url
                    new_items.append((artist, title, key, url))
                    updated = True
                    log(f'[WAV-art]   ok')
                else:
                    log(f'[WAV-art]   no art found')

        # Save progress after every file so a crash doesn't lose work
        try:
            open(WAV_PROGRESS_FILE, 'w', encoding='utf-8').write(json.dumps(progress))
        except Exception as e:
            log(f'[WAV-art] Progress save error: {e}')

    if updated:
        ov_data['overrides'] = overrides
        try:
            open(ART_OVERRIDES_FILE, 'w', encoding='utf-8').write(
                json.dumps(ov_data, indent=2, ensure_ascii=False))
            log(f'[WAV-art] art_overrides.json updated ({len(new_items)} new)')
        except Exception as e:
            log(f'[WAV-art] Write error: {e}')
        write_art_review(new_items)

def main():
    log("=" * 44)
    log("BSI Watcher running")
    log(f"Local:   {', '.join(LOCAL_FILES)}")
    log(f"Network: {', '.join(src for src, _ in NETWORK_FILES)}")
    for src, dest, key in STATUS_SOURCES:
        log(f"Status:  {src} -> JSONBin[{key}]")
    log("=" * 44)

    local_mtimes  = {f: get_mtime(os.path.join(REPO_DIR, f)) for f in LOCAL_FILES}
    net_mtimes    = {src: get_mtime(src) for src, _ in NETWORK_FILES}
    status_mtimes = {src: get_mtime(src) for src, _, _k in STATUS_SOURCES}
    last_status   = {}  # station_key -> last successfully pushed sig
    last_failed   = {}  # station_key -> time.time() of last failed push
    RETRY_DELAY   = 30  # seconds to wait before retrying a failed push

    known_images = set(scan_show_images())

    pending        = set()
    last_change    = 0
    last_wav_scan  = 0

    while True:
        time.sleep(POLL_INTERVAL)
        now = time.time()

        # Check local files
        for f in LOCAL_FILES:
            path = os.path.join(REPO_DIR, f)
            new_mtime = get_mtime(path)
            if new_mtime != local_mtimes[f]:
                local_mtimes[f] = new_mtime
                pending.add(f)
                last_change = now

        # Check network files — copy to repo if changed
        for src, dest in NETWORK_FILES:
            new_mtime = get_mtime(src)
            if new_mtime != net_mtimes[src]:
                net_mtimes[src] = new_mtime
                dest_path = os.path.join(REPO_DIR, dest)
                try:
                    shutil.copy2(src, dest_path)
                    log(f"Copied {src} -> {dest}")
                    pending.add(dest)
                    last_change = now
                except Exception as e:
                    log(f"Copy failed ({src}): {e}")

        # Check for new show images — rebuild manifest and stage both if changed
        current_images = set(scan_show_images())
        if current_images != known_images:
            new_files = current_images - known_images
            known_images = current_images
            rebuild_manifest(sorted(current_images))
            for f in new_files:
                git("add", os.path.join("images", "shows", f))
                log(f"[manifest] Staged new image: {f}")
            pending.add(os.path.join("images", "shows", "manifest.json"))
            last_change = now

        # Check Backup.ini files — push to JSONBin only when values actually change
        for src, dest, station_key in STATUS_SOURCES:
            new_mtime = get_mtime(src)
            if new_mtime != status_mtimes[src]:
                status_mtimes[src] = new_mtime
                status = parse_backup_ini(src)
                if status:
                    sig = (status['mode'], status['logLoaded'], status['playing'])
                    if last_status.get(station_key) != sig:
                        failed_at = last_failed.get(station_key, 0)
                        if now - failed_at < RETRY_DELAY:
                            pass  # still in back-off window, skip
                        else:
                            log(f"[{station_key}] mode={status['mode']}, logLoaded={status['logLoaded']}, playing={status['playing']}")
                            if push_status_to_jsonbin(station_key, status):
                                last_status[station_key] = sig
                                last_failed.pop(station_key, None)
                            else:
                                last_failed[station_key] = now  # retry after RETRY_DELAY

        if pending and (now - last_change) >= DEBOUNCE:
            if push_changes(list(pending)):
                pending.clear()

        # Scan W:\ for new WAV files and fetch art for them
        if now - last_wav_scan >= WAV_SCAN_INTERVAL:
            last_wav_scan = now
            scan_and_fetch_new_wav_art()
            # watch_overrides.ps1 handles pushing art_overrides.json when it changes

if __name__ == "__main__":
    while True:
        try:
            main()
        except KeyboardInterrupt:
            log("Watcher stopped.")
            break
        except Exception as e:
            log(f"CRASH: {e} — restarting in 10s")
            time.sleep(10)
