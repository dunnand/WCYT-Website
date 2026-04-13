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

REPO_DIR = r"C:\Users\DunnOffice\WCYT-Website"
POLL_INTERVAL = 3    # seconds between checks
DEBOUNCE      = 2    # seconds to wait after a change before pushing

# Local files already written to this PC by Simian
LOCAL_FILES = [
    "2_Display_OUT.htm",
]

# Network files: (network_source_path, local_dest_filename)
# When the source changes, it gets copied locally then committed.
NETWORK_FILES = [
    (r"\\Wcyt\bsi32\WCYT_out.html", "Point_Display_OUT.htm"),
]

def get_mtime(path):
    try:
        return os.path.getmtime(path)
    except (FileNotFoundError, OSError):
        return 0

def git(*args):
    result = subprocess.run(
        ["git"] + list(args),
        cwd=REPO_DIR,
        capture_output=True,
        text=True
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def push_changes(changed_files):
    print(f"  Changed: {', '.join(changed_files)}")

    for f in changed_files:
        code, out, err = git("add", f)
        if code != 0:
            print(f"  git add failed: {err}")
            return

    code, out, err = git("commit", "-m", "Update BSI now-playing output")
    if code != 0:
        if "nothing to commit" in err or "nothing to commit" in out:
            print("  Nothing to commit.")
        else:
            print(f"  git commit failed: {err}")
        return

    print("  Pushing...")
    code, out, err = git("push")
    if code == 0:
        print("  Pushed successfully.")
    else:
        print(f"  git push failed: {err}")

def main():
    all_watch = LOCAL_FILES + [src for src, _ in NETWORK_FILES]
    print("=" * 48)
    print("  BSI Watcher running")
    print(f"  Local:   {', '.join(LOCAL_FILES)}")
    print(f"  Network: {', '.join(src for src, _ in NETWORK_FILES)}")
    print("  Press Ctrl+C to stop.")
    print("=" * 48)

    # Track mtimes for local files
    local_mtimes = {f: get_mtime(os.path.join(REPO_DIR, f)) for f in LOCAL_FILES}
    # Track mtimes for network source files
    net_mtimes   = {src: get_mtime(src) for src, _ in NETWORK_FILES}

    pending    = set()
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
                    print(f"  Copied {src} → {dest}")
                    pending.add(dest)
                    last_change = now
                except Exception as e:
                    print(f"  Copy failed ({src}): {e}")

        if pending and (now - last_change) >= DEBOUNCE:
            push_changes(list(pending))
            pending.clear()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nWatcher stopped.")
