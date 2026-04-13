# BSI Watcher Setup — For Claude

## What this is
This PC (the website server) needs to run a background script called `bsi_watcher.py`
located at `C:\Users\DunnOffice\WCYT-Website\bsi_watcher.py`.

The script watches two files for changes:
- `C:\Users\DunnOffice\WCYT-Website\2_Display_OUT.htm`
- `C:\Users\DunnOffice\WCYT-Website\Point_Display_OUT.htm`

These files are written by Simian (radio automation software) on two other PCs on the
network whenever a song changes. When the watcher detects a change, it does a
`git commit` + `git push` so the live website (wcyt.org) gets the updated data
within a few seconds.

The live display page at `https://wcyt.org/display.htm` reads these files to show
album/year and recently played info for both stations.

## What needs to be done on THIS PC

### 1. Verify Python is installed
Run in a terminal:
```
python --version
```
If not installed, download from https://python.org

### 2. Verify git credentials are cached
Run in a terminal:
```
cd C:\Users\DunnOffice\WCYT-Website
git push
```
It should push without asking for a password. If it asks for credentials,
set up a GitHub personal access token and cache it with Git Credential Manager.

### 3. Set up Task Scheduler to run the watcher on boot
Run this command in an elevated (Admin) terminal to register the task automatically:
```
schtasks /create /tn "BSI Watcher" /tr "python C:\Users\DunnOffice\WCYT-Website\bsi_watcher.py" /sc onstart /ru SYSTEM /rl HIGHEST /f
```
This runs the watcher as SYSTEM on every boot — no login required, survives
Windows updates and reboots.

### 4. Start it now (without rebooting)
```
python C:\Users\DunnOffice\WCYT-Website\bsi_watcher.py
```

### 5. Prevent the PC from sleeping
Control Panel → Power Options → set sleep to Never
(So the script keeps running and the network share stays accessible)

## Verify it's working
After starting the watcher, wait for a song to change on either radio station.
Within ~5 seconds the watcher should print "Pushed successfully." in the terminal.
Then check https://wcyt.org/display.htm to confirm the data updated.

## Network context
- This PC: 10.20.255.67
- WCYT 2.0 PC: 10.20.255.61 (runs Simian, writes 2_Display_OUT.htm here)
- The Point PC: 10.20.255.43 (runs Simian, writes Point_Display_OUT.htm here)
- TVs are on the 10.20.200.x subnet — they access the display via wcyt.org
