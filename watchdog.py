"""
watchdog.py — monitors bsi_watcher.py and restarts it if it dies.
Runs silently as a background process (pythonw).
Auto-started on login via a shortcut in the Startup folder.
"""
import os
import subprocess
import sys
import time

SCRIPT   = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bsi_watcher.py')
LOG      = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bsi_watcher.log')
INTERVAL = 60  # seconds between liveness checks

_si = subprocess.STARTUPINFO()
_si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
_si.wShowWindow = 0


def log(msg):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] [watchdog] {msg}'
    print(line, flush=True)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def is_running():
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             "Get-WmiObject Win32_Process | Where-Object "
             "{$_.Name -like 'python*' -and $_.CommandLine -like '*bsi_watcher*'} "
             "| Measure-Object | Select-Object -ExpandProperty Count"],
            capture_output=True, text=True, timeout=15, startupinfo=_si,
        )
        return int(result.stdout.strip() or '0') > 0
    except Exception:
        return True  # assume alive on error; better to skip than double-start


def start_watcher():
    subprocess.Popen(
        [sys.executable, SCRIPT],
        cwd=os.path.dirname(SCRIPT),
        startupinfo=_si,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


if __name__ == '__main__':
    log('Watchdog started')
    while True:
        time.sleep(INTERVAL)
        if not is_running():
            log('bsi_watcher not found — restarting')
            start_watcher()
            time.sleep(5)
            if is_running():
                log('bsi_watcher restarted OK')
            else:
                log('WARNING: restart attempt failed')
