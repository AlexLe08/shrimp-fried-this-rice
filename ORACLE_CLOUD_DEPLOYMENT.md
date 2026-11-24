# Oracle Cloud Deployment Runbook

This document captures every step taken to deploy this bot to a free, permanent Oracle Cloud Infrastructure (OCI) VM, from account creation through the ongoing update workflow. Written so the process can be repeated (e.g. for a fresh VM) or handed to someone else picking up this project.

---

## 0. Before you begin: use a separate Discord Application for local development

**This is not optional — we learned this the hard way.** The VM's `.env` should use a bot token from a Discord Application **dedicated to production**, entirely separate from whatever token gets used on a developer's local machine for `npm run dev`.

**Why this matters:** Discord dispatches every interaction to *every* live process connected with the same bot token. If a local dev instance and the VM's production instance ever share one token, both process every command simultaneously against their own separate, silently-drifting `bot.db` files. In practice this caused: reminders firing twice, `"Interaction has already been acknowledged"` errors, and a status embed that only updated on whichever process happened to have it tracked in its own database.

**The rule going forward:** the VM only ever uses the production Discord Application's token. Any local machine doing development work uses a second, separate Discord Application created just for that purpose (see the project README's Local Setup section for the exact intents/scopes/permissions it needs). Never copy the production `.env` to a local machine for active development use.

---

## 1. Account setup

1. Sign up for an OCI account at Oracle's Cloud site. A payment card is required for identity verification, but as long as usage stays within "Always Free" resource limits, there is no charge.
2. During signup, you'll be asked to choose a **home region**. This choice is **permanent** and cannot be changed later.
   - Always Free compute instances can only be created in your home region.
   - Larger, well-established regions (e.g. Ashburn, Phoenix, Frankfurt, London) generally have better availability of the free-tier hardware than smaller regions.
   - **We chose: Ashburn (US East)**.

---

## 2. Creating the VM instance

From the OCI Console: **Compute → Instances → Create Instance**.

### Image and shape
- **OS image:** Ubuntu (latest LTS, e.g. 24.04)
- **Shape:** the **Ampere (ARM-based) "Always Free" eligible** shape. This is critical — a different shape can incur real charges. Confirm the "Always Free eligible" label is shown before proceeding.

### Networking
- Networking requires a **public subnet** to assign a public IP.
  - If your account doesn't already have one, choose **"Create new virtual cloud network"** during instance creation — this automatically provisions a full VCN with both public and private subnets, an Internet Gateway, and correct default routing, with no manual network configuration needed.
- **Note:** if you selected "create new VCN" inline during instance creation, the "Assign a public IPv4 address" checkbox may appear greyed out. This is expected — Oracle automatically assigns a public IP as part of creating a new public subnet, so there's nothing to manually toggle. Proceed with instance creation as normal.

### Boot volume
- Leave at the **default 50GB**. This is actually Oracle's enforced *minimum* for Linux boot volumes — it cannot be set any smaller, and a smaller volume would only ever reduce guaranteed disk performance (which scales linearly with volume size), never improve it. 50GB is a small fraction of the 200GB total Always Free block storage allowance, leaving plenty of headroom for future projects.

### SSH keys
- Let Oracle generate a new SSH key pair, and **download the private key file immediately** — it cannot be re-downloaded later. Alternatively, upload an existing public key if you have one.

### Advanced options
- Left untouched. No initialization script, no custom availability configuration, no tags needed for this project.

### If you hit "out of host capacity"
- This is a common, temporary shortage of free-tier hardware in the chosen region — not a problem with your account or setup.
- Retry creation after a few minutes, or try a different **availability domain** within the same region.

### If the Public IP field shows "-" after creation
This can happen even after following the steps above. To manually assign one:
1. On the instance's detail page, go to the **Attached VNICs** tab, then click into the VNIC.
2. Go to the **IP Administration** tab (separate from the "Details" tab).
3. Find the primary private IP, click the **⋮ (three-dot) menu** next to it, and choose **Edit**.
4. In the side panel, assign an **Ephemeral** public IP (simplest choice — it persists through stops/restarts, only released if the instance is fully terminated). A **Reserved** public IP is also available if you ever want an IP that can be detached and reattached to a different instance.
5. Confirm the instance's main detail page now shows a real IP address in the **Public IP address** field.

---

## 3. Connecting via SSH (macOS)

