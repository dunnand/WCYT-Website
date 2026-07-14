# BSI Watcher Setup

## What this is
The website PC runs `C:\Users\Andy\WCYT-Website\bsi_watcher.py` in the background
(kept alive by `watchdog.py`, which is auto-started from the Startup folder).

The watcher:
- Copies the Simian BSI output files from the two station PCs and commits/pushes
  them to the **WCYT-NowPlaying** repo (`C:\Users\Andy\WCYT-NowPlaying`), so
  wcyt.org's display pages update within seconds of a song change.
- Parses each station's `Backup.ini` into `point_status.json` / `wcyt2_status.json`
  (Simian mode + log status) and pushes those to the same repo.
- Watches `images/shows/` in the **WCYT-Website** repo for new show images and
  auto-commits them with an updated `manifest.json`.

The two repos:
- `dunnand/WCYT-NowPlaying` — machine-generated now-playing data (constant commits)
- `dunnand/WCYT-Website` — the website itself, deployed to GitHub Pages on push

Display pages read the now-playing data from
`https://raw.githubusercontent.com/dunnand/WCYT-NowPlaying/main/...`.

## Setting up on a new PC

1. Install Python 3 and Git.
2. Clone both repos into `C:\Users\<user>\WCYT-Website` and `C:\Users\<user>\WCYT-NowPlaying`,
   then update the path constants at the top of `bsi_watcher.py` and `watchdog.py`.
3. Verify git can push both repos without prompting (Git Credential Manager with a
   GitHub token that has `repo` + `workflow` scope):
   ```
   cd C:\Users\<user>\WCYT-NowPlaying && git push
   ```
4. Put a shortcut to `pythonw.exe watchdog.py` in the Startup folder
   (`shell:startup`) so the watcher survives reboots.
5. Set Windows power options so the PC never sleeps (network shares must stay reachable).

## Verify it's working
Watch `bsi_watcher.log`. Within a song change you should see
`Copied ... -> Point_Display_OUT.htm` then `Pushed successfully.`
Then check https://wcyt.org/display.htm updates.

## Network context
- This PC: 10.20.255.67 (runs the watcher)
- WCYT 2.0 PC: 10.20.255.61 (Simian, writes `\\2point0\bsi32\2_Display_OUT.htm`)
- The Point PC: 10.20.255.43 (Simian, writes `\\Wcyt\bsi32\WCYT_out.html`)
- TVs are on the 10.20.200.x subnet — they access the display via wcyt.org
