import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { ReminderState } from '../reminders/reminderState.ts';
import type { ChannelChoice } from '../minecraft/dashboardPairing.ts';
import type { BotPermission, HelperConfig, PairingRefusal } from '../minecraft/pairing.ts';
import type { ServerRights } from './access.ts';

type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

// Every value interpolated below is escaped by `html`; nothing here uses raw().
function layout(title: string, body: Page): Page {
	return html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>${title} · Shrimp Fried Rice</title>
			</head>
			<body>
				<main>${body}</main>
			</body>
		</html>`;
}

export function homePage(signedInAs: string | null, loginAvailable: boolean): Page {
	if (signedInAs !== null) {
		return layout(
			'Dashboard',
			html`<h1>Shrimp Fried Rice</h1>
				<p>Signed in as ${signedInAs}.</p>
				<p><a href="/servers">Your servers</a></p>
				<form method="post" action="/logout"><button type="submit">Log out</button></form>`,
		);
	}
	return layout(
		'Dashboard',
		html`<h1>Shrimp Fried Rice</h1>
			${
				loginAvailable
					? html`<p><a href="/login">Log in with Discord</a></p>`
					: html`<p>Login isn't set up on this bot.</p>`
			}`,
	);
}

// A user who manages only bridges would get a 404 from /servers/:id, so
// their link goes straight to the Minecraft page.
function serverItem(server: ServerRights): Page {
	const minecraft = `/servers/${server.id}/minecraft`;
	if (!server.manageServer) return html`<li><a href="${minecraft}">${server.name}</a> (Minecraft servers)</li>`;
	return html`<li>
		<a href="/servers/${server.id}">${server.name}</a>${
			server.manageBridges ? html` · <a href="${minecraft}">Minecraft servers</a>` : ''
		}
	</li>`;
}

export function serversPage(servers: ServerRights[]): Page {
	return layout(
		'Your servers',
		html`<h1>Your servers</h1>
			${
				servers.length === 0
					? html`<p>
							No servers to show. This lists the servers the bot is in where you have Manage Server, or may manage its
							Minecraft servers (the server's owner, or members with the role they allow).
						</p>`
					: html`<ul>
							${servers.map(serverItem)}
						</ul>`
			}
			<p><a href="/">Back to the dashboard</a></p>`,
	);
}

/** A server's reminder as its page shows it. `channelName` is null for a channel the bot can't see. */
export interface ReminderView {
	label: string;
	channelId: string;
	channelName: string | null;
	intervalMinutes: number;
	message: string;
	embed: boolean;
	state: ReminderState;
}

export interface ServerReminders {
	masterEnabled: boolean;
	reminders: ReminderView[];
	max: number;
	now: number;
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function interval(minutes: number): string {
	return minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute');
}

// Worked out on the server, as the pages run no scripts to show it in the
// visitor's own time zone; the exact time, in UTC, is the element's tooltip.
// Pages aren't cached (no-store), so it's as of the page load.
function fromNow(at: number, now: number): Page {
	const minutes = Math.round((at - now) / 60_000);
	const text =
		minutes < 1
			? 'in under a minute'
			: minutes < 120
				? `in ${plural(minutes, 'minute')}`
				: minutes < 48 * 60
					? `in ${plural(Math.round(minutes / 60), 'hour')}`
					: `in ${plural(Math.round(minutes / (24 * 60)), 'day')}`;
	const iso = new Date(at).toISOString();
	return html`<time datetime="${iso}" title="${iso.slice(0, 16).replace('T', ' ')} UTC">${text}</time>`;
}

function stateText(state: ReminderState, now: number): Page | string {
	switch (state.kind) {
		case 'paused':
			return "Paused: this server's reminders are off";
		case 'disabled':
			return 'Disabled';
		case 'snoozed':
			return html`Snoozed, next ${fromNow(state.at, now)}`;
		case 'due':
			return 'Due on the next check';
		case 'scheduled':
			return html`Next ${fromNow(state.at, now)}`;
	}
}

function reminderItem(reminder: ReminderView, now: number): Page {
	const channel =
		reminder.channelName === null
			? html`a channel the bot can't see (ID ${reminder.channelId})`
			: html`#${reminder.channelName}`;
	// The setting, not what Discord gets: a message with a link, or a channel
	// without Embed Links, is still sent as plain text (reminderMessage.ts).
	const format = reminder.embed ? 'set to an embed' : 'set to plain text';
	return html`<li>
		<h2>${reminder.label}</h2>
		<p>Every ${interval(reminder.intervalMinutes)} in ${channel}, ${format}.</p>
		<p>${stateText(reminder.state, now)}.</p>
		<blockquote>${reminder.message}</blockquote>
	</li>`;
}