```bash
chmod 400 ~/Downloads/your-key-filename.key
ssh -i ~/Downloads/your-key-filename.key ubuntu@YOUR_PUBLIC_IP
```

- `chmod 400` restricts the private key file so only you can read it — SSH refuses to use a key with overly-permissive file permissions.
- The default Ubuntu login username on OCI is `ubuntu`.
- On first connection, SSH will show a host-authenticity warning and ask to confirm (`yes/no`). This is expected for any brand-new server — type `yes` to proceed and trust it going forward.

**Troubleshooting note:** if a copy-pasted command produces a stray `bquote>` prompt in Terminal, a stray backtick character (often from copied markdown formatting) has confused the shell into thinking a command is unfinished. Press **Ctrl+C** to cancel and retype the command directly.

---

## 4. Installing Node.js 24

Using NodeSource's official repository (not `nvm`), so Node is installed system-wide and reliably visible to a `systemd` service later.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg

sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

NODE_MAJOR=24
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

sudo apt update
sudo apt install -y nodejs

node --version   # confirm v24.x.x
npm --version
```

---

## 5. Getting the code onto the VM

```bash
git --version   # confirm git is available; usually preinstalled on Ubuntu cloud images
git clone https://github.com/AlexLe08/shrimp-fried-this-rice.git
cd shrimp-fried-this-rice
```

### Create the production `.env` file directly on the VM

`.env` is git-ignored and is never pulled down by `git clone` — it must be created fresh on the server:

```bash
nano .env
```

Contents — using the **production** Discord Application's credentials specifically, never the local-dev one (see [Section 0](#0-before-you-begin-use-a-separate-discord-application-for-local-development)):
```env
DISCORD_TOKEN=your-production-bot-token-here
DISCORD_CLIENT_ID=your-production-application-client-id
```

Two more, `BACKUP_UPLOAD_URL` and `BACKUP_AGE_RECIPIENT`, turn on encrypted copies of `bot.db` off the VM; [section 10](#10-off-vm-backups-one-time-setup) sets them up. `DASHBOARD_PORT` turns on the dashboard; [section 12](#12-the-dashboard-cloudflare-tunnel-one-time-setup) sets it up. `DISCORD_CLIENT_SECRET` and `DASHBOARD_URL` turn on its login; [section 13](#13-dashboard-login-one-time-setup) sets them up.

Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

**Note:** unlike a PaaS platform with an ephemeral filesystem (Railway, Fly.io, etc.), a raw VM's disk is persistent by default — `bot.db` needs no special volume configuration or environment-variable override; it's simply created at its normal default path and stays there indefinitely across deploys and reboots.

---

## 6. Installing dependencies and a first test run

### Native build tools (a fallback)

`better-sqlite3` is a native C++ module. Version 13, the one in `package-lock.json`, ships prebuilt binaries, including `linux-arm64` for this VM, so installing it compiles nothing. npm still runs its `node-gyp` install step, which needs `python3` even then; that step only compiles from source when no prebuilt binary matches the machine, for example after a change of `better-sqlite3` version or platform, and that needs a compiler toolchain as well:

```bash
sudo apt install -y build-essential python3
```

### Install project dependencies

```bash
npm install
```

### Approve `better-sqlite3`'s native build script

The script checks for a matching prebuilt binary and builds only when there isn't one. npm's `allowScripts` security policy (npm v12 and up) blocks a package's install-time build scripts unless approved. The approval for `better-sqlite3` is already committed in `package.json` (`"allowScripts": { "better-sqlite3": true }`), so nothing needs doing on the VM. Don't run `npm install-scripts approve` there: it edits a tracked file, which the next deploy's `git reset --hard` discards.

### Manual test run

```bash
npm start
```

Confirm the bot shows online in Discord and responds to a test command (e.g. `/reminder list` or `/remindme`). Stop with **Ctrl+C** once confirmed — this is expected to take the bot offline, since section 7 below is what keeps it running permanently.

**Firewall note:** no inbound firewall/security list changes are needed. The bot only makes outbound connections to Discord; nothing needs to connect into the VM.

---

## 7. Setting up the systemd service

This keeps the bot running permanently in the background, restarts it automatically on crash, and starts it automatically on VM reboot.

### Find the required absolute paths

```bash
which node   # e.g. /usr/bin/node
pwd          # while inside the project folder, e.g. /home/ubuntu/shrimp-fried-this-rice
```

### Create the service file

```bash
sudo nano /etc/systemd/system/discordbotshrimp.service
```

```ini
[Unit]
Description=Posture and Hydration Reminder Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/shrimp-fried-this-rice
EnvironmentFile=/home/ubuntu/shrimp-fried-this-rice/.env
ExecStart=/usr/bin/node ./src/index.ts
Restart=on-failure
RestartSec=5
User=ubuntu

