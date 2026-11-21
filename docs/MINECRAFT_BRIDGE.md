# Minecraft bridge (`mcbridge`)

`mcbridge` runs on the machine that hosts a Minecraft server and posts to Discord:

- when the server comes up and when it stops;
- players joining and leaving;
- in-game chat, each line under the player's name;
- real problems: errors with their stack trace, crashes (from the server's crash reports), the port already in use, and lag that keeps repeating.

It doesn't post routine noise (anti-cheat kicks, the occasional "Can't keep up!", `INFO` chatter), and it holds back repeats of the same error. It is separate from the bot. It reads the server's `logs/latest.log` and posts through Discord **webhooks**, so the bot's token never leaves the bot's VM, and nothing has to be opened in a firewall ([decision 0005](decisions/0005-minecraft-bridge-webhook-helper.md)). The design and its open questions are in [Track A of the plan](plans/minecraft-ff14-features.md#track-a-minecraft-bridge).

**Supported today:** vanilla servers (checked against a 26.3 server's log). Paper, Fabric and Forge come later, each once a sample log has been checked. One copy of `mcbridge` runs per Minecraft server.

## What a channel looks like

| In the log | In Discord (for example) |
|---|---|
| `Done (8.1s)! For help, type "help"` | 🟢 **Survival** is up (started in 8.1 s) |
| `Stopping server` | 🔴 **Survival** is stopping |
| `Steve joined the game` / `left the game` | ➕ **Steve** joined / ➖ **Steve** left |
| `<Steve> hello` | `hello`, sent as **Steve** |
| An `ERROR` with a stack trace | ⚠️ **Survival**: Error (ERROR), then the message and trace in a code block |
| The same error again within 10 minutes | Nothing at first; later, one summary with how many times it repeated |
| `Can't keep up!` 5 times in 5 minutes | ⚠️ **Survival**: Lagging: “Can't keep up!” repeated (WARN) |
| `FAILED TO BIND TO PORT` | ⚠️ **Survival**: Can't bind to its port: the server didn't come up (WARN) |
| A new file in `crash-reports/` | ⚠️ **Survival**: Crashed (FATAL), then the report's description and exception in a code block, and the report's file name |
| The server crashing again within 10 minutes | Nothing at first (a crash is never held back by the limit of 5 alerts a minute, only by being a repeat); later, one summary with how many more times it crashed |

Nothing typed in Minecraft can ping anyone: every post turns mentions off, `@everyone` included. Chat reads exactly as typed: Discord formatting in it (`**bold**`, `# heading`, `||spoilers||`, `[text](link)`, `<@id>`, custom emoji) is escaped and shows as plain text. Links stay clickable. Lines that arrive within a second of each other from the same sender are joined into one message.

## 1. Install Node.js 24

`mcbridge` needs **Node.js 24** (it runs the TypeScript files directly) and nothing else: no `npm install`, no build.

- **Windows / macOS:** the LTS installer from [nodejs.org](https://nodejs.org), version 24.
- **Linux:** your distribution's Node 24 package, or on Debian and Ubuntu, NodeSource as in [`ORACLE_CLOUD_DEPLOYMENT.md`](../ORACLE_CLOUD_DEPLOYMENT.md) §4.

Check it with `node --version` (it should print `v24.…`).

## 2. Get the code

Clone the repository (or download it as a ZIP from GitHub and unzip it) anywhere on the Minecraft host:

```sh
git clone https://github.com/AlexLe08/shrimp-fried-this-rice.git
cd shrimp-fried-this-rice
```

To update later: `git pull` (or download the ZIP again, keeping your `mcbridge.json`), then restart `mcbridge`.

## 3. Create the webhooks

In Discord, for the channel the server's messages should go to: **Edit Channel → Integrations → Webhooks → New Webhook**. Name it after the server, then **Copy Webhook URL**. You need **Manage Webhooks** in that channel.

Use one webhook for chat and another, in a staff channel, for alerts. Or use the same URL for both to get everything in one channel.

**The URL is a password.** Anyone who has it can post in that channel under any name. Keep it out of screenshots and out of git. If it leaks, delete the webhook in the same menu and create a new one; the old URL stops working at once.

## 4. Write the config

Copy `mcbridge.example.json` to `mcbridge.json` in the repository folder, then fill it in. Any `mcbridge*.json` other than the example is git-ignored, so the webhook URLs can't be committed by accident.

```json
{
  "serverName": "Survival",
  "logPath": "/path/to/server/logs/latest.log",
  "crashReportsDir": "/path/to/server/crash-reports",
  "webhooks": {
    "chat": "https://discord.com/api/webhooks/…",
    "alerts": "https://discord.com/api/webhooks/…"
  },
  "ignorePatterns": []
}
```

| Key | |
|---|---|
| `serverName` | Shown in every message, and the sender name of everything but chat. 1 to 80 characters, without "clyde" or "discord" (Discord refuses those in a webhook's name). Give each server its own if several share a channel. |
| `logPath` | The server's `logs/latest.log`. A relative path is read from the config file's folder. On Windows, write backslashes doubled (`"C:\\mc\\logs\\latest.log"`) or use forward slashes: a single backslash can make a different, valid path (`\t`, `\n`, `\r`, `\b` and `\f` are escapes in JSON, so `C:\temp` loses its `t`). |
| `crashReportsDir` | Optional: the server's `crash-reports` folder, next to `logs`. Each new report in it is posted as an alert; reports already there when `mcbridge` starts, or written while it wasn't running, aren't. The folder needn't exist yet (the server makes it at its first crash). A relative path is read from the config file's folder; on Windows, write backslashes as for `logPath`. Leave it out to post no crash reports. |
| `webhooks.chat` | Start, stop, joins, leaves and chat. A webhook URL as Discord copies it: a thread or forum post (`?thread_id=…`) isn't supported yet. |
| `webhooks.alerts` | Errors, crashes, lag, port problems, the log or crash-reports folder becoming unreadable, and summaries of repeats. May be the same URL as `chat`. |
| `format` | Optional; only `"vanilla"` for now. |
| `ignorePatterns` | Optional: regular expressions (case-sensitive) for messages that should never alert, added to the built-in list (`was kicked for floating too long`, `moved too quickly!`, `moved wrongly!`). Only lines that would alert are affected: `ERROR` and `FATAL`, a port already in use, and repeated lag. Other warnings are never posted, so they need no pattern. Add one when an error turns out to be harmless and keeps posting. |

`mcbridge` refuses to start if anything is wrong, and lists every problem at once. That includes keys it doesn't know, so a typo can't be silently ignored. A config saved with a byte order mark (Windows PowerShell 5 does this) is fine.

**A server in Docker:** run `mcbridge` on the host, not in the container, and point `logPath` at the host side of the container's data volume. For example, if the `docker-compose.yml` in `/srv/mc` mounts `./data:/data`, that's `/srv/mc/data/logs/latest.log`, and `crashReportsDir` is `/srv/mc/data/crash-reports`. Write it as an absolute path: a relative one is read from the config file's folder, not the Compose project's. On Docker Desktop (Windows and macOS), check that `mcbridge` notices the log being replaced when the server restarts (step 5). Some of its shared folders don't report the file identity `mcbridge` uses to spot a new log, which leaves only the file shrinking as the signal.

## 5. Try it once by hand

Start `mcbridge` **before** the Minecraft server, or the "is up" message is missed:

```sh
npm run mcbridge -- --config mcbridge.json
```

It prints `watching … for Survival` (and `watching … for new crash reports` if `crashReportsDir` is set), and whether the log it found says the server is up. If it says the log doesn't exist yet and the server has run before, `logPath` is wrong. A relative `--config` is read from the folder you typed the command in. Then start the server, join, type in chat, and stop the server: each should appear in Discord within a couple of seconds. To check crash reports without crashing the server, copy a report already in `crash-reports/` (or any text file) into that folder under a new name ending `.txt`: a "Crashed" alert should follow within about 10 seconds. Press **Ctrl+C** to stop `mcbridge`. It posts anything still queued, waiting up to 5 seconds, before exiting.

Everything `mcbridge` has to say goes to its console, prefixed `[mcbridge]`.

## 6. Start it automatically

`mcbridge` has to be running whenever the server is, and started before it. Pick one of these per OS. Each starts `mcbridge` at boot or login, restarts it if it stops, and keeps its console output in a log file.

Replace the paths: the repository folder, the config, and `node` (`where node` on Windows, `which node` on macOS and Linux).

### Windows: a loop script, started by Task Scheduler

Task Scheduler's own restart option only covers a task that fails to start, not a program that stops later. So `mcbridge` runs inside a small script that restarts it. Save as `mcbridge.bat` in the repository folder:

```bat
@echo off
cd /d "C:\mc\shrimp-fried-this-rice"
:loop
"C:\Program Files\nodejs\node.exe" src\minecraft\bridge\main.ts --config mcbridge.json >> mcbridge.log 2>&1
timeout /t 10 /nobreak >nul
goto loop
```

Its output goes to `mcbridge.log` beside it, which is where to look for the messages in Troubleshooting. A scheduled task has no console window to show them.

1. Open **Task Scheduler → Create Task**.
2. **General:** name it `mcbridge`, and choose **Run whether user is logged on or not** if the server runs without anyone logged in.
3. **Triggers:** **At startup** (or **At log on**, if the server starts when you log in).
4. **Actions:** **Start a program**, with **Program** set to the full path of `mcbridge.bat`.
5. **Conditions:** clear **Start the task only if the computer is on AC power**.
6. **Settings:** clear **Stop the task if it runs longer than**.

If you start the server by hand from a `.bat` instead, start `mcbridge` from the same one, so it is always first:

```bat
start "mcbridge" /D "C:\mc\shrimp-fried-this-rice" mcbridge.bat
timeout /t 2
java -Xmx4G -jar server.jar nogui
```

Run by hand (step 5), Ctrl+C or closing its window lets `mcbridge` post what's queued first. **End task** in Task Manager, or ending the scheduled task, stops it at once.

### macOS: launchd

Save as `~/Library/LaunchAgents/local.mcbridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.mcbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>src/minecraft/bridge/main.ts</string>
    <string>--config</string>
    <string>mcbridge.json</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/mc/shrimp-fried-this-rice</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/mc/mcbridge.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/mc/mcbridge.log</string>
</dict>
</plist>
```

Then load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.mcbridge.plist`. Its console output goes to `mcbridge.log`.

- **Stop it until the next login:** `launchctl bootout gui/$(id -u)/local.mcbridge`.
- **Stop it for good:** do the same, then delete the plist.

A LaunchAgent runs only while that user is logged in. If the Mac runs the server with nobody logged in, it needs a LaunchDaemon instead (the plist in `/Library/LaunchDaemons`, with a `UserName` key).

### Linux: systemd

Like the bot's own unit ([`ORACLE_CLOUD_DEPLOYMENT.md`](../ORACLE_CLOUD_DEPLOYMENT.md) §7). Save as `/etc/systemd/system/mcbridge.service`:

```ini
[Unit]
Description=mcbridge (Minecraft to Discord)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/minecraft/shrimp-fried-this-rice
ExecStart=/usr/bin/node ./src/minecraft/bridge/main.ts --config mcbridge.json
Restart=on-failure
RestartSec=5
User=minecraft

[Install]
WantedBy=multi-user.target
```

`User` must be able to read the server's log. If the server runs as a systemd unit too, add `Before=minecraft.service` (with that unit's name) under `[Unit]`, so `mcbridge` starts first. Then enable it with `sudo systemctl daemon-reload && sudo systemctl enable --now mcbridge`. Its output is in `journalctl -u mcbridge -f`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid config:` and a list | Fix each item; `mcbridge` exits until the config is right. |
| An alert: "mcbridge can't read the server log" | `logPath` points at a folder, or the user running `mcbridge` can't read the file. It posts at most once every 10 minutes; the console (or `mcbridge.log`) has the error. |
| `doesn't exist yet; waiting for it` in the console | Normal before a new server's first start. Otherwise `logPath` is wrong (check the backslashes on Windows). |
| `answered 404` or `answered 401` in the console | The webhook was deleted or its URL is wrong. `mcbridge` stops posting to it; fix the URL and restart. |
| A chat line from the server's name, starting **Steve:** | Discord refused the player's name as a sender, so the line went out under the server's name instead. |
| Nothing at all after the server restarts | The log may be on a share that doesn't report file identity (see Docker above). Restarting `mcbridge` picks the new log up. |
| `rate limited … dropped a post` | Discord was refusing posts for a while; some lines were lost. Very busy chat can do this. |
| An alert: "mcbridge can't read the crash-reports folder" | `crashReportsDir` points at a file, or the user running `mcbridge` can't list the folder. At most once every 10 minutes, like the log's. |
| A crash, but no "Crashed" alert | `crashReportsDir` isn't set or points at the wrong folder (a folder that doesn't exist looks the same as no crashes yet), or `mcbridge` wasn't running when the report was written. The crash's `ERROR` lines in the log are still posted as errors. |
| No "is up" message | `mcbridge` started after the server. Start it first. |

## Not yet

- Player avatars: skins for players who opt in, otherwise one of 10 pictures picked from the name (plan step A4b).
- Paper, Fabric and Forge log formats.
- Deaths, advancements, `/say` and `/me`.
- Discord to Minecraft chat.
