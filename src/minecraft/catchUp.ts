import { SnowflakeUtil, type Channel } from 'discord.js';
import type { HelperHub } from './helperHub.ts';
import {
	chatFor,
	firstLiveMessageId,
	holdLiveMessages,
	isLaterMessage,
	isMemberChat,
	releaseLiveMessages,
} from './relay.ts';
import { getBridgesToCatchUp, recordRelayedMessage, type MinecraftBridge } from './storage.ts';

// Catching up after a restart (decision 0010): Discord doesn't replay over
// the gateway what the bot missed while it was down, as on every deploy, so
// once ready it asks the API for each relaying bridge's chat since the last
// message it relayed. Only what's recent: anything older or past the first 20
// is dropped, as before the decision.

export const CATCH_UP_MAX_AGE_MS = 5 * 60_000;
export const CATCH_UP_MAX_MESSAGES = 20;
/** Longer than a live message's 30 s: the helper may still be backing off (up to 60 s) from the restart. */
export const CATCH_UP_HOLD_MS = 2 * 60_000;
// Discord's most per request. Its docs list the answer newest first but
// don't say which messages `after` picks, so ask for all it allows, sort,
// and keep the oldest. Past 100 in 5 minutes isn't a bridge channel's pace.
const FETCH_LIMIT = 100;

/** What the catch-up uses of discord.js's Client. */
export interface CatchUpClient {
	channels: { fetch(id: string): Promise<Channel | null> };
}

/**
 * Catches up every relaying bridge. Its live messages wait meanwhile, then
 * follow the caught-up ones. Nothing is caught up without the dashboard's
 * hub (no helper could poll), and nothing is recorded once shutdown has
 * closed it.
 */
export async function catchUpBridges(client: CatchUpClient, hub: HelperHub | null, now = Date.now()): Promise<void> {
	if (!hub) return;
	const bridges = getBridgesToCatchUp();
	// All at once, before any await, so no live message slips past its hold.
	for (const bridge of bridges) holdLiveMessages(bridge.id);
	await Promise.all(
		bridges.map(async (bridge) => {
			try {
				await catchUp(client, hub, bridge, now);
			} catch (error) {
				// Discord's errors carry no chat text; the message ids aren't logged either.
				console.error(`Minecraft bridge ${bridge.id}: catching up after the restart failed:`, describe(error));
			} finally {
				releaseLiveMessages(bridge.id, hub.closed ? null : hub);
			}
		}),
	);
}

async function catchUp(client: CatchUpClient, hub: HelperHub, bridge: MinecraftBridge, now: number): Promise<void> {
	const oldest = SnowflakeUtil.generate({ timestamp: now - CATCH_UP_MAX_AGE_MS }).toString();
	const last = bridge.last_relayed_message_id;
	const after = isLaterMessage(oldest, last) ? oldest : last!;

	const channel = await client.channels.fetch(bridge.chat_channel_id);
	if (!channel?.isTextBased() || channel.isDMBased()) return;
	// Without Read Message History, Discord answers with no messages, not an error.
	const fetched = await channel.messages.fetch({ after, limit: FETCH_LIMIT, cache: false });
	if (hub.closed) return;

	const firstLive = firstLiveMessageId(bridge.id);
	const missed = [...fetched.values()]
		.filter(
			(message) =>
				isMemberChat(message) &&
				isLaterMessage(message.id, after) &&
				(!firstLive || isLaterMessage(firstLive, message.id)),
		)
		.sort((a, b) => (isLaterMessage(a.id, b.id) ? 1 : -1))
		.slice(0, CATCH_UP_MAX_MESSAGES);
	for (const message of missed) {
		const chat = chatFor(message);
		if (chat && hub.deliver(bridge.id, chat, CATCH_UP_HOLD_MS)) recordRelayedMessage(bridge.id, message.id);
	}
}

function describe(error: unknown): string {
	const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
	return [status, code, message].filter((part) => typeof part === 'number' || typeof part === 'string').join(' ');
}
