# Oracle Cloud Deployment Runbook

This document captures every step taken to deploy this bot to a free, permanent Oracle Cloud Infrastructure (OCI) VM, from account creation through the ongoing update workflow. Written so the process can be repeated (e.g. for a fresh VM) or handed to someone else picking up this project.

---

## 0. Before you begin: use a separate Discord Application for local development

**This is not optional — we learned this the hard way.** The VM's `.env` should use a bot token from a Discord Application **dedicated to production**, entirely separate from whatever token gets used on a developer's local machine for `npm run dev`.

**Why this matters:** Discord dispatches every interaction to *every* live process connected with the same bot token. If a local dev instance and the VM's production instance ever share one token, both process every command simultaneously against their own separate, silently-drifting `reminders.db` files. In practice this caused: reminders firing twice, `"Interaction has already been acknowledged"` errors, and a status embed that only updated on whichever process happened to have it tracked in its own database.

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
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name
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
DISCORD_GUILD_ID=your-test-server-id
```

Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

**Note:** unlike a PaaS platform with an ephemeral filesystem (Railway, Fly.io, etc.), a raw VM's disk is persistent by default — `reminders.db` needs no special volume configuration or environment-variable override; it's simply created at its normal default path and stays there indefinitely across deploys and reboots.

---

## 6. Installing dependencies and a first test run

### Install native build tools first

`better-sqlite3` compiles a native C++ binding via `node-gyp`, and this ARM-based VM likely has no pre-built binary available — it must compile from source, which requires a compiler toolchain:

```bash
sudo apt install -y build-essential python3
```

### Install project dependencies

```bash
npm install
```

### Approve `better-sqlite3`'s native build script

npm's newer `allowScripts` security policy will (starting with npm v12) block a package's install-time build scripts unless explicitly approved. Run this once so it's recorded in `package.json` and travels with the repo:

```bash
npm install-scripts approve better-sqlite3
```

**If this errors with `Unknown command: "install-scripts"`:** the local npm version doesn't have this subcommand yet (this can differ from the VM's npm version). The fallback is to add the equivalent entry directly into `package.json` by hand — functionally identical, and works regardless of npm version:

```json
{
  "allowScripts": {
    "better-sqlite3": true
  }
}
```

### Manual test run

```bash
npm start
```

Confirm the bot shows online in Discord and responds to a test command (e.g. `/ping`). Stop with **Ctrl+C** once confirmed — this is expected to take the bot offline, since Phase 7 below is what keeps it running permanently.

**Firewall note:** no inbound firewall/security list changes are needed. The bot only makes outbound connections to Discord; nothing needs to connect into the VM.

---

## 7. Setting up the systemd service

This keeps the bot running permanently in the background, restarts it automatically on crash, and starts it automatically on VM reboot.

### Find the required absolute paths

```bash
which node   # e.g. /usr/bin/node
pwd          # while inside the project folder, e.g. /home/ubuntu/your-repo-name
```

### Create the service file

```bash
sudo nano /etc/systemd/system/discordbot.service
```

```ini
[Unit]
Description=Posture and Hydration Reminder Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/your-repo-name
EnvironmentFile=/home/ubuntu/your-repo-name/.env
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
sudo systemctl enable discordbot
sudo systemctl start discordbot
```

### Verify

```bash
sudo systemctl status discordbot     # look for "active (running)"
journalctl -u discordbot -f          # tail live logs; Ctrl+C to stop watching (bot keeps running)
```

---

## 8. Switching to global slash commands

Needed once the bot is invited to more than one server — guild-scoped commands only appear in the single configured `DISCORD_GUILD_ID` server.

In `deploy-commands.ts`:
```typescript
// Before (guild-scoped):
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });

// After (global):
await rest.put(Routes.applicationCommands(clientId), { body: commands });
```

Global command changes can take up to an hour to propagate (often faster in practice). This also enables `/remindme` to be run directly in a DM with the bot, not just from within a server.

---

## 9. Ongoing deployment workflow

A helper script, kept on the VM itself (not part of the repo):

```bash
nano ~/deploy.sh
```

```bash
#!/bin/bash
cd ~/your-repo-name
git pull
npm install
sudo systemctl restart discordbot
echo "Bot restarted. Redeploying slash commands..."
npm run deploycommands
echo "Deploy complete. Checking status..."
sudo systemctl status discordbot --no-pager
```

```bash
chmod +x ~/deploy.sh
```

From then on, shipping an update is just:
```bash
~/deploy.sh
```

**Why this order:** the bot restart happens *before* `deploycommands`, so if the command-registration step ever fails (bad definition, transient API issue), the actual code fix has already taken effect — only a manual re-run of `npm run deploycommands` would be needed afterward, rather than the whole deploy being blocked.

**Why `reminders.db` is never at risk:** it's git-ignored, so `git pull` never touches, overwrites, or conflicts with it — the bot's actual data survives every future deploy untouched.

---

## Quick reference: common commands

| Task | Command |
|---|---|
| Check bot status | `sudo systemctl status discordbot` |
| Restart bot (after code changes) | `sudo systemctl restart discordbot` |
| View live logs | `journalctl -u discordbot -f` |
| Re-register slash commands | `npm run deploycommands` |
| Full deploy | `~/deploy.sh` |
| SSH into the VM | `ssh -i ~/Downloads/your-key-filename.key ubuntu@YOUR_PUBLIC_IP` |