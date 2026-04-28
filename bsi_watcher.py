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
import urllib.request

REPO_DIR      = r"C:\Users\Andy\WCYT-Website"
LOG_FILE      = r"C:\Users\Andy\WCYT-Website\bsi_watcher.log"
POLL_INTERVAL = 2    # seconds between checks
DEBOUNCE      = 5    # seconds to wait after a change before pushing (matches stream delay)

# Local files already written to this PC by Simian
LOCAL_FILES = [
]

# Network files: (network_source_path, local_dest_filename)
# When the source changes, it gets copied locally then committed.
NETWORK_FILES = [
    (r"\\Wcyt\bsi32\WCYT_out.html",          "Point_Display_OUT.htm"),
    (r"\\10.20.255.61\bsi32\2_Display_OUT.htm", "2_Display_OUT.htm"),
]

# Backup.ini files to parse → status JSON files
# AutoStep values: 0=off, 1=assist, 2=auto
STATUS_SOURCES = [
    (r"\\Wcyt\bsi32\Backup.ini",          "point_status.json", "point"),
    (r"\\10.20.255.61\bsi32\Backup.ini",  "wcyt2_status.json", "wcyt2"),
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

        # Merge in latest simian status and PUT back
        record['simianStatus'] = _simian_status.copy()
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

def git(*args):
    result = subprocess.run(
        ["git"] + list(args),
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

    pending     = set()
    last_change = 0

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

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Watcher stopped.")