[Install]
WantedBy=multi-user.target
```

Key points:
- `EnvironmentFile` is what loads `.env`'s values into the process — systemd has no built-in awareness of `.env`/`dotenv` otherwise.
- `ExecStart` requires the **absolute** path to `node`, since systemd doesn't use your shell's `PATH`.
- `User=ubuntu` runs the bot as a normal, non-privileged user rather than root, limiting potential damage if the process were ever compromised.
- `Restart=on-failure` + `RestartSec=5` auto-restarts the bot 5 seconds after any unexpected crash.

### Enable and start it

```bash
sudo systemctl daemon-reload
sudo systemctl enable discordbotshrimp
sudo systemctl start discordbotshrimp
```

### Verify

```bash
sudo systemctl status discordbotshrimp     # look for "active (running)"
journalctl -u discordbotshrimp -f          # tail live logs; Ctrl+C to stop watching (bot keeps running)
```

---

## 8. Slash commands are global

`deploy-commands.ts` registers every command globally (`Routes.applicationCommands`), so they appear in every server the bot is in, and `/remindme` also works in a DM with the bot. Global changes can take up to an hour to reach every client (often much less). Earlier versions registered commands to one server through `DISCORD_GUILD_ID`; that variable is no longer used.

---

## 9. Ongoing deployment: GitHub Actions on merge to `main`

Deploys are automatic. The `deploy` job in `.github/workflows/ci.yml` runs after the `test` job on every push to `main` (in practice, every merged PR). It waits for the owner's approval through the repository's `production` environment, then SSHes into the VM and runs:

```bash
set -e
cd ~/shrimp-fried-this-rice
git fetch
git reset --hard origin/main
npm ci
restarted_at=$(date +%s)
sudo systemctl restart discordbotshrimp
npm run deploycommands || registration_failed=1
# then, until 60 s after the restart: wait for "Ready! Logged in as" in the service's journal since $restarted_at
sudo systemctl status discordbotshrimp --no-pager
# fail if the bot didn't log in or registration failed
```

(Abridged; the full script is in `ci.yml`.)

What it needs, set up once:
- The repository cloned at `~/shrimp-fried-this-rice` in `DEPLOY_USER`'s home on the VM (section 5), with its `.env`.
- Repository secrets `DEPLOY_HOST` (the VM's public IP), `DEPLOY_USER` (the VM user that owns the clone, `ubuntu` in this setup) and `DEPLOY_SSH_KEY` (a private key whose public half is in that user's `~/.ssh/authorized_keys`).
- The `production` environment (Settings → Environments) with the owner as required reviewer.
- `sudo systemctl` and `sudo journalctl` usable without a password prompt for that user (Ubuntu's default `ubuntu` user on OCI has passwordless sudo).

**Why this order:** the bot restarts *before* `deploycommands`, so if command registration fails (a bad definition, a transient API error), the code fix has already taken effect, and only `npm run deploycommands` needs re-running. A failed registration exits nonzero; the job still waits for the login and shows `systemctl status`, then goes red, so its log says both that registration failed and whether the new code is running.

**Why wait for the login:** `systemctl restart` returns as soon as the process starts, and a bot that then fails to log in (a bad token in `.env`, Discord down) still shows as active until it exits, after which `Restart=on-failure` starts it again. So the job polls `journalctl` every 2 s for the line `src/core/events/ready.ts` logs once the bot is logged in, counting only lines since the restart (`--since @<epoch seconds>`, so the VM's time zone doesn't matter). If it hasn't appeared 60 s after the restart, the job prints the bot's log since the restart and fails. The bot may still be retrying; check `journalctl -u discordbotshrimp -f`. The check is that the bot logged in once: a bot that logs in and then crashes still passes it. Changing that log line means changing the deploy too.

**Why `npm ci`:** it installs exactly what `package-lock.json` pins, the same install CI tested. Where the lockfile and `package.json` disagree, `npm install` would quietly reconcile them and install versions CI never ran; `npm ci` fails instead. It deletes `node_modules` and reinstalls everything; `better-sqlite3` 13 ships a prebuilt `linux-arm64` binary, so nothing is compiled. The old bot should keep running through the install, on the modules it loaded at startup, until the restart right after.

**If `npm ci` fails** (a registry or network error), `set -e` stops before the restart, so the running bot is unaffected. But `node_modules` may be left empty or partial, and the bot can't start again (after a crash, a reboot, OCI maintenance) until an install succeeds: re-run the deploy, or SSH in and run `npm ci` in `~/shrimp-fried-this-rice`.

**Why `bot.db` is never at risk:** it's git-ignored, and `git reset --hard` only resets tracked files, so the database (and `.env`) survive every deploy. Anything edited by hand in tracked files on the VM is discarded, though: change code only through a PR.

**Deploying by hand** (if Actions is down): SSH in and run the same commands as above.

---

## 10. Off-VM backups: one-time setup

The bot uploads each daily snapshot of `bot.db`, encrypted to your age public key, to an Object Storage bucket in this tenancy ([decision 0011](docs/decisions/0011-off-vm-backups.md); how it behaves is in the README's Design notes). It does nothing until the two `.env` values below are set. Set it up once, in this order. Oracle's console labels below are from its docs (read 2026-11-24); the bucket, retention rule and lifecycle policy paths were corrected from the owner's walk through the console that day.

1. **Two-factor sign-in** on the Oracle account, if it isn't on yet: whoever signs in to the console can delete the VM, the bucket and its retention rule together.
2. **An age key pair, on your own machine** (never on the VM): install `age` (`brew install age` on macOS), then run `age-keygen -o shrimp-backups.key`. It prints the public key (`Public key: age1…`), which goes in the VM's `.env`. The file is the identity that decrypts every copy: keep it in your password manager and an offline copy (printed, or on a USB stick). Losing it makes every copy useless, and nothing recovers it.
3. **The bucket:** Storage → Buckets → Create Bucket, in the VM's compartment, Standard tier, visibility **private** (the default). Leave versioning off: a retention rule can't be added to a bucket that has it. Encryption: **Encrypt using Oracle managed keys** (the default). The copies are already encrypted with age before they leave the VM, and a customer-managed key would add a Vault key and an IAM policy that, if the key were disabled or deleted, would leave every copy unreadable.
4. **The retention rule:** the bucket → Policies → Retention Rules → Create Rule, time-bound, **30 days**. Leave **Enable retention rule lock** unticked: locking can't be undone, not even by Oracle Support.
5. **Let Object Storage run lifecycle policies:** ☰ → Identity & Security → Policies, with the **root** compartment (the tenancy's own, at the top of the tree) picked on the left → Create Policy, then turn on **Show manual editor** (without it, the builder offers only templates) and enter `Allow service objectstorage-<region_identifier> to manage object-family in compartment <compartment_name>`. `objectstorage` stays as written: it names Oracle's service, not the bucket. Replace only the region identifier (your home region's, from Oracle's Regions and Availability Domains page, for example `us-ashburn-1`) and the bucket's compartment. A bucket in the root compartment itself takes `… to manage object-family in tenancy` instead.
6. **The lifecycle policy:** the bucket → Policies → Lifecycle Policy Rules → Create Rule, action **Delete**, after **60 days**. It must stay longer than the retention rule's 30 days, which it can't delete under.
7. **The write-only URL:** the bucket → Pre-Authenticated Requests → Create, target **Bucket**, access **Permit object writes**, with an expiry far ahead (it's required but has no limit; a year or more, with a reminder to renew it). Copy the URL straight away: it's shown only once. It ends in `/o/`.
8. **On the VM**, add both to `.env` and restart the bot:

   ```env
   BACKUP_UPLOAD_URL=https://objectstorage.<region>.oraclecloud.com/p/<token>/n/<namespace>/b/<bucket>/o/
   BACKUP_AGE_RECIPIENT=age1...
   ```

   ```bash
   sudo systemctl restart discordbotshrimp
   journalctl -u discordbotshrimp -f   # within a minute: "Uploaded an encrypted copy of daily-….db as …"
   ```

   The URL is a secret like the bot's token: anyone with it can upload to the bucket, though not list or delete what's there. If the log says `Off-VM backups are off: …`, one value is missing or malformed.
9. **Check one copy decrypts**, on your machine: download the newest object from the bucket in the console, then `age -d -i shrimp-backups.key -o restored.db daily-….db.age` and open `restored.db` with `sqlite3`.

**Renewing or replacing the URL** (it expired, was revoked, or the user who made it lost permission): create a new one as in step 7, put it in `.env` and restart the bot. If uploads stop for 48 hours, the bot DMs the application's owner once a day until one goes up again.

---

## 11. Restoring `bot.db`

A restore puts the database back as it was when the copy was made. Whatever changed since is lost: reminders created or edited, server settings, `/recruit` entries. Reminders and follow-ups sent since may go out once more when the bot starts, because their last send goes back too. So pick the newest copy from before the damage.

### Which copy

| What happened | Restore |
|---|---|
| A migration ran and damaged data | The newest `backups/pre-migration-v<N>-….db`, where `<N>` is the version the database was at before the deploy that ran it (one snapshot covers every migration that start applied). The bot runs every migration from `<N>` again on start, so the code on `main` must not repeat the damage first. Changing a merged migration is decided with the owner (CLAUDE.md). A migration that *failed* needs no restore: it rolls back, and the bot exits until a fix is deployed. |
| Rows lost or wrong (a bug, a mistaken command) | The newest `backups/daily-….db` from before it. The VM keeps only the newest 7, so damage older than that needs an off-VM copy (kept 30 to 60 days). |
| The VM or its disk is gone, or `backups/` is unusable | The newest off-VM copy, after rebuilding the VM (sections 2 to 7) without the backups' `.env` values yet. The rebuilt bot's first daily snapshot is of an empty database: with the values set, that's what would be uploaded, and the daily check would then wait a day from it. So delete `backups/daily-*.db` when the bot is stopped (step 2 below), and add the values after the restore: section 10's step 7 for a new upload URL (the old one was only in the lost `.env`, unless you kept it), then step 8. |

Names hold the copy's time in UTC (`daily-2026-11-24T03-00-00.000Z.db`); `ls -l ~/shrimp-fried-this-rice/backups` lists them. Off-VM copies are named `daily-<snapshot time>.sent-<upload time>.db.age`.

### Getting an off-VM copy onto the VM

Skip this for a copy already in `backups/`. On your machine:

1. Download the object from the bucket (the bucket → Objects) in the console.
2. Decrypt it: `age -d -i shrimp-backups.key -o restore.db daily-….db.age`
3. Copy it to the VM (the first command creates `backups/` on a rebuilt VM, owner-only like the bot makes it):

   ```bash
   ssh -i ~/Downloads/your-key-filename.key ubuntu@YOUR_PUBLIC_IP 'mkdir -m 700 -p ~/shrimp-fried-this-rice/backups'
   scp -i ~/Downloads/your-key-filename.key restore.db ubuntu@YOUR_PUBLIC_IP:~/shrimp-fried-this-rice/backups/
   ```

4. Delete `restore.db` from your machine: it's the database unencrypted.

### On the VM

In `~/shrimp-fried-this-rice`. Don't approve a deploy until you're done: it would restart the bot partway through.

1. **Check the copy** before stopping anything:

   ```bash
   node -e "const db = new (require('better-sqlite3'))(process.argv[1], { readonly: true, fileMustExist: true }); console.log('integrity:', db.pragma('integrity_check', { simple: true }), '| schema version:', db.pragma('user_version', { simple: true })); for (const { name } of db.prepare(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all()) console.log(name, db.prepare('SELECT count(*) AS n FROM \"' + name + '\"').get().n)" backups/COPY.db
   ```

   It prints `integrity: ok`, the schema version and each table's row count, through the project's own `better-sqlite3` (the VM may have no `sqlite3` command). Replace `COPY` with the copy's name, here and in step 4. Anything but `ok` means an older copy. Run it on `bot.db` too and compare the schema versions: the live one is the code's. A lower version is fine (the bot migrates it on start). A higher one means the copy is from before a [decision 0003](docs/decisions/0003-pre-release-schema-resets.md) reset or from newer code since reverted: the bot would run on tables its code doesn't match, so don't restore it without a plan agreed with the owner.
2. **Stop the bot:** `sudo systemctl stop discordbotshrimp`. Unlike a crash, a stop isn't restarted by `Restart=on-failure`.
3. **Set the current database aside, all its files together:**

   ```bash
   aside=backups/before-restore-$(date -u +%Y-%m-%dT%H-%M-%SZ)
   mkdir -m 700 "$aside"
   mv bot.db* "$aside"/
   ```

   `bot.db-wal` can hold most of the database (after a crash, everything since SQLite last copied it into `bot.db`), so `bot.db` without it isn't the whole database. A `-wal` left beside the restored file is replayed into it when it's opened. Tried locally on 2026-11-24: the restored copy came up with the old database's rows instead of its own, and the integrity check still said `ok`. Nothing prunes this folder, or a `backups/restore.db` copied from your machine, so delete both once the restored bot has run well for a while (`restore.db` is the database unencrypted).
4. **Copy the chosen copy in:** `cp backups/COPY.db bot.db`. Copy it rather than move it, so the snapshot stays where it was.
5. **Start it and watch:** `sudo systemctl start discordbotshrimp`, then `journalctl -u discordbotshrimp -f` until `Ready! Logged in as`. On start the bot makes the file owner-only and switches it to WAL. If its schema version is older than the code's, the bot saves a pre-migration snapshot and migrates it. A copy newer than the code is opened as is.
6. **Check in Discord:** `/reminder list` in a server you're in, and the `/reminder status` embed.

### Trying it (a drill)

[Decision 0011](docs/decisions/0011-off-vm-backups.md) asks for this to be tried once, and again after a large schema change or every few months, since a procedure that worked once can go stale. To try it without losing anything, restore a copy made right after the bot stops:

1. On your machine, take the newest off-VM copy through steps 1, 2 and 4 of "Getting an off-VM copy onto the VM", checking it with `sqlite3 restore.db 'PRAGMA integrity_check; PRAGMA user_version;'` before deleting it. This tries the key and the bucket without changing the VM.
2. On the VM, stop the bot (step 2), then copy its database as it is now:

   ```bash
   node -e "require('better-sqlite3')('bot.db', { readonly: true, fileMustExist: true }).exec(\"VACUUM INTO 'backups/drill.db'\")"
   ```

   (`VACUUM INTO` includes what's still in `bot.db-wal`.) Then follow steps 1, 3, 4, 5 and 6 with `backups/drill.db`. The bot is down for a minute or two, and reminders due in that time send when it starts.
3. Delete `backups/drill.db` and the `before-restore-…` folder, and record the date in `docs/roadmap.md`.

---

## 12. The dashboard: Cloudflare Tunnel (one-time setup)

The dashboard is served at `https://shrimp-fried-rice.alexle.dev` through a Cloudflare Tunnel ([decision 0008](docs/decisions/0008-dashboard-hostname-and-https.md); how it behaves is in the README's Production Deployment). `cloudflared` runs on the VM as its own systemd service, connects out to Cloudflare, and passes requests to the bot on `127.0.0.1`, so no port is opened in the VM's security list or iptables. The domain is on Cloudflare and the tunnel exists (created 2026-11-23); these steps were followed on the VM on 2026-11-24, and `/health` answered `ok` there and through the hostname. So far the bot serves only `/health`, which answers `ok`. The apt commands and the route's fields below are from Cloudflare's docs (read 2026-11-24); the install command in step 3 is shown by the dashboard and wasn't in the docs, so check it there.

