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

/** A page for a login that didn't complete: what happened, and the way back. */
export function messagePage(title: string, message: string): Page {
	return layout(
		title,
		html`<h1>${title}</h1>
			<p>${message}</p>
			<p><a href="/">Back to the dashboard</a></p>`,
	);
}
