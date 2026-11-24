import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

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

export function serverPage(server: { name: string }): Page {
	return layout(
		server.name,
		html`<h1>${server.name}</h1>
			<p>This server's reminders will show here.</p>
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