1. **Turn the dashboard on in the bot.** Add a port to the VM's `.env` (8787 here; any free one), then restart and check it:

   ```env
   DASHBOARD_PORT=8787
   ```

   ```bash
   sudo systemctl restart discordbotshrimp
   journalctl -u discordbotshrimp -n 20          # "Dashboard listening on http://127.0.0.1:8787"
   curl -s http://127.0.0.1:8787/health; echo    # ok
   ```

   If the log says `The dashboard is off: …`, the port is malformed or something else already listens on it.
2. **Install `cloudflared`** from Cloudflare's apt repository ([pkg.cloudflare.com](https://pkg.cloudflare.com/index.html), Ubuntu 24.04, stable; it serves the VM's arm64 build itself):

   ```bash
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install cloudflared
   ```
3. **Connect it to the tunnel.** In Cloudflare's dashboard: Networking → Tunnels → the tunnel. Its setup page shows an install command for your operating system (Debian, 64-bit ARM). Step 2 already installed `cloudflared`, so run only the line that installs it as a service with the tunnel's token (`sudo cloudflared service install <token>`). The token is a secret like `.env`: anyone with it can run the tunnel and answer for the hostname. Type a space before the command, so bash leaves it out of your shell history (Ubuntu's default `HISTCONTROL=ignoreboth`). Then check:

   ```bash
   sudo systemctl status cloudflared    # active (running), and enabled so it starts at boot
   ```

   The tunnel shows as healthy in Cloudflare's dashboard.
4. **Route the hostname to the bot:** the tunnel → Routes → Add route → Published application. Subdomain `shrimp-fried-rice`, domain `alexle.dev`, no path, service URL `http://127.0.0.1:8787` (the port from step 1). Write `127.0.0.1`, not `localhost`: the bot listens on IPv4 only, and `localhost` can resolve to IPv6's `::1`. Leave the additional application settings as they are: the bot keeps idle connections open longer than `cloudflared`'s 90 s default, which a lower setting there would only shorten. No Access policy is needed.
5. **Check from your own machine:**

   ```bash
   curl -s https://shrimp-fried-rice.alexle.dev/health; echo    # ok
   ```

   Cloudflare's error page instead means the request reached Cloudflare but not the bot: check steps 3 and 4, and that the bot is running.

**Updating `cloudflared`:** the deploy doesn't touch it. Update it with apt, as it was installed; restarting it drops the dashboard for a few seconds:

```bash
sudo apt-get update && sudo apt-get install --only-upgrade cloudflared
sudo systemctl restart cloudflared
```

---

## 13. Dashboard login: one-time setup

The dashboard's login is Discord OAuth2 (how it behaves is in the README's Production Deployment). It needs section 12 done first, and stays off until both `.env` values below are set. These steps were followed on 2026-11-24.

