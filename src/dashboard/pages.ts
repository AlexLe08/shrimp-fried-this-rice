import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { ReminderState } from '../reminders/reminderState.ts';

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

export function serversPage(servers: { id: string; name: string }[]): Page {
	return layout(
		'Your servers',
		html`<h1>Your servers</h1>
			${
				servers.length === 0
					? html`<p>No servers to show. This lists the servers the bot is in where you have Manage Server.</p>`
					: html`<ul>
							${servers.map((server) => html`<li><a href="/servers/${server.id}">${server.name}</a></li>`)}
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
	return html`<li>
		<h2>${reminder.label}</h2>
		<p>
			Every ${interval(reminder.intervalMinutes)} in ${channel}, ${reminder.embed ? 'as an embed' : 'as plain text'}.
		</p>
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

/** A page for a login that didn't complete, or one that isn't there: what happened, and the way back. */
export function messagePage(title: string, message: string): Page {
	return layout(
		title,
		html`<h1>${title}</h1>
			<p>${message}</p>
			<p><a href="/">Back to the dashboard</a></p>`,
	);
}