/** A server's reminders, read-only: changing them is /reminder's, in Discord. */
export function serverPage(server: { name: string }, view: ServerReminders): Page {
	return layout(
		server.name,
		html`<h1>${server.name}</h1>
			<p>
				${
					view.masterEnabled
						? 'Reminders are on for this server.'
						: 'Reminders are off for this server (/reminder master), so none are sent.'
				}
				${plural(view.reminders.length, 'reminder')} of ${view.max}. Change them with
				<code>/reminder</code> in Discord.
			</p>
			${
				view.reminders.length === 0
					? html`<p>No reminders yet. Use <code>/reminder create</code> in Discord to add one.</p>`
					: html`<ul>
							${view.reminders.map((reminder) => reminderItem(reminder, view.now))}
						</ul>`
			}
			<p><a href="/servers">Your servers</a></p>`,
	);
}

/** A bridge as the Minecraft page shows it. A channel's `name` is null for one the bot can't see. */
export interface BridgeView {
	serverName: string;
	chat: { id: string; name: string | null };
	alerts: { id: string; name: string | null };
	/** The relay was announced in the chat channel, so its chat goes into the game (decision 0006). */
	announced: boolean;
}

function channelText(channel: { id: string; name: string | null }): Page {
	return channel.name === null ? html`a channel the bot can't see (ID ${channel.id})` : html`#${channel.name}`;
}

function bridgeItem(bridge: BridgeView): Page {
	return html`<li>
		<h2>${bridge.serverName}</h2>
		<p>Chat in ${channelText(bridge.chat)}, alerts in ${channelText(bridge.alerts)}.</p>
		<p>
			${
				bridge.announced
					? 'Messages posted in its chat channel go into the game.'
					: "Messages posted in its chat channel don't go into the game yet: the bot announces it there when the server's helper first connects."
			}
		</p>
	</li>`;
}

/** A server's Minecraft bridges, read-only, for its owner and members with the role they allow. */
export function minecraftPage(
	server: { id: string; name: string },
	view: { bridges: BridgeView[]; max: number },
): Page {
	return layout(
		`${server.name}: Minecraft servers`,
		html`<h1>${server.name}: Minecraft servers</h1>
			<p>${plural(view.bridges.length, 'Minecraft server')} of ${view.max} paired with this Discord server.</p>
			${
				view.bridges.length === 0
					? html`<p>No Minecraft servers paired yet.</p>`
					: html`<ul>
							${view.bridges.map(bridgeItem)}
						</ul>`
			}
			${
				view.bridges.length < view.max
					? html`<p><a href="/servers/${server.id}/minecraft/new">Add a Minecraft server</a></p>`
					: ''
			}
			<p><a href="/servers">Your servers</a></p>`,
	);
}

/** Why a bridge wasn't paired, for the form to say what to fix. */
export type AddBridgeProblem =
	| { reason: 'no-channel' }
	| Exclude<PairingRefusal, { reason: 'not-allowed' | 'bridge-limit' | 'unknown-bridge' | 'bridge-changed' }>;

export type AddBridgeView =
	| { kind: 'limit'; max: number }
	/** The form's one-time token was already used, or has expired. */
	| { kind: 'sent' }
	| {
			kind: 'form';
			/** Used up by the POST, so the form pairs once (formTokens.ts). */
			token: string;
			choices: ChannelChoice[];
			/** What was sent, kept when the form comes back with a problem. */
			values?: { serverName: string; chat: string; alerts: string };
			problem?: AddBridgeProblem;
			/** A channel's name from the bot's cache, null for one it can't see. */
			channelName?: (id: string) => string | null;
	  };

const PERMISSION_NAMES: Record<BotPermission, string> = {
	ViewChannel: 'View Channel',
	ManageWebhooks: 'Manage Webhooks',
	ReadMessageHistory: 'Read Message History',
};

function problemText(problem: AddBridgeProblem, channelName: (id: string) => string | null): Page | string {
	const channel = (id: string) => {
		const name = channelName(id);
		return name === null ? html`the channel with ID ${id}` : html`#${name}`;
	};
	switch (problem.reason) {
		case 'no-channel':
			return 'Pick a chat channel and an alerts channel.';
		case 'bad-name':
			return 'The name must be 1 to 80 characters, without "clyde" or "discord" (Discord refuses those in a webhook\'s name).';
		case 'unusable-channel':
			return html`${channel(problem.channelId)} can't be used: pick a text or announcement channel.`;
		case 'member-cant-manage-channel':
			return html`You need View Channel and Manage Webhooks in ${channel(problem.channelId)}.`;
		case 'bot-missing-permissions':
			return html`The bot needs ${problem.missing.map((name) => PERMISSION_NAMES[name]).join(', ')} in
			${channel(problem.channelId)}. Allow them for the bot in the channel's permissions, then try again.`;
		case 'webhook-limit':
			return problem.scope === 'channel'
				? html`${channel(problem.channelId)} already has 15 webhooks, Discord's most for a channel. Delete one in its
					settings (Integrations), or pick another channel.`
				: "This Discord server already has 1000 webhooks, Discord's most for a server. Delete some in Server Settings (Integrations).";
		case 'error':
			return 'Discord or the bot failed, and nothing was paired. Please try again.';
	}
}

function channelOptions(choices: ChannelChoice[], selected: string | undefined): Page {
	return html`<option value="">Pick a channel</option>
		${choices.map(
			(choice) =>
				html`<option value="${choice.id}" ${choice.id === selected ? 'selected' : ''}>#${choice.name}</option>`,
		)}`;
}

/** The form that pairs a Minecraft server, or why it can't. */
export function addBridgePage(server: { id: string; name: string }, view: AddBridgeView): Page {
	const title = `${server.name}: add a Minecraft server`;
	const back = html`<p><a href="/servers/${server.id}/minecraft">Back to its Minecraft servers</a></p>`;
	if (view.kind === 'sent') {
		return layout(
			title,
			html`<h1>${title}</h1>
				<p>
					That form was already sent, or has expired. If it paired a Minecraft server, it's listed on its Minecraft
					page; otherwise, load the form again.
				</p>
				${back}`,
		);
	}
	if (view.kind === 'limit') {
		return layout(
			title,
			html`<h1>${title}</h1>
				<p>This Discord server already has ${view.max} Minecraft servers paired, the most it may have.</p>
				${back}`,
		);
	}
	const values = view.values;
	return layout(
		title,
		html`<h1>${title}</h1>
			${view.problem ? html`<p role="alert">${problemText(view.problem, view.channelName ?? (() => null))}</p>` : ''}
			${
				view.choices.length === 0
					? html`<p>
							There's no channel to pick: you need View Channel and Manage Webhooks in a text or announcement channel.
						</p>`
					: html`<form method="post" action="/servers/${server.id}/minecraft/new">
							<input type="hidden" name="form" value="${view.token}" />
							<p>
								<label
									>Minecraft server's name, shown on its posts in Discord and in game
									<input name="serverName" required maxlength="80" value="${values?.serverName ?? ''}"
								/></label>
							</p>
							<p>
								<label
									>Chat channel, where game chat is posted and whose messages go into the game
									<select name="chat" required>
										${channelOptions(view.choices, values?.chat)}
									</select></label
								>
							</p>
							<p>
								<label
									>Alerts channel, for the server starting, stopping and crashing (may be the same channel)
									<select name="alerts" required>
										${channelOptions(view.choices, values?.alerts)}
									</select></label
								>
							</p>
							<p>
								The bot needs View Channel and Manage Webhooks in both, and Read Message History in the chat channel. It
								makes a webhook in each.
							</p>
							<p><button type="submit">Pair</button></p>
						</form>`
			}
			${back}`,
	);
}

/**
 * The helper's config, shown once: only the keys derived from its secret are
 * kept, so it can't be shown again. In a read-only box to copy, as the pages
 * run no scripts.
 */
export function pairedPage(
	server: { id: string; name: string },
	view: { serverName: string; config: HelperConfig },
): Page {
	const title = `${server.name}: ${view.serverName} paired`;
	return layout(
		title,
		html`<h1>${title}</h1>
			<p>
				This is the config for <code>mcbridge</code>, the helper beside the Minecraft server.
				<strong>It's shown only this once.</strong> Save it as <code>mcbridge.json</code>, fill in
				<code>logPath</code> (the server's <code>logs/latest.log</code>), and keep it private (<code>chmod 600</code>):
				anyone with it can post in its channels and receive its chat.
			</p>
			<p>
				<label
					>mcbridge.json <textarea readonly rows="16" cols="80">${JSON.stringify(view.config, null, 2)}</textarea>
				</label>
			</p>
			<p>
				Messages posted in the chat channel go into the game once the helper first connects, when the bot announces it
				there. Consider telling the channel beforehand, and saying so in its topic.
			</p>
			<p><a href="/servers/${server.id}/minecraft">Back to its Minecraft servers</a></p>`,
	);
}

/** A page for a login that didn't complete, or one that isn't there: what happened, and the way back. */
export function messagePage(title: string, message: string): Page {
	return layout(
		title,
		html`<h1>${title}</h1>
			<p>${message}</p>
			<p><a href="/">Back to the dashboard</a></p>`,
	);
}
