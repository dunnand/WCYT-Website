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

REPO_DIR      = r"C:\Users\DunnOffice\WCYT-Website"
LOG_FILE      = r"C:\Users\DunnOffice\WCYT-Website\bsi_watcher.log"
POLL_INTERVAL = 2    # seconds between checks
DEBOUNCE      = 1    # seconds to wait after a change before pushing

# Local files already written to this PC by Simian
LOCAL_FILES = [
    "2_Display_OUT.htm",
]

# Network files: (network_source_path, local_dest_filename)
# When the source changes, it gets copied locally then committed.
NETWORK_FILES = [
    (r"\\Wcyt\bsi32\WCYT_out.html", "Point_Display_OUT.htm"),
]

# Backup.ini files to parse → status JSON files
# AutoStep values: 0=off, 1=assist, 2=auto
STATUS_SOURCES = [
    (r"\\Wcyt\bsi32\Backup.ini",          "point_status.json"),
    (r"\\10.20.255.61\bsi32\Backup.ini",  "wcyt2_status.json"),
]


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

def push_changes(changed_files):
    log(f"Changed: {', '.join(changed_files)}")

    for f in changed_files:
        code, out, err = git("add", f)
        if code != 0:
            log(f"git add failed: {err}")
            return

    code, out, err = git("commit", "-m", "Update BSI now-playing output")
    if code != 0:
        if "nothing to commit" in err or "nothing to commit" in out:
            log("Nothing to commit.")
        else:
            log(f"git commit failed: {err}")
        return

    log("Pushing...")
    code, out, err = git("push")
    if code == 0:
        log("Pushed successfully.")
    else:
        log(f"git push failed: {err}")

def main():
    log("=" * 44)
    log("BSI Watcher running")
    log(f"Local:   {', '.join(LOCAL_FILES)}")
    log(f"Network: {', '.join(src for src, _ in NETWORK_FILES)}")
    for src, dest in STATUS_SOURCES:
        log(f"Status:  {src} -> {dest}")
    log("=" * 44)

    local_mtimes  = {f: get_mtime(os.path.join(REPO_DIR, f)) for f in LOCAL_FILES}
    net_mtimes    = {src: get_mtime(src) for src, _ in NETWORK_FILES}
    status_mtimes = {src: get_mtime(src) for src, _ in STATUS_SOURCES}

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

        # Check Backup.ini files — parse and write status JSON if changed
        for src, dest in STATUS_SOURCES:
            new_mtime = get_mtime(src)
            if new_mtime != status_mtimes[src]:
                status_mtimes[src] = new_mtime
                status = parse_backup_ini(src)
                if status:
                    dest_path = os.path.join(REPO_DIR, dest)
                    try:
                        with open(dest_path, "w", encoding="utf-8") as f:
                            json.dump(status, f, indent=2)
                        log(f"[{dest}] mode={status['mode']}, logLoaded={status['logLoaded']}, playing={status['playing']}")
                        pending.add(dest)
                        last_change = now
                    except Exception as e:
                        log(f"Status write failed ({dest}): {e}")

        if pending and (now - last_change) >= DEBOUNCE:
            push_changes(list(pending))
            pending.clear()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Watcher stopped.")
