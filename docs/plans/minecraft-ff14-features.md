# Plan: Minecraft bridge, collection tracker, Lodestone news, membership follow-ups, and dashboard

The design for the feature tracks in [`docs/roadmap.md`](../roadmap.md)'s Next up. Planning only; no feature code has been written yet. It was drafted on 2026-11-16 against an older `main` (as of #6) and brought up to date with `main` as of #28 on 2026-11-20.

How to work through it:

- CLAUDE.md's workflow applies to every step: a worktree per PR, `scripts/check.sh`, the `reviewer` agent, a Deploys line, and the README and the roadmap's Done entry updated in the feature's own PR. This plan doesn't repeat those rules; see [Conventions](#conventions-specific-to-this-plan).
- The PRs each track names add its decision records (from [`../decisions/0000-template.md`](../decisions/0000-template.md), with the **Why** left as `TODO(Alex)`).
- Ask the owner for each [input](#inputs-still-needed-from-the-owner) when you reach the step that needs it, not all up front.
- Facts marked **unverified** must be checked before code relies on them. Facts marked **verified 2026-11-20** were checked against the source named.
- If the plan turns out wrong, or a simpler design fits better, say so and update this file in the same PR rather than silently diverging from it.

Tracks A, B, C and E are independent apart from two shared pieces: decision record 0004 (feature storage modules) comes first, from [`refactor.md`](refactor.md)'s task 3, and E3's buttons use C4's button routing. Other shared pieces are noted where they occur. Track D (the dashboard) comes after them.

| Track | What it adds | Where it runs |
|---|---|---|
| **A. Minecraft bridge** | Server start/stop, in-game chat, and real errors posted to Discord | A small helper process on the machine that runs the Minecraft server |
| **B. Collection tracker** | `/collection` (members) and `/collectionadmin` (mods) backed by the bot's SQLite database. FF14 mounts are the first collection. | The existing bot on the Oracle Cloud VM |
| **C. Lodestone news** | FF14 Lodestone posts sent to a channel, plus Discord scheduled events for maintenance and other dated announcements | The existing bot on the Oracle Cloud VM |
| **D. Web dashboard** (later) | A site to view and change the bot's settings and data | The VM, inside the bot process |
| **E. Membership follow-ups** | A 30-day role check-in for members who picked a role at onboarding, and a moderator list of trial FC members with a 30-day reminder | The existing bot on the Oracle Cloud VM |

## Decisions already made by the owner

- Minecraft server is **vanilla today**; Paper, Fabric and Forge/NeoForge may follow. The parser must be built to take more formats.
- Minecraft hosts will be **Windows, macOS and Linux**. The helper must run on all three.
- Mount data lives in the **bot's SQLite database** (not Google Sheets). The current spreadsheet is imported once; a CSV export gives a spreadsheet view on demand.
- Mount list is **curated now, expandable later**: start from the mounts in the existing spreadsheet, with categories so groups can be bulk-added.
- Members edit their own entries. Editing someone else's requires a mod.
- The commands are generic (**`/collection`**, not `/mounts`), so a server can track anything (minions, other games) without new code.
- Lodestone news is posted **by the bot itself** (replacing the third-party webhook the server uses today), so the bot can also create **Discord scheduled events** for maintenance. Other dated announcements (PvP season or series start, housing demolition) should be able to become events too.
- Events for other announcements have a **per-server mode: off, manual, or auto**. Auto tries to parse the dates and create the event without a mod; the owner wants to try it and switch back to manual if it proves unreliable.
- A **web dashboard** is wanted for existing and planned features. It is scheduled after the feature tracks A, B, C and E (reasons in Track D).
- The server uses **Discord onboarding** to have new members choose a Free Company or Guest role. Thirty days after choosing, the member is reminded in a chosen channel to check that the role is still right.
- Moderators record **trial FC members by in-game name** (some have no Discord account) with a short editable note. Thirty days later the bot pings moderators to check on them and promote them in game.

Added on 2026-11-20, when the plan was brought onto `main`:

- **Feature storage modules.** Each feature's queries live in its own module, sharing the database handle that `src/storage.ts` opens, rather than all of them growing `storage.ts`. `storage.ts` keeps the handle, the `CREATE TABLE`s, `MIGRATIONS` and the limits. This changes CLAUDE.md's "`src/storage.ts` is the only module that touches SQLite", so decision record 0004 and the CLAUDE.md update come with [`refactor.md`](refactor.md)'s task 3, which also moves the limits to each area's storage module (owner, 2026-11-20). That refactor also moves `src/` into feature folders; its task 2 updates this plan's paths.
- **Mod-only collection commands are a separate command.** `/collection` is what members use; `/collectionadmin` holds everything that changes a server's collections or someone else's entries, with **Manage Server** as its default permission. A server grants it to a mod role in Server Settings → Integrations, as with `/recruit`. This follows CLAUDE.md's rule that commands changing server settings set `setDefaultMemberPermissions`, and drops the custom mod-role setting.
- **These tracks go ahead of** the roadmap's earlier Next up items (attachments on reminders, the `/remindme` rework).

## Inputs still needed from the owner

Ask for each before the step that needs it.

1. **A real `logs/latest.log` sample** from the vanilla server covering: a full startup, a chat line, a join and leave, the harmless "floating" warnings, and (if one exists) a real error. These become test fixtures. Needed for A2.
2. **The existing mount spreadsheet's layout** (or a CSV export): what the rows and columns are, and how members are named in it (character name, nickname, Discord name). Needed for B5. Do not commit member data to the repo.
3. **Discord webhook URL(s)** for the Minecraft channel(s), created by the owner in Server Settings → Integrations → Webhooks. These are secrets: they live only in the helper's config file, which A5 adds to `.gitignore` (`mcbridge*.json`), like `.env`.
4. **For Lodestone news**: which region's Lodestone to follow (NA, EU, FR, DE, JP), which channel gets the posts, and which data center the group plays on (used to filter maintenance events). All are set at runtime with commands. The bot also needs the **Create Events** permission added to its role in the server.
5. **For membership follow-ups**: the **Server Members Intent** switched on in the Discord Developer Portal for both the production and the dev application (Bot tab). This must be done **before** the code that requests it is merged; see Track E. Channels, roles and day counts are set at runtime with commands.
6. **For the dashboard, when Track D starts**: the D0 decisions, including how the site gets HTTPS for free (see Track D).

---

## Track A: Minecraft bridge

Decision record (in the first Track A PR): a separate helper process that posts through a webhook, kept in this repository, rather than anything that uses the bot's token.

### The constraint that shapes the design

The bot runs on the Oracle Cloud VM. The Minecraft server runs on the owner's own machine. The bot cannot see the Minecraft log, so something must run next to the Minecraft server.

That something must **not** log in with the production bot token. `README.md` and `CASESTUDY.md` both record the incident where two processes shared one token and every interaction was handled twice.

### Chosen design: a log-tailing helper that posts to a Discord webhook

```
Minecraft server ──writes──> logs/latest.log ──tailed by──> mcbridge ──HTTPS POST──> Discord webhook ──> channel
```

- `mcbridge` is a standalone Node script in this repo with **zero runtime dependencies** (only `node:fs`, `node:path`, global `fetch`). The Minecraft host needs Node 24 and a copy of the repo, but no `npm install`, so `better-sqlite3` never has to compile on Windows.
- It reads the log file rather than wrapping the server process, so it works with any launcher, start script or hosting panel on any OS.
- It posts through a webhook URL, so no bot token leaves the VM and the VM needs no inbound firewall change.

What the owner should know about this choice: messages arrive from the **webhook**, not from the bot user. The webhook can be given the bot's name and avatar. The upside is that each chat line can carry the player's own name as the sender.

### Alternatives considered

| Option | Why not (for now) |
|---|---|
| Helper sends events to an HTTP endpoint on the bot | Needs an inbound port opened in both the OCI security list and the VM's iptables, plus TLS or a shared secret. Events are lost whenever the bot restarts. Worth revisiting only if the bot needs to *know* server state (see A-later). |
| Helper logs in with the bot token | Forbidden by the two-process rule above. |
| Off-the-shelf plugin or mod (DiscordSRV and similar) | None exist for a vanilla server, which is what runs today. |

### Layout

Code goes under `src/mcbridge/`. `src/index.ts` only scans `src/commands` and `src/events`, so the bot never loads it. Being under `src/`, it is also type-checked, linted (including the promise rules) and formatted like the rest. It deploys to the VM with every merge and sits there unused, so a Track A PR's Deploys line is "no runtime change for the bot".

```
src/mcbridge/
  main.ts            # entrypoint: load config, wire tailer -> parser -> classifier -> sender
  config.ts          # load + validate config file / env
  tailer.ts          # polling file tailer
  parseLine.ts       # raw line -> { time, thread, level, logger?, message } | continuation
  classify.ts        # parsed entry -> bridge event | null
  sender.ts          # queue, batching, rate limiting, webhook POST
  formats.ts         # per-flavor line-prefix patterns
test/mcbridge/
  fixtures/*.log     # real log samples, one per server flavor
```

Add to `package.json`: `"mcbridge": "node ./src/mcbridge/main.ts"`. Add `src/mcbridge/main.ts` to the coverage `exclude` list in `vitest.config.ts`, for the same reason as `src/index.ts` (an entrypoint that only wires the tested parts together), and say so in the README's Testing section.

The code must stay within erasable TypeScript syntax (`erasableSyntaxOnly`), because Node runs it by type-stripping.

### Configuration

A git-ignored JSON file, path passed as `--config`. One helper process per Minecraft server.

```jsonc
{
  "serverName": "Survival",                 // shown in messages; lets several servers share a channel
  "logPath": "/path/to/server/logs/latest.log",
  "crashReportsDir": "/path/to/server/crash-reports",   // optional
  "format": "auto",                         // auto | vanilla | paper | forge
  "webhooks": {
    "chat": "https://discord.com/api/webhooks/...",     // start/stop, join/leave, chat
    "alerts": "https://discord.com/api/webhooks/..."    // errors; may be the same URL
  },
  "ignorePatterns": [],                     // extra regexes added to the built-in ignore list
  "playerAvatars": false                    // if true, set avatar_url from a public skin-head service
}
```

Add `mcbridge*.json` to `.gitignore` in A5.

### Log line formats

Normalise every flavor to `{ time, thread, level, logger?, message }`. Lines that match no prefix are **continuation lines** (stack traces) and attach to the previous entry.

| Flavor | Prefix shape | Status |
|---|---|---|
| Vanilla | `[12:34:56] [Server thread/INFO]: message` | Unverified; confirm against the owner's sample |
| Fabric | Same as vanilla | Unverified; confirm with a fixture before claiming support |
| Paper / Spigot | Same as vanilla in `latest.log`; console shows `[12:34:56 INFO]: message` | Unverified; confirm with a fixture |
| Forge / NeoForge | `[12Nov2026 12:34:56.789] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: message` | Unverified; confirm with a fixture |

Only vanilla ships in the first version. Each further flavor is one new pattern in `formats.ts` plus one fixture file; nothing else should need to change.

### Events (vanilla messages; confirm each against the sample)

| Event | Trigger | Goes to |
|---|---|---|
| Server started | `Done (8.123s)! For help, type "help"` | chat |
| Server stopping | `Stopping server` | chat |
| Player joined / left | `Steve joined the game` / `Steve left the game` | chat |
| Chat | `<Steve> hello`, optionally prefixed `[Not Secure] ` | chat, with `username` set to the player |
| Error | Any entry at `ERROR` or `FATAL`, with its stack trace | alerts |
| Crash | A new file appears in `crashReportsDir` | alerts |
| Important warning | `WARN` entry matching the allow-list below | alerts |

Chat matching must be anchored at the start of the message, so a player typing `<Admin> hi` cannot impersonate another sender.

Later additions, not in the first version: deaths, advancements, `/say` and `/me` lines.

### Telling real issues from noise

This is the owner's explicit requirement: no alerts for routine warnings such as `was kicked for floating too long!`.

1. **`INFO` and below**: never an alert.
2. **`WARN`**: ignored by default. Alert only if it matches the allow-list:
   - `FAILED TO BIND TO PORT` (vanilla logs this at `WARN`, and it means the server did not come up)
   - `Can't keep up! Is the server overloaded?`, but only when it repeats (for example 5 times in 5 minutes)
3. **`ERROR` / `FATAL`**: alert, unless it matches the ignore list.
4. **Ignore list** (built-in, extendable through `ignorePatterns`): `was kicked for floating too long`, `moved too quickly!`, `moved wrongly!`. Grow this from the owner's real log.
5. **Stack traces**: collect continuation lines into the entry they belong to. Flush when the next prefixed line arrives or after about one second of silence. Post as one code block, truncated to fit 2000 characters.
6. **De-duplication**: the same normalised message within 10 minutes is posted once, then summarised as a count. Cap alerts at a few per minute overall.

`classify.ts` should be a pure function over parsed entries so every rule above is unit-tested from fixtures.

### Tailer behaviour

- **Poll, do not use `fs.watch`**: `fs.watch` behaves differently on each OS. Every 500 ms, `stat` the file and read any bytes past the last offset.
- **Rotation**: vanilla renames `latest.log` on startup and creates a new one. If the file is missing, keep polling. If its size is smaller than the last offset, restart from offset 0.
- **Startup**: begin at the end of the file so old history is not replayed. Scan the existing content once, without posting, to learn whether the server is currently up.
- **Partial lines**: buffer until a newline arrives.

### Sender behaviour

- Every payload sets `allowed_mentions: { parse: [] }`, so `@everyone` typed in Minecraft chat pings nobody. Execute Webhook supports `allowed_mentions` (verified 2026-11-20, [Discord: Execute Webhook](https://docs.discord.com/developers/resources/webhook)).
- The per-message `username` is a player's name. Discord refuses a webhook **name** containing `clyde` or `discord` (case-insensitive) and caps it at 80 characters (verified 2026-11-20, same page, Create Webhook). Whether the same rule applies to the per-message `username` is **unverified**; test it in A4 or A5 against the dev server. Until then, fall back to the configured server name when a send with the player's name is refused, rather than dropping the line.
- Batch lines that arrive within about a second into one message.
- Honour HTTP 429 by waiting `retry_after` and retrying. Drop the oldest queued chat lines if the queue grows past a bound; never drop alerts.
- A failed POST logs to the console and does not crash the helper.

### Running it on each OS

Document in a new `docs/MINECRAFT_BRIDGE.md`: install Node 24, copy the repo, create the webhook, write the config, then auto-start.

| OS | Auto-start |
|---|---|
| Windows | Task Scheduler entry at logon, or one launcher `.bat` that starts the helper and then the server |
| macOS | `launchd` plist, or one launcher script |
| Linux | `systemd` unit, modelled on the bot's own in `ORACLE_CLOUD_DEPLOYMENT.md` |

The helper must be running before the server starts, otherwise the "started" message is missed.

### Steps

- **A1. Parser and classifier.** `formats.ts`, `parseLine.ts`, `classify.ts` with fixture-driven tests. No I/O.
- **A2. Fixtures from the owner's real log.** Adjust patterns and the ignore list to match.
- **A3. Tailer.** Tested against temp files: append, truncate, delete and recreate, partial lines.
- **A4. Sender.** Tested with a stubbed `fetch`: batching, 429 handling, mention suppression, truncation, the username fallback.
- **A5. `main.ts`, config, `npm run mcbridge`, the `.gitignore` entry.** Manual end-to-end test against the owner's server and a test channel.
- **A6. `docs/MINECRAFT_BRIDGE.md`**, with the README's Features, Project Structure and Available Scripts updated in the same PR.

### A-later (not planned in detail)

- `/minecraft status` in the bot, using a Server List Ping to the server's public address. Needs no helper.
- Discord-to-Minecraft chat relay through RCON.
- Bot-side ingest endpoint, if messages must come from the bot user itself.

---

## Track B: Collection tracker

### Shape

Two generic commands: `/collection`, for members, and `/collectionadmin`, for mods. A server can hold several named collections, created by mods at runtime. "FF14 Mounts" is simply the first one a mod creates; nothing in the code is specific to FF14 or to mounts.

Vocabulary used below: a **collection** (for example "FF14 Mounts") holds **items** (for example "Kirin"), grouped by **category** (for example "Extreme Trials"). An **entry** records that a member has an item.

### Framework changes needed first

Autocomplete support is already on `main` (#22). `Command.autocomplete`, the routing in `src/events/interactionCreate.ts` ahead of the cooldown with a failure logged, and `getFocused`/`respond` in `test/mockInteraction.ts` all exist, and `/reminder`'s label autocomplete (`test/commands/reminderCore/guildreminderAutocomplete.test.ts`) is the pattern to follow.

Still needed, each in the PR that first uses it: `test/mockInteraction.ts` gains `getRole` (E1, `/recruit config`), a focused-option *name* (B3, for commands with more than one autocomplete option), `getSubcommandGroup` (B4, the `item` and `entry` groups) and `getAttachment` (B4, import).

### Schema

One new migration appended to `MIGRATIONS` in `src/storage.ts` (decision 0002), not new `CREATE TABLE IF NOT EXISTS` statements. The tables are new, so the change is additive and needs no reset. Follow the existing conventions: snake_case columns, and a hand-written interface per table, changed in the same commit as its columns.

```sql
CREATE TABLE collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,                    -- display name, e.g. 'FF14 Mounts'
    name_key TEXT NOT NULL,                -- lower-cased, trimmed
    UNIQUE(guild_id, name_key)
);

CREATE TABLE collection_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    name TEXT NOT NULL,                    -- display name
    name_key TEXT NOT NULL,                -- lower-cased, trimmed; used for uniqueness and autocomplete
    category TEXT NOT NULL DEFAULT 'Other',-- e.g. 'Dawntrail Extreme Trials'
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(collection_id, name_key)
);

CREATE TABLE collection_members (
    collection_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (collection_id, user_id)
);

CREATE TABLE collection_entries (
    item_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    obtained_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,              -- who made the change; differs from user_id when a mod edits
    PRIMARY KEY (item_id, user_id)
);
```

- A row in `collection_entries` means "has it". Removing the row means "does not have it".
- `collection_members` exists so a member with nothing obtained still appears in "who needs this". A member is added on their first change or by `/collection join`.
- Deleting a collection must delete its items, members and entries; deleting an item must delete its entries. Do it with deletes inside one transaction, tested. The alternative, `ON DELETE CASCADE`, needs `PRAGMA foreign_keys = ON` on every connection. That pragma can't be set inside a transaction (where migrations run), and it changes the behaviour of the whole connection for one feature.
- Cap collections per server and items per collection (for example 10 and 500), next to `MAX_REMINDERS_PER_GUILD` in `storage.ts`.

Where the code goes: a feature storage module (see the owner's decisions), for example `src/collectionStorage.ts`. Its exact name and how it gets the handle follow decision record 0004, from [`refactor.md`](refactor.md)'s task 3. `__resetForTests()` clears the new tables.

### Commands

Both are guild-only (`setContexts(InteractionContextType.Guild)`).

`/collection` has **no** `setDefaultMemberPermissions`, because every member uses it, and each of its subcommands changes only the caller's own entries.

| Command | Behaviour |
|---|---|
| `/collection add item` | Marks an item as obtained for you. Autocomplete lists items you don't have. |
| `/collection remove item` | Unmarks it. Autocomplete lists items you have. |
| `/collection view [collection] [member]` | Embed of obtained and missing items grouped by category, with a count such as 14 / 32. Anyone may view anyone. |
| `/collection needs item` | Lists members who still need that item. Not in the original request; included because it is what the spreadsheet is used for when planning farm runs. Drop it if unwanted. |
| `/collection join [collection]` | Adds you to a collection with nothing obtained. |
| `/collection list [collection]` | Shows a collection's items by category. |

`/collectionadmin` sets `setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)`. The owner can grant it to a mod role in Server Settings → Integrations, which needs no code. Its replies are ephemeral, except an export's attachment, which goes only to the caller anyway.

| Command | Behaviour |
|---|---|
| `/collectionadmin create name` | Creates a new collection in this server. |
| `/collectionadmin rename collection name` | Renames a collection. |
| `/collectionadmin delete collection` | Deletes a collection and all of its data. Confirm before deleting. |
| `/collectionadmin item add collection name category` | Adds an item to a collection. |
| `/collectionadmin item remove item` | Removes an item and everyone's entry for it. Confirm before deleting. |
| `/collectionadmin item import collection file` | Bulk-adds items from a CSV attachment (`name,category`). This is the "expandable" path. |
| `/collectionadmin entry add member item` / `entry remove member item` | Changes another member's entry. Records the mod in `updated_by`. |
| `/collectionadmin export [collection]` | Replies with a CSV attachment: one row per member, one column per item. |

Keeping the generic commands pleasant to use:

- **`item` autocomplete searches every collection in the server.** Its value is the item's ID, and its label adds the collection name only when the server has more than one collection (`Kirin (FF14 Mounts)`). So `add`, `remove` and `needs` never need a separate `collection` argument.
- **`[collection]` is optional wherever it appears in brackets.** With one collection in the server it defaults to that one. With several and none given, reply asking the caller to pick.
- `collection` is also an autocomplete option, since collections are created at runtime.
- Autocomplete is not a security boundary. `execute` must re-validate that the item ID belongs to the caller's server, and that the target on `/collection` is the caller.

### Display

- Put the embed builder in its own module as a pure function, like `src/reminderEmbed.ts`.
- Discord limits: 1024 characters per field value, 25 fields, 6000 characters per embed. Split a long category across several fields. If the whole list does not fit, show missing items in full and obtained items as counts per category.
- Any reply that names another member sets `allowedMentions: { parse: [] }` so nobody is pinged.

### Importing the existing spreadsheet

The database is on the VM, so the import is a Discord command taking a CSV attachment, not a local script.

The catalog half is settled: `/collectionadmin create name:FF14 Mounts`, then `/collectionadmin item import` with `name,category`.

The member half depends on input 2 above. The open problem is mapping whatever the sheet calls each person to a Discord user ID. Two workable routes; choose after seeing the sheet:

- The owner adds a Discord user ID column to the export, and a `/collectionadmin` import subcommand reads it.
- Skip member import; members tick their own items with the bulk editor (B6).

### Steps

- **B2. Feature storage module** (or the module 0004 names) with the migration, its tests (delete cascade in a transaction, caps, `__resetForTests`). (B1, autocomplete, shipped in #22.)
- **B3. `/collection`**: add, remove, view, join, needs and list, the item and collection autocompletes, and the embed builder, with tests.
- **B4. `/collectionadmin`**: create, rename, delete, item add, remove and import, entry add and remove, with tests.
- **B5. `/collectionadmin export`** and the member import chosen above.
- **B6. Optional: `/collection edit`**, a bulk editor using multi-select menus (25 options per menu, 5 menus per message, so one message per group of categories). Handle the component interactions with a collector inside the command, so `interactionCreate.ts` needs no further routing.
- Each of B3 to B6 updates the README's Commands, Features and Project Structure in its own PR. The README retitle (the bot is no longer only posture and hydration) goes in E1, the first PR with a non-reminder feature, with `CASESTUDY.md`'s Overview sentence to match.

### B-later: external data sources (optional, per collection)

The tracker above needs no external service. An outside source could help with two separate jobs, and the options differ for each. Any integration should be an optional add-on attached to one collection, because a generic collection (another game, anything hand-made) will never have one.

Checked on 2026-11-20: `https://ffxivcollect.com/api/mounts` answers, and each mount carries `name`, `patch`, `order`, `image`/`icon` and `sources` (`[{ "type": "Event", "text": "The Starlight Celebration (2026)" }]`), so `sources[].type` could give categories. Its terms of use, rate limits and character endpoints are **unverified**. The rest of this section is **unverified**, from memory.

Job 1, **filling the catalog** (the list of mounts, with categories):

| Source | What it offers | Trade-off |
|---|---|---|
| FFXIV Collect API | Mount list with how each is obtained (`sources`) | The first candidate; gives categories for free. |
| XIVAPI (v2) | Game data straight from the game's own tables: every mount's name, ID and icon | No "how to obtain" information, so categories would still be hand-assigned. |
| `xivapi/ffxiv-datamining` on GitHub | The same game tables as CSV files | No runtime dependency at all: download once, convert to an import CSV. Also no acquisition info. |
| Garland Tools / community wikis | Acquisition details | Unofficial or unstructured; awkward to parse and easy to break. |
| Hand-made CSV (the current plan) | Exactly the mounts the group cares about | Manual, but small for a curated list and works for any game. |

Job 2, **reading what a character owns** (so members link a character instead of ticking boxes):

| Source | What it offers | Trade-off |
|---|---|---|
| FFXIV Collect API | A character's owned and missing mounts by Lodestone ID | Depends on that site staying up and on the character's Lodestone profile being public. |
| Self-hosted Lodestone parser (for example `nodestone` from the XIVAPI project) | Reads the official Lodestone character pages directly | No third party in between, but the bot then scrapes Square Enix's site itself: slower, breaks when the page layout changes, and may be throttled from a cloud IP. Check whether it parses the mounts page at all. It would also be a runtime dependency, which is the owner's decision. |
| Manual entry (the current plan) | Always works, for any game | Relies on members keeping it up to date. |

There is no official Square Enix API. Every ownership source ultimately reads the Lodestone, so all of them fail for members whose profile is private.

Recommended fallback order if FFXIV Collect is not suitable: seed the catalog from a one-time CSV built from the datamining files or XIVAPI, and keep ownership manual. Only take on a self-hosted Lodestone parser if manual upkeep proves to be a real problem.

---

## Track C: Lodestone news and scheduled events

Decision record (in C2's PR): the bot fetches from an outside service (the Lodestone News API), and creates Discord scheduled events. Both are firsts for the bot.

### What it does

1. Polls the FF14 Lodestone for new posts and sends each one to a configured channel as an embed: title, link, summary, and header image where the post has one.
2. For maintenance posts, creates a **Discord scheduled event** covering the maintenance window, and updates it if the window changes.
3. For other dated announcements, lets a mod turn a post into a scheduled event with one click.

### Data source

| Source | What it is | Role |
|---|---|---|
| Lodestone News API (`lodestonenews.com`, community-run) | JSON arrays per category. Checked 2026-11-20 with `GET https://lodestonenews.com/news/<category>?locale=na`: every item has `id`, `url`, `title` and `time` (ISO 8601, UTC); `topics` adds `image` and `description`; **`maintenance` adds `start` and `end`** (ISO, UTC). `notices`, `topics` and `maintenance` answered; `feed` returned topics. The other categories (`updates`, `status`, `developers`), the other locales, and terms or rate limits are **unverified**. | Primary. Structured maintenance times are what make automatic events practical. |
| Official Lodestone Atom feeds (`.../lodestone/news/news.xml`, `topics.xml`) | Square Enix's own feeds. **Unverified.** | Fallback for posting news. No structured maintenance times. |
| Scraping Lodestone HTML | The pages themselves | Last resort; breaks when the layout changes. |

Put the source behind a small interface (`fetchItems(category, locale) -> NewsItem[]`), so the fallback, or a feed for a different game, can be added without touching the poller.

What the 2026-11-20 sample showed about maintenance posts, which the rules below rely on:

- Small maintenances are common: Mog Station, Online Store, the Lodestone, the Companion app, the Forums.
- A change to a window arrives as a **new post with a new ID**: "All Worlds Maintenance (Nov. 9-10): Follow-up" moved the end from 10:00 to 09:15, and "…: Completed Early" did the same for the Lodestone. Different maintenances can share exactly the same window (the All Worlds and Companion app follow-ups did), so matching a follow-up by overlapping window alone would edit the wrong event. Match on the title with the suffix after the last `:` removed, **and** an overlapping window.
- Emergency maintenance says so in the title ("Companion App Emergency Maintenance").

Where a post's **body** comes from is still open: no item carried one; topics have only a short `description`. Auto mode (C5) needs the body, so C0 decides whether the bot fetches the post's own Lodestone page, and how that fails.

### Layout

```
src/news/
  source.ts          # NewsSource interface + NewsItem type
  lodestoneNews.ts   # primary source client: fetch with timeout, normalise to NewsItem
  poller.ts          # timer, shared fetch per locale, fan-out to subscribed servers
  newsEmbed.ts       # pure embed builder
  maintenanceEvents.ts  # decide create / update / skip for scheduled events
src/newsStorage.ts   # tables below (a feature storage module, per decision 0004)
src/commands/news/lodestone.ts
```

### Polling

- One timer, started from `src/events/ready.ts` beside `startScheduler`. Reuse `src/scheduler.ts`'s patterns: one check at a time (a tick that finds the last one running skips), `runCheck` so a throwing check is logged rather than an unhandled rejection, and a `stopping` flag.
- **Shutdown:** `src/shutdown.ts` stops the poller and **waits for a fetch or post under way**, as it does for `stopScheduler`, before it destroys the client and closes the database. Nothing may touch the database after it closes.
- Poll every 5 to 10 minutes. Fetch **once per locale in use**, then fan out to every subscribed server. Never fetch per server.
- Set a request timeout (`AbortSignal.timeout`) and a generic `User-Agent`. A failed fetch logs and waits for the next tick.
- A send Discord refuses for good (the channel is gone, missing permissions) follows the scheduler's rule: it must not be retried every tick. A deleted channel removes or disables that subscription and shows it in `/lodestone list`.
- **No backlog flood**: when a server subscribes, it receives only posts that appear after that moment. When the bot first sees a category, it records the current items as seen without posting them.
- Record each delivery per server so a restart mid-batch neither repeats nor skips a post.

### Schema

One new migration appended to `MIGRATIONS`.

```sql
CREATE TABLE news_subscriptions (
    guild_id TEXT NOT NULL,
    category TEXT NOT NULL,                -- topics | notices | maintenance | updates | status | developers
    channel_id TEXT NOT NULL,
    mention_role_id TEXT,                  -- optional role to ping
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, category)
);

CREATE TABLE news_guild_settings (
    guild_id TEXT PRIMARY KEY,
    locale TEXT NOT NULL DEFAULT 'na',
    events_mode TEXT NOT NULL DEFAULT 'off',  -- maintenance events: off | all_worlds | game | everything
    announcement_events TEXT NOT NULL DEFAULT 'manual',  -- other announcements: off | manual | auto
    data_center TEXT                          -- optional, e.g. 'Aether'
);

CREATE TABLE news_items (
    id TEXT NOT NULL,
    locale TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (id, locale)
);

CREATE TABLE news_deliveries (
    guild_id TEXT NOT NULL,
    news_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, news_id)
);

CREATE TABLE news_events (
    guild_id TEXT NOT NULL,
    event_id TEXT NOT NULL,                -- Discord scheduled event ID
    news_id TEXT NOT NULL,                 -- the post that created it
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    origin TEXT NOT NULL,                  -- maintenance | auto | manual
    corrected INTEGER NOT NULL DEFAULT 0,  -- 1 if a mod changed the times of an auto-created event
    dismissed INTEGER NOT NULL DEFAULT 0,  -- 1 once a human deletes the event; never recreate
    PRIMARY KEY (guild_id, event_id)
);
```

`news_guild_settings` has a row from the first `/lodestone` setting, with no row meaning the defaults. Don't repeat the `guild_settings` quirk the roadmap's Later lists, where a missing row has to be handled as `NULL` in a `LEFT JOIN`: read the settings in code with the defaults applied, or insert the row on subscribe.

Prune `news_items` and `news_deliveries` older than a few months so the tables stay small.

### Commands

`/lodestone`, guild-only, default permission Manage Server. Replies are ephemeral (CLAUDE.md: replies about settings), except `latest`, which posts the post's embed.

| Command | Behaviour |
|---|---|
| `/lodestone subscribe category channel [mention]` | Sends new posts in that category (or `all`) to the channel. Warns, and still saves, if the bot lacks View Channel, Send Messages or Embed Links there, like `/reminder create` does. |
| `/lodestone unsubscribe category` | Stops them. |
| `/lodestone events mode [data_center]` | Turns automatic maintenance events on and chooses how many kinds qualify (see filter below). Warns if the bot lacks Create Events. |
| `/lodestone announcements mode` | Sets how other dated announcements become events: `off`, `manual` (a mod confirms) or `auto` (the bot parses the dates). |
| `/lodestone region locale` | Chooses which Lodestone to follow. |
| `/lodestone list` | Shows the server's subscriptions and settings, plus how many auto-created events were later corrected or deleted. |
| `/lodestone latest [category]` | Shows the most recent post now. Useful for checking the setup. |

### Posting

- Pure embed builder in `newsEmbed.ts`: title linked to the post, description, image, a colour and label per category, the post's timestamp.
- For maintenance, show the window with Discord timestamp markup (`<t:...:F>`), so every member sees it in their own time zone.
- An optional role mention is the only mention allowed; set `allowedMentions` to exactly that role. Since #23 established that a mention inside an embed doesn't ping, put the role mention in the message content above the embed, as `src/reminderMessage.ts` does.

### Automatic maintenance events

Discord facts, verified 2026-11-20 against [Discord: Guild Scheduled Event](https://docs.discord.com/developers/resources/guild-scheduled-event):

- An external event (`entity_type` EXTERNAL, no channel) requires `scheduled_end_time` and `entity_metadata.location`. It becomes active at its start time by itself.
- Name 1 to 100 characters, description 1 to 1000, location 1 to 100. An optional cover image.
- At most **100 events with SCHEDULED or ACTIVE status** per server.
- Creating one needs **Create Events**. Editing or deleting one the bot created needs Create Events *or* Manage Events, so Create Events alone is enough for everything here. No gateway intent is needed.
- **Unverified:** the docs don't say the start must be in the future. Keep the rule below (start a minute ahead), and test what Discord does with a past start on the dev server in C3.

Rules:

| Situation | Action |
|---|---|
| New maintenance post, window in the future | Create an event. Name from the post title, location set to the post's URL (it fits in 100 characters), description with the window. Record it in `news_events`. |
| Maintenance already under way (unscheduled or emergency) | Create the event with the start set a minute ahead and the real end time. |
| Window already over | No event. |
| A known post's times change | Edit the existing event. |
| A **follow-up post** about the same maintenance (a new post, new ID) | Match it to the existing event by title stem and overlapping window (see Data source), and edit that event instead of creating a second one. |
| A human deleted the event | The edit fails with "unknown event". Mark it `dismissed` and never recreate it. |
| No end time available | Post the news but create no event. |
| The server has 100 scheduled or active events | Post the news, skip the event, and log it. |

**Filter.** One event per small maintenance would bury the calendar. `events_mode` controls this:

- `all_worlds`: only All Worlds and emergency maintenance, plus the server's own `data_center` if set. Recommended default once enabled.
- `game`: any maintenance that affects the game servers.
- `everything`: every maintenance post.

Classify by title keywords in a pure, fixture-tested function, using the titles above as the first fixtures. Every maintenance post is still sent to the channel regardless of the filter; the filter only governs events.

### Events for other announcements

PvP season and series starts, housing demolition dates and similar posts carry their dates in free text, in formats that vary from post to post. Automatic parsing will sometimes be wrong, so it is a per-server choice that can be switched at any time with `/lodestone announcements mode`.

A list of title patterns marks a post as a likely dated announcement (`PvP Series`, `Season`, `Housing Demolition`, and so on; extendable). What happens next depends on the mode:

| Mode | Behaviour |
|---|---|
| `off` | The post is sent to the channel as normal news. Nothing else. |
| `manual` (default) | The news embed carries a **Create event** button, usable by members with Manage Server (or Manage Events). It opens a form pre-filled with the title, asking for start and end. On submit the bot creates the event. |
| `auto` | The bot reads the post body and tries to extract the dates. If it is confident, it creates the event itself. If not, it falls back to the `manual` button for that post. |

**Rules for `auto`**, so a bad parse is rare and easy to undo:

- Create an event only when the text yields an explicit date, time and time zone, the start is in the future and within a sane horizon (for example 120 days), and any end is after the start. Anything less falls back to the button.
- Many of these posts give only a start ("Series 9 begins on ..."). Discord requires an end, so use a fixed default length (for example one hour) and say so in the event description.
- Mark the event as automatic in its description, with the link to the post, so members know to check the source.
- The news embed for an auto-created event carries **Fix times** and **Remove event** buttons for mods. Fix times opens the same form as manual mode.
- Record `origin = 'auto'` in `news_events`, set `corrected` when a mod fixes the times, and `dismissed` when the event is removed. `/lodestone list` reports those counts, which is the evidence for deciding whether to stay on `auto` or switch back to `manual`.

The parser is a pure function over post text, tested with fixtures of real posts gathered in C0.

Both modes need buttons and forms that keep working after a bot restart, so `src/events/interactionCreate.ts` must route `isButton()` and `isModalSubmit()` by a custom-ID prefix. Put that routing after the autocomplete branch and outside the cooldown (which applies to slash commands only), with the same logged, self-catching error handling. Buttons check the clicker's permissions in code, because a button has no `setDefaultMemberPermissions`.

### Steps

- **C0. Verify the remaining unknowns**: the other categories and locales, where a post body comes from, and the Atom fallback. Save real responses as fixtures (the 2026-11-20 maintenance list above is a good start), and correct this section.
- **C1. Source client and normalisation**, tested with a stubbed `fetch` and the fixtures.
- **C2. Storage, poller (with shutdown), embed builder, and `/lodestone subscribe | unsubscribe | region | list | latest`**, plus the decision record. After this step the bot replaces the existing webhook. The README notes that the VM now makes outbound requests to the news source (the firewall note in `ORACLE_CLOUD_DEPLOYMENT.md` stays true: still outbound only).
- **C3. Automatic maintenance events**: the classifier, the create/update/skip rules, `/lodestone events`, the permission warning, and Create Events in the README's invite permissions.
- **C4. Manual mode** for other announcements: button and form routing, title patterns, `/lodestone announcements`.
- **C5. Auto mode**: the date parser with fixtures, the confidence rules, the Fix times and Remove event buttons, and the counts in `/lodestone list`.

Each step updates the README (Features, Commands, Project Structure) in its own PR.

### C-later

- Event cover image taken from the post's header image.
- Use the parser's best guess to pre-fill the form in manual mode.
- News sources for other games behind the same interface.

---

## Track D: Web dashboard (after A, B, C and E)

Not planned in detail yet. This section records why it waits, what to do now so it is cheap later, and the decisions it will need.

### Why it comes after the other tracks

- **It is the largest single piece of work**, and the first thing in this project that accepts connections from the internet. Today the VM has no inbound ports open at all. A dashboard needs a web server, Discord login, sessions, HTTPS, a stable hostname, and either firewall changes in both the OCI security list and the VM's iptables, or a tunnel.
- **It is a second way to do things the slash commands must do anyway.** Built first, it would be designed against features that do not exist yet and reworked as each one lands.
- **It makes one Track A extra cheap.** Once the bot has an HTTPS endpoint, the Minecraft helper can report to the bot directly (the "ingest endpoint" in A-later), which is what a Minecraft status page would need.

### What to do during the feature tracks so the dashboard is cheap later

One rule, in the conventions below: **command files stay thin.** Validation, permission checks and database changes live in plain functions that take plain arguments (`guildId`, `userId`, values), not a Discord interaction. A web route can then call the same function a slash command calls. The existing reminder commands mix these and can be refactored when the dashboard reaches them.

### Likely shape

| Question | Leaning | Why |
|---|---|---|
| Where it runs | Inside the bot process | It shares the one database connection and the live Discord client, which it needs for channel lists, refreshing the reminder status embed and creating events. |
| Login | Discord OAuth2 (`identify`, `guilds`) | No passwords to store. Needs the application's client secret and a session secret in the VM's `.env`. |
| Who can change what | The same rules as the commands | Manage Server for settings (or whatever Integrations grants); members edit only their own collection entries. Enforced on the server for every write. |
| HTTPS and hostname | Free only (CLAUDE.md): no bought domain, nothing that needs a payment method | Cloudflare quick tunnels are free and need no account, but Cloudflare documents them as for testing only, with a random `trycloudflare.com` hostname that changes on every restart, so they don't fit a service (verified 2026-11-20, [Cloudflare: Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). A free dynamic-DNS subdomain with a reverse proxy that gets certificates automatically (for example Caddy with Let's Encrypt) is the likely route. Which provider, and that it needs no card, is **unverified**. The Discord OAuth2 redirect URL needs the stable hostname. |
| Pages | Rendered on the server, little JavaScript | Fits the project's no-build-step model. |
| Libraries | Owner's decision | A web framework, a session store or an OAuth library is a runtime dependency (CLAUDE.md). Node's own `node:http` plus `fetch` for OAuth is the zero-dependency baseline to compare against. |

### Suggested order when it starts

- **D0. Decisions**, each a decision record: the hostname and HTTPS route (free only), proxy or tunnel, web framework or none.
- **D1. Read-only site**: login, server picker, and pages that only display. The collection grid (members by items) is the best first page, because it restores the spreadsheet view the group is used to.
- **D2. Editing**: reminders, Lodestone subscriptions and modes, collection catalog and entries.
- **D3. Minecraft**: bridge reports to the bot; status and recent events page.

Security work (CSRF protection, session expiry, rate limiting) belongs in D1, not after.

---

## Track E: Membership follow-ups

Two separate features that share one idea: store a due date in the database and let the existing poller in `src/scheduler.ts` act on it. Thirty days is far too long to hold in a timer, and the database row survives restarts and deploys.

Neither feature is FF14-specific in code. Roles, channels, wording and day counts are all configuration.

### How the due checks fit the scheduler

Both features add a check to `src/scheduler.ts` beside `guildCheck` and `userCheck`: its own promise variable, started in `startScheduler`'s interval through `runCheck` (overlap guard and logging), and added to the promises `stopScheduler` waits for, which today are only those two.

- `SchedulerClient` grows only by what the new checks call (for example a guild's `members.fetch` for the role check-in), and the fakes in `test/mocks.ts` grow to match.
- These reminders are one-shot, not interval-based. A send Discord refuses for good (missing permissions, channel gone) must not be retried every poll (CLAUDE.md's scheduler rule): mark the row as failed and log it. A channel that no longer exists disables the setting, which `/rolecheck status` and `/recruit config` show, as a disabled reminder shows in `/reminder status`. Network and 5xx errors are retried on the next poll, as for reminders.

### E-recruit: trial FC members, for moderators

Decision record 0004 (feature storage modules) comes from [`refactor.md`](refactor.md)'s task 3, ahead of E1; E1 follows it.

**What a moderator does.** Records a new FC member by **in-game name** with a short note. Nothing ties the entry to a Discord account. After 30 days the bot posts in the moderators' channel, pinging the moderator role: this person joined 30 days ago, here is the note, are they still with us, promote them in game to full member.

One new migration appended to `MIGRATIONS`:

```sql
CREATE TABLE recruit_settings (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    ping_role_id TEXT,
    follow_up_days INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE recruits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,                    -- in-game name as typed
    name_key TEXT NOT NULL,                -- lower-cased, trimmed
    note TEXT NOT NULL DEFAULT '',
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',-- pending | reminded | promoted | left
    resolved_by TEXT,
    resolved_at INTEGER
);

-- A name may appear only once among open entries, but can be re-added after it is resolved.
CREATE UNIQUE INDEX recruits_open_name
    ON recruits (guild_id, name_key) WHERE status IN ('pending', 'reminded');
```

`/recruit`, guild-only, default permission Manage Server. The owner can grant the whole command to a moderator role in Server Settings → Integrations, which is Discord's own mechanism and needs no code.

| Command | Behaviour |
|---|---|
| `/recruit add name note [days]` | Records a trial member. The reminder is due in `days`, or the server default. |
| `/recruit edit name [note] [new_name] [days]` | Changes the note, the name or the due date. |
| `/recruit list` | Shows open entries with who added them, the note and when each is due. |
| `/recruit resolve name outcome` | Closes an entry as `promoted` or `left`. |
| `/recruit snooze name days` | Pushes the reminder back, for "ask me again next week". |
| `/recruit remove name` | Deletes an entry made by mistake. |
| `/recruit config channel [role] [days]` | Sets where reminders go, which role is pinged and the default delay. Warns, and still saves, if the bot cannot post there. |

- `name` on every command except `add` is an autocomplete over open entries, built like `/reminder`'s label autocomplete (#22). Like it, a typed name that matches nothing still gets a "not found" reply.
- Limits: name up to 50 characters, note up to 300. Cap open entries per server, next to the other limits in `storage.ts`.
- The reminder is sent once and moves the entry to `reminded`. It stays in `/recruit list`, shown as overdue, until someone resolves or snoozes it.
- The reminder's only mention is the configured role, in the message content; set `allowedMentions` to exactly that.
- Replies to `/recruit` commands are ephemeral, since notes about people should not land in a public channel by accident.

### E-role: check-in after choosing a role

**What the member sees.** Thirty days after they receive a tracked role (Free Company or Guest), the bot posts in the configured channel, mentioning them: it has been 30 days, are you still a guest or have you joined the FC, please update your role. The wording is configurable, with `{user}`, `{role}` and `{days}` placeholders. The default message includes `<id:customize>`, Discord's link to the server's Channels & Roles tab with its onboarding prompts (verified 2026-11-20, [Discord: Message Formatting, Guild Navigation Types](https://docs.discord.com/developers/reference)). The member mention goes in the message content, with `allowedMentions` set to exactly that user.

**The requirement this adds.** Noticing that a member gained a role needs the **Server Members Intent** (`GuildMembers`), a privileged intent the bot does not request today (`src/index.ts` asks for `Guilds` and `GuildExpressions`). `GUILD_MEMBER_UPDATE` and `GUILD_MEMBER_REMOVE` both need it (verified 2026-11-20, [Discord: Gateway Events](https://docs.discord.com/developers/events/gateway-events)).

- It is a switch on the Bot tab of the Developer Portal, needed on both the production and dev applications.
- **Order matters.** If the code requests the intent before the switch is on, Discord refuses the login. The deploy's login check would then fail the job, but the bot would be down, crash-looping under `Restart=on-failure`, until a fix or the switch. Turn the switch on first, then merge.
- The README's Local Setup ("no privileged gateway intents need to be enabled") and `ORACLE_CLOUD_DEPLOYMENT.md`'s application setup change in the same PR.

**Detecting the role.** Do not rely on comparing a member's old and new roles: discord.js only has the old state for members it happens to have cached. Instead make the handler idempotent and look only at the member's current roles:

- On a member update: for each tracked role the member holds with no row yet, insert a row due in `delay_days`. For each row whose role the member no longer holds, delete it.
- On a member leaving: delete their rows.
- Enable `Partials.GuildMember`. Checked in the installed discord.js 14.27.0 (`src/client/actions/GuildMemberUpdate.js`): without it, an update for a member that isn't cached emits `guildMemberAvailable`, not `guildMemberUpdate`. With it, `guildMemberUpdate` fires and the old member is a partial, which this handler ignores anyway.
- **Unverified:** whether picking an onboarding option fires a member update as soon as it is picked or only when onboarding completes. Discord documents an option's `role_ids` as "roles assigned to a member when the option is selected". Either way the handler above works; confirm on the dev server in E2 and correct the wording here.

Consequences of that rule: switching from Guest to FC starts a fresh 30 days for the new role and cancels the old one; removing and re-adding a role restarts the clock.

New event files under `src/events/` are loaded by `src/index.ts` and wrapped by `src/eventListener.ts`, so a handler that throws is logged, not a crash.

**When the reminder is due.** Fetch the member. If they have left or no longer hold the role, delete the row and send nothing. Otherwise post and mark the row sent. It is a one-time reminder per role held.

**Members the bot did not see.** Roles chosen while the bot was offline are missed by the event. A reconcile pass on startup, also available as `/rolecheck scan`, fetches the member list and adds rows for anyone holding a tracked role without one. It only considers members who joined after the feature was switched on, so enabling it does not queue a reminder for every existing member.

One new migration appended to `MIGRATIONS`:

```sql
CREATE TABLE rolecheck_settings (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    delay_days INTEGER NOT NULL DEFAULT 30,
    message TEXT,                          -- NULL means the built-in default wording
    enabled INTEGER NOT NULL DEFAULT 1,
    enabled_at INTEGER NOT NULL
);

CREATE TABLE rolecheck_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE rolecheck_pending (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    sent_at INTEGER,                       -- NULL until the reminder is posted
    PRIMARY KEY (guild_id, user_id, role_id)
);
```

`/rolecheck`, guild-only, default permission Manage Server, replies ephemeral:

| Command | Behaviour |
|---|---|
| `/rolecheck setup channel [days] [message]` | Chooses the channel, the delay (default 30) and optional custom wording. Warns, and still saves, if the bot cannot post there. |
| `/rolecheck roles add role` / `roles remove role` | Chooses which roles start a check-in. |
| `/rolecheck toggle enabled` | Pauses or resumes the feature. |
| `/rolecheck status` | Shows the settings, how many check-ins are pending and when the next is due, and whether the channel stopped working. |
| `/rolecheck scan` | Runs the reconcile pass now. |

The reminder channel must be one the reminded member can see, or the mention reaches nobody.

### Steps

- **E1. `/recruit`**: the first feature storage module (per decision record 0004, from the refactor), the migration, the commands, the due check in the scheduler, the reminder post, and the README, including its retitle and `CASESTUDY.md`'s Overview (see B's steps). Needs no new intent. The smallest feature in the plan, so it goes first.
- **E2. Role check-in**: the intent and partial in `src/index.ts`, the member update and member remove event files in `src/events/`, storage and migration, `/rolecheck`, the due check, the reconcile pass, a decision record for the privileged intent, and the README and `ORACLE_CLOUD_DEPLOYMENT.md` setup changes. **Confirm the portal switch is on for both applications before the PR is merged.**
- **E3. Buttons on both reminders** (optional): Promoted, Left and Snooze on the recruit reminder; Still a guest and Joined the FC on the role check-in, which swap the member's role and so need the bot to have Manage Roles and sit above those roles. Uses the button routing built in C4.

### E-later

- An optional Discord member link on a recruit entry, for trial members who do have Discord.
- Repeat the role check-in every N days while someone is still a Guest.
- Re-ping moderators weekly about recruit entries nobody has resolved.

---

## Conventions specific to this plan

CLAUDE.md's rules apply throughout: schema changes as migrations, erasable syntax, `.ts` imports, tests mirroring `src/`, ephemeral replies about settings, Manage Server on commands that change settings, comments that say why, and the PR workflow. `scripts/check.sh` (lint, format, typecheck, tests with coverage, as CI runs) must pass on every PR, and coverage (about 98% today) shouldn't drop.

In addition:

- **Command files stay thin**: validation, permission checks and database changes go in functions that take plain arguments rather than a Discord interaction, so the future dashboard can call them (see Track D).
- Slash commands are registered globally, so every new command appears in every server the bot is in; each server's data is separate. Each new or changed command's PR says so in its Deploys line, since the deploy re-registers commands.
- A new gateway intent must be switched on in the Developer Portal, for both applications, before the code requesting it is merged.

## Suggested pull request order

Small PRs, each green on its own. These go ahead of the roadmap's earlier Next up items.

1. E1 (`/recruit`, after the refactor in [`refactor.md`](refactor.md))
2. B2 (collection storage)
3. B3 (`/collection`)
4. B4 (`/collectionadmin`)
5. B5 (import and export)
6. A1 + A2 (parser and classifier, with the Track A record)
7. A3 + A4 + A5 + A6 (tailer, sender, entrypoint, docs)
8. C0 + C1 + C2 (Lodestone news posting, with the Track C record)
9. C3 (automatic maintenance events)
10. C4 (manual events for other announcements)
11. C5 (auto mode)
12. E2 (role check-in), after the Server Members Intent is switched on
13. B6, E3, and anything from the "later" lists
14. Track D (dashboard), starting with D0
