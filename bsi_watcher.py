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

REPO_DIR        = r"C:\Users\Andy\WCYT-NowPlaying"  # now-playing repo: BSI OUT files + status JSONs
SITE_DIR        = r"C:\Users\Andy\WCYT-Website"     # website repo: show images + manifest only
LOG_FILE        = r"C:\Users\Andy\WCYT-Website\bsi_watcher.log"
POLL_INTERVAL   = 2    # seconds between checks
DEBOUNCE        = 5    # seconds to wait after a change before pushing (matches stream delay)
SHOW_IMAGES_DIR = os.path.join(SITE_DIR, "images", "shows")
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

# Status JSON files are committed to the repo and read by display.htm via
# raw.githubusercontent.com — same pattern as the BSI OUT files. (Replaced
# JSONBin, whose request quota was exhausted.)

def write_status_file(dest, status):
    """Write station status JSON into the repo; returns True on success."""
    try:
        with open(os.path.join(REPO_DIR, dest), 'w', encoding='utf-8') as f:
            json.dump(status, f, indent=2)
        return True
    except Exception as e:
        log(f"[status] write failed ({dest}): {e}")
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

    log_base     = os.path.basename(log_name).lower() if log_name else ""
    today_bsi    = time.strftime("%m%d%y") + ".bsi"
    log_date_ok  = (log_base == today_bsi) if log_name else False

    mode_map = {0: "off", 1: "assist", 2: "auto"}
    return {
        "logLoaded":  bool(log_name),
        "logFile":    log_base,
        "logDateOk":  log_date_ok,
        "playing":    playing,
        "mode":       mode_map.get(auto_step, "off"),
        "autoStep":   auto_step,
        "row":        row,
        "logTime":    log_time,
        "updatedAt":  time.strftime("%Y-%m-%dT%H:%M:%S"),
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

def git(*args, repo=REPO_DIR):
    try:
        result = subprocess.run(
            [_GIT_EXE] + list(args),
            cwd=repo,
            capture_output=True,
            text=True,
            startupinfo=_si,
            timeout=30
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        log(f"git {' '.join(args)} timed out after 30s")
        return 1, "", "timeout"

def _clear_git_lock(repo):
    """Handle .git/index.lock. Returns True when it's safe to run git.

    A fresh lock usually means another git process is mid-operation, and
    deleting it can corrupt the index. (Auto-deleting a live lock is what
    let the watcher commit from a bad index on 2026-05-30 and wipe every
    website file from the repo.) Only a stale lock (>60s old) is removed.
    """
    lock = os.path.join(repo, ".git", "index.lock")
    if not os.path.exists(lock):
        return True
    try:
        age = time.time() - os.path.getmtime(lock)
    except OSError:
        return True  # lock vanished between check and stat
    if age < 60:
        log(f"index.lock is {age:.0f}s old — another git process may be active; retrying later")
        return False
    try:
        os.remove(lock)
        log("Removed stale git index.lock")
        return True
    except Exception as e:
        log(f"Could not remove index.lock: {e}")
        return False

def _repair_broken_ref(repo):
    """Fix a blank/corrupted branch ref by restoring the last hash from the reflog."""
    try:
        head = open(os.path.join(repo, ".git", "HEAD")).read().strip()
        if not head.startswith("ref: "):
            return False
        ref_rel = head[5:]  # e.g. refs/heads/main
        ref_file = os.path.join(repo, ".git", ref_rel)
        if open(ref_file).read().strip():
            return False  # ref is fine
        reflog = os.path.join(repo, ".git", "logs", ref_rel)
        last_line = open(reflog).readlines()[-1]
        commit_hash = last_line.split()[1]
        open(ref_file, "w").write(commit_hash + "\n")
        log(f"Repaired broken ref {ref_rel} -> {commit_hash[:12]}")
        return True
    except Exception as e:
        log(f"Could not repair broken ref: {e}")
        return False

def push_changes(changed_files, repo=REPO_DIR, message="Update BSI now-playing output"):
    """Returns True on success, False on failure (caller keeps pending for retry)."""
    log(f"Changed ({os.path.basename(repo)}): {', '.join(changed_files)}")
    if not _clear_git_lock(repo):
        return False
    _repair_broken_ref(repo)

    # This watcher only ever updates or creates files. A pending file that's
    # missing from disk must not be committed — that would record a deletion.
    present = [f for f in changed_files if os.path.exists(os.path.join(repo, f))]
    missing = set(changed_files) - set(present)
    if missing:
        log(f"SKIPPING missing files (refusing to commit deletions): {', '.join(missing)}")
    if not present:
        return True

    for f in present:
        code, out, err = git("add", "--", f, repo=repo)
        if code != 0:
            log(f"git add failed: {err}")
            return False

    # Pathspec commit: git builds this commit from HEAD plus ONLY the named
    # paths, so unrelated staged changes or a corrupted/emptied index can
    # never leak into a watcher commit (or delete files out of it).
    code, out, err = git("commit", "-m", message, "--", *present, repo=repo)
    if code != 0:
        if "nothing to commit" in err or "nothing to commit" in out \
                or "no changes added to commit" in err or "no changes added to commit" in out \
                or "nothing added to commit" in err or "nothing added to commit" in out:
            log("Nothing to commit.")
            return True
        log(f"git commit failed: {err or out}")
        return False

    log("Pushing...")
    code, out, err = git("push", repo=repo)
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

def main():
    log("=" * 44)
    log("BSI Watcher running")
    log(f"Local:   {', '.join(LOCAL_FILES)}")
    log(f"Network: {', '.join(src for src, _ in NETWORK_FILES)}")
    for src, dest, key in STATUS_SOURCES:
        log(f"Status:  {src} -> {dest}")
    log("=" * 44)

    local_mtimes  = {f: get_mtime(os.path.join(REPO_DIR, f)) for f in LOCAL_FILES}
    net_mtimes    = {src: get_mtime(src) for src, _ in NETWORK_FILES}
    status_mtimes = {src: get_mtime(src) for src, _, _k in STATUS_SOURCES}
    last_status   = {}  # station_key -> last written sig
    last_date     = time.strftime("%m%d%y")  # track day boundary for logDateOk re-push

    known_images = set(scan_show_images())

    pending          = set()  # now-playing repo (REPO_DIR)
    last_change      = 0
    pending_site     = set()  # website repo (SITE_DIR) — show images/manifest
    last_change_site = 0

    # Write status files once at startup so display.htm always has current data
    for src, dest, station_key in STATUS_SOURCES:
        status = parse_backup_ini(src)
        if status and write_status_file(dest, status):
            last_status[station_key] = (status['mode'], status['logLoaded'],
                                        status.get('logDateOk', True), status['playing'])
            pending.add(dest)
            last_change = time.time()

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
                pending_site.add("images/shows/" + f)
                log(f"[manifest] Queued new image: {f}")
            pending_site.add("images/shows/manifest.json")
            last_change_site = now

        # At midnight, logDateOk flips — force a re-push even if Backup.ini didn't change
        current_date = time.strftime("%m%d%y")
        if current_date != last_date:
            last_date = current_date
            last_status.clear()

        # Check Backup.ini files — rewrite status JSON only when values actually change
        for src, dest, station_key in STATUS_SOURCES:
            new_mtime = get_mtime(src)
            if new_mtime != status_mtimes[src]:
                status_mtimes[src] = new_mtime
                status = parse_backup_ini(src)
                if status:
                    sig = (status['mode'], status['logLoaded'], status.get('logDateOk', True), status['playing'])
                    if last_status.get(station_key) != sig:
                        log(f"[{station_key}] mode={status['mode']}, logLoaded={status['logLoaded']}, playing={status['playing']}")
                        if write_status_file(dest, status):
                            last_status[station_key] = sig
                            pending.add(dest)
                            last_change = now

        if pending and (now - last_change) >= DEBOUNCE:
            if push_changes(list(pending)):
                pending.clear()

        if pending_site and (now - last_change_site) >= DEBOUNCE:
            if push_changes(list(pending_site), repo=SITE_DIR, message="Add show images"):
                pending_site.clear()


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
