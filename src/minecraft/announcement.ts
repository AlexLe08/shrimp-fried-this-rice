import { RESTJSONErrorCodes, WebhookClient, escapeMarkdown } from 'discord.js';
import { getBridge, markBridgeAnnounced, type MinecraftBridge } from './storage.ts';

// The relay's opt-in (decision 0006): before anything posted in a bridge's
// chat channel goes into the game, the bot says so there, once per channel.
// It's posted when a helper is first active on the bridge rather than at
// pairing (the owner's call, 2026-11-24), so it comes when chat starts to
// flow, and one place covers a chat channel that moved and a post Discord
// refused.

/** After a refused post, how long before a helper's next request tries again. */
export const ANNOUNCEMENT_RETRY_MS = 10 * 60_000;

export interface AnnouncementPost {
	webhook: { id: string; token: string };
	username: string;
	content: string;
}

export interface Announcer {
	/** Announces the relay in the bridge's chat channel unless it's already been, or a try is under way or too recent. */
	ensure(bridge: MinecraftBridge): Promise<void>;
	/** For shutdown: a post that finishes later records nothing, as the database is about to close. */
	close(): void;
}

export function announcementText(serverName: string): string {
	const name = `**${escapeMarkdown(serverName)}**`;
	return (
		`Messages posted in this channel now also show in game on ${name}, under your server nickname. ` +
		"Posting here means you're OK with that. " +
		`If you play on ${name}, you can link your account in the dashboard to choose the picture shown with your Minecraft chat here.`
	);
}

export function createAnnouncer(options: {
	post: (post: AnnouncementPost) => Promise<void>;
	now?: () => number;
}): Announcer {
	const now = options.now ?? Date.now;
	const inFlight = new Set<string>();
	const nextTryAt = new Map<string, number>();
	// A webhook Discord says is gone won't come back; regenerating makes a new one.
	const goneWebhooks = new Set<string>();
	let closed = false;

	return {
		async ensure(bridge) {
			const channelId = bridge.chat_channel_id;
			const webhookId = bridge.chat_webhook_id;
			if (closed || bridge.announced_channel_id === channelId) return;
			if (inFlight.has(bridge.id) || goneWebhooks.has(webhookId)) return;
			if ((nextTryAt.get(bridge.id) ?? 0) > now()) return;

			inFlight.add(bridge.id);
			try {
				await options.post({
					webhook: { id: webhookId, token: bridge.chat_webhook_token },
					username: bridge.server_name,
					content: announcementText(bridge.server_name),
				});
				if (closed) return;
				nextTryAt.delete(bridge.id);
				// The bridge may have been removed, or its chat moved, while posting.
				if (getBridge(bridge.id)?.chat_channel_id === channelId) markBridgeAnnounced(bridge.id, channelId);
			} catch (error) {
				if ((error as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownWebhook) {
					goneWebhooks.add(webhookId);
					console.error(
						`Minecraft bridge ${bridge.id}: its chat webhook is gone; the relay stays off until it's regenerated.`,
					);
				} else {
					nextTryAt.set(bridge.id, now() + ANNOUNCEMENT_RETRY_MS);
					console.error(`Minecraft bridge ${bridge.id}: announcing the relay failed; trying again later:`, error);
				}
			} finally {
				inFlight.delete(bridge.id);
			}
		},
		close() {
			closed = true;
		},
	};
}

/** Posts through the bridge's webhook with its token, which needs no permission of the bot's. */
export async function postWithWebhook({ webhook, username, content }: AnnouncementPost): Promise<void> {
	const client = new WebhookClient(webhook);
	try {
		// Nothing pings: the server's name is the server owner's text.
		await client.send({ content, username, allowedMentions: { parse: [] } });
	} finally {
		client.destroy();
	}
}