1. **The redirect:** in the [Developer Portal](https://discord.com/developers/applications), the **production** application → OAuth2 → Redirects → Add Redirect: `https://shrimp-fried-rice.alexle.dev/auth/callback`, then Save Changes. Discord sends a login back only to a URL listed there.
2. **The client secret:** on the same page, Client Secret → Reset Secret, and copy it (it's shown once). It's a secret like the bot's token: with it and the client ID, anyone can complete logins as the application.
3. **On the VM,** add both to `.env` and restart the bot:

   ```env
   DISCORD_CLIENT_SECRET=...
   DASHBOARD_URL=https://shrimp-fried-rice.alexle.dev
   ```

   ```bash
   sudo systemctl restart discordbotshrimp
   journalctl -u discordbotshrimp -n 20   # no "Dashboard login is off: …" line
   ```

   `DASHBOARD_URL` is the address a browser uses, with no path. If the log says `Dashboard login is off: …`, one value is missing or malformed.
4. **Check:** open `https://shrimp-fried-rice.alexle.dev`, choose **Log in with Discord**, authorize, and the page names you. **Log out** returns it to the login link.

   If Discord's page says **Invalid OAuth2 redirect_uri**, the redirect in step 1 doesn't exactly match what the bot sends, or isn't on this application. The address bar on Discord's page shows both: `client_id` must be the Application ID of the application you edited, and `redirect_uri` (decoded) must be listed there exactly, with no trailing `/`, and saved. That was the cause on 2026-11-24: the redirect hadn't been saved on the production application yet.

**Replacing the secret** (it leaked, or was reset): reset it as in step 2, put the new one in `.env` and restart the bot. Sessions already started stay signed in; they don't depend on the secret.

**Signing everyone out** (after a leak, say): run this in the project folder on the VM. It deletes every session, so every browser's cookie stops working:

```bash
node -e "const db = require('better-sqlite3')('bot.db', { fileMustExist: true }); console.log(db.prepare('DELETE FROM dashboard_sessions').run().changes, 'sessions ended'); db.close();"
```

---

## Quick reference: common commands

| Task | Command |
|---|---|
| Check bot status | `sudo systemctl status discordbotshrimp` |
| Restart bot (after code changes) | `sudo systemctl restart discordbotshrimp` |
| View live logs | `journalctl -u discordbotshrimp -f` |
| Re-register slash commands | `npm run deploycommands` |
| Full deploy | merge a PR to `main`, then approve the `production` deployment |
| Restore `bot.db` from a copy | section 11 |
| Check the dashboard's tunnel | `sudo systemctl status cloudflared` |
| SSH into the VM | `ssh -i ~/Downloads/your-key-filename.key ubuntu@YOUR_PUBLIC_IP` |