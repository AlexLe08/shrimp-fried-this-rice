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
	id: string;
	serverName: string;
	chat: { id: string; name: string | null };
	alerts: { id: string; name: string | null };
	/** The relay was announced in the chat channel, so its chat goes into the game (decision 0006). */
	announced: boolean;
}

function channelText(channel: { id: string; name: string | null }): Page {
	return channel.name === null ? html`a channel the bot can't see (ID ${channel.id})` : html`#${channel.name}`;
}

function bridgeItem(serverId: string, bridge: BridgeView): Page {
	const base = `/servers/${serverId}/minecraft/bridges/${bridge.id}`;
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
		<p><a href="${base}/regenerate">Regenerate its config</a> · <a href="${base}/remove">Remove it</a></p>
	</li>`;
}

/** The allowed role as the page shows it; `name` is null for a role no longer in the server. */
export type AllowedRoleView = { id: string; name: string | null } | null;

function managersText(role: AllowedRoleView): Page | string {
	if (role === null) return "Only the server's owner manages them.";
	if (role.name === null) {
		return html`The server's owner manages them, and members with a role that's no longer in the server (ID ${role.id}),
		so nobody else does.`;
	}
	return html`The server's owner manages them, and members with the role @${role.name}.`;
}

/** A server's Minecraft bridges, for its owner and members with the role they allow. */
export function minecraftPage(
	server: { id: string; name: string },
	view: { bridges: BridgeView[]; max: number; allowedRole: AllowedRoleView; isOwner: boolean },
): Page {
	const managers = html`<p>
		${managersText(view.allowedRole)}
		${view.isOwner ? html`<a href="/servers/${server.id}/minecraft/role">Change who may manage them</a>` : ''}
	</p>`;
	return layout(
		`${server.name}: Minecraft servers`,
		html`<h1>${server.name}: Minecraft servers</h1>
			<p>${plural(view.bridges.length, 'Minecraft server')} of ${view.max} paired with this Discord server.</p>
			${managers}
			${
				view.bridges.length === 0
					? html`<p>No Minecraft servers paired yet.</p>`
					: html`<ul>
							${view.bridges.map((bridge) => bridgeItem(server.id, bridge))}
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

// In a read-only box to copy, as the pages run no scripts.
function configBox(config: HelperConfig): Page {
	return html`<p>
		<label>mcbridge.json <textarea readonly rows="16" cols="80">${JSON.stringify(config, null, 2)}</textarea></label>
	</p>`;
}

/**
 * The helper's config, shown once: only the keys derived from its secret are
 * kept, so it can't be shown again.
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
			${configBox(view.config)}
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

/** A role the owner may allow to manage the server's bridges. */
export interface RoleChoice {
	id: string;
	name: string;
}

/** Who may manage the bridges besides the owner: one role, or nobody. For the owner alone. */
export function rolePage(
	server: { id: string; name: string },
	view: { choices: RoleChoice[]; current: string | null; problem?: 'unknown-role' },
): Page {
	const title = `${server.name}: who may manage Minecraft servers`;
	return layout(
		title,
		html`<h1>${title}</h1>
			${view.problem ? html`<p role="alert">That role can't be chosen. Pick one from the list.</p>` : ''}
			<p>
				As the server's owner, you always may. Members with the role you choose here may too: pair Minecraft servers,
				change their settings, and remove them.
			</p>
			<p>
				Anyone who can give members that role (Manage Roles, with a higher role of their own) can make themselves a
				manager, so choose one only trusted members can give.
			</p>
			${
				view.current !== null && !view.choices.some((choice) => choice.id === view.current)
					? html`<p>
							The role chosen before is no longer in the server (ID ${view.current}), so nobody but you manages them.
							Saving without picking another clears it.
						</p>`
					: ''
			}
			<form method="post" action="/servers/${server.id}/minecraft/role">
				<p>
					<label
						>Role
						<select name="role">
							<option value="" ${view.current === null ? 'selected' : ''}>Nobody else: only the owner</option>
							${view.choices.map(
								(choice) =>
									html`<option value="${choice.id}" ${choice.id === view.current ? 'selected' : ''}>
										@${choice.name}
									</option>`,
							)}
						</select></label
					>
				</p>
				<p><button type="submit">Save</button></p>
			</form>
			<p><a href="/servers/${server.id}/minecraft">Back to its Minecraft servers</a></p>`,
	);
}

/** An old webhook Discord wouldn't delete; `channel.name` is null for a channel the bot can't see. */
export interface UndeletedWebhookView {
	channel: { id: string; name: string | null };
	webhookId: string;
}

// It still posts for anyone with the old config, so it's named for the
// manager to delete by hand.
function undeletedText(webhooks: UndeletedWebhookView[]): Page | string {
	if (webhooks.length === 0) return '';
	return html`<p role="alert">
			Discord wouldn't delete ${webhooks.length === 1 ? 'an old webhook' : 'these old webhooks'}, so anyone with the old
			config can still post through ${webhooks.length === 1 ? 'it' : 'them'}. Delete
			${webhooks.length === 1 ? 'it' : 'them'} in the channel's settings, under Integrations, then Webhooks:
		</p>
		<ul>
			${webhooks.map((webhook) => html`<li>ID ${webhook.webhookId} in ${channelText(webhook.channel)}</li>`)}
		</ul>`;
}

/** Why a bridge's config wasn't regenerated, for the page to say what to fix. */
export type RegenerateProblem = Exclude<
	PairingRefusal,
	{ reason: 'not-allowed' | 'unknown-bridge' | 'bad-name' | 'bridge-limit' }
>;

function regenerateProblemText(problem: RegenerateProblem, channelName: (id: string) => string | null): Page | string {
	const channel = (id: string) => {
		const name = channelName(id);
		return name === null ? html`the channel with ID ${id}` : html`#${name}`;
	};
	switch (problem.reason) {
		case 'unusable-channel':
			return html`${channel(problem.channelId)} is gone, or no longer a text or announcement channel, so nothing was
			regenerated. Remove this Minecraft server and pair it again with another channel.`;
		case 'webhook-limit':
			if (problem.scope === 'server') return problemText(problem, channelName);
			return html`${channel(problem.channelId)} already has 15 webhooks, Discord's most for a channel, and the new one
			is made before the old one is deleted. Delete one in its settings (Integrations), then try again.`;
		case 'bridge-changed':
			return 'Its channels changed meanwhile, and nothing was regenerated. Please try again.';
		case 'error':
			return 'Discord or the bot failed, and nothing was regenerated: the old config still works. Please try again.';
		default:
			return problemText(problem, channelName);
	}
}

export type RegenerateView =
	/** The form's one-time token was already used, or has expired. */
	| { kind: 'sent' }
	| {
			kind: 'confirm';
			bridge: { id: string; serverName: string };
			/** Used up by the POST, so the form regenerates once (formTokens.ts). */
			token: string;
			problem?: RegenerateProblem;
			/** A channel's name from the bot's cache, null for one it can't see. */
			channelName?: (id: string) => string | null;
	  };

/** Asks before regenerating a bridge's config, which stops its helper until the new one is in place. */
export function regeneratePage(server: { id: string; name: string }, view: RegenerateView): Page {
	const back = html`<p><a href="/servers/${server.id}/minecraft">Back to its Minecraft servers</a></p>`;
	if (view.kind === 'sent') {
		const title = `${server.name}: regenerate a config`;
		return layout(
			title,
			html`<h1>${title}</h1>
				<p>
					That form was already sent, or has expired. If it regenerated the config, the old one no longer works and the
					new one was shown only once: regenerate it again to get a config that works.
				</p>
				${back}`,
		);
	}
	const title = `${server.name}: regenerate ${view.bridge.serverName}'s config`;
	const action = `/servers/${server.id}/minecraft/bridges/${view.bridge.id}/regenerate`;
	return layout(
		title,
		html`<h1>${title}</h1>
			${
				view.problem
					? html`<p role="alert">${regenerateProblemText(view.problem, view.channelName ?? (() => null))}</p>`
					: ''
			}
			<p>
				Do this if its <code>mcbridge.json</code> may have leaked: anyone with it can post in its channels and receive
				its chat. Regenerating replaces the config's secret and both webhooks, and deletes the old webhooks, so the old
				config stops working at once.
			</p>
			<p>
				Its helper stops posting in Discord and reaching the bot until you put the new config in place and restart it.
				The new config is shown only once.
			</p>
			<form method="post" action="${action}">
				<input type="hidden" name="form" value="${view.token}" />
				<p><button type="submit">Regenerate</button></p>
			</form>
			${back}`,
	);
}

/** A bridge's new config, shown once, and any old webhook Discord kept. */
export function regeneratedPage(
	server: { id: string; name: string },
	view: { serverName: string; config: HelperConfig; undeleted: UndeletedWebhookView[] },
): Page {
	const title = `${server.name}: ${view.serverName}'s config regenerated`;
	return layout(
		title,
		html`<h1>${title}</h1>
			${undeletedText(view.undeleted)}
			<p>
				The old config no longer works. <strong>This one is shown only this once.</strong> In the helper's
				<code>mcbridge.json</code>, replace <code>webhooks</code> and <code>bot</code> with these, keeping the rest,
				then restart <code>mcbridge</code>.
			</p>
			${configBox(view.config)}
			<p><a href="/servers/${server.id}/minecraft">Back to its Minecraft servers</a></p>`,
	);
}

export type RemoveView =
	| { kind: 'confirm'; bridge: { id: string; serverName: string }; problem?: 'error' }
	/** Removed, but Discord kept a webhook, which the manager deletes by hand. */
	| { kind: 'removed'; serverName: string; undeleted: UndeletedWebhookView[] };

/** Asks before removing a bridge, or says what Discord left behind. */
export function removePage(server: { id: string; name: string }, view: RemoveView): Page {
	const back = html`<p><a href="/servers/${server.id}/minecraft">Back to its Minecraft servers</a></p>`;
	if (view.kind === 'removed') {
		const title = `${server.name}: ${view.serverName} removed`;
		return layout(
			title,
			html`<h1>${title}</h1>
				${undeletedText(view.undeleted)} ${back}`,
		);
	}
	const title = `${server.name}: remove ${view.bridge.serverName}`;
	return layout(
		title,
		html`<h1>${title}</h1>
			${view.problem ? html`<p role="alert">The bot failed, and nothing was removed. Please try again.</p>` : ''}
			<p>
				Removing it deletes its two webhooks, every member's link to a player on it, and the pictures set for its
				players. Its helper stops posting in Discord and reaching the bot, and messages in its chat channel stop going
				into the game. This can't be undone: pairing it again makes a new config.
			</p>
			<form method="post" action="/servers/${server.id}/minecraft/bridges/${view.bridge.id}/remove">
				<p><button type="submit">Remove</button></p>
			</form>
			${back}`,
	);
}
