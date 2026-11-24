import { Hono } from 'hono';

export function createApp(): Hono {
	const app = new Hono();
	// For checking that the tunnel reaches the bot: it touches neither Discord nor the database.
	app.get('/health', (c) => c.text('ok'));
	return app;
}
