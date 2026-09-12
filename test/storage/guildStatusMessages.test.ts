import { describe, it, expect, beforeEach } from 'vitest';
import {
	setGuildStatusMessage,
	getGuildStatusMessage,
	deleteGuildStatusMessage,
	__resetForTests,
} from '../../src/storage.ts';

beforeEach(() => {
	__resetForTests();
});

describe('setGuildStatusMessage / getGuildStatusMessage', () => {
	it('returns undefined when no status message is tracked', () => {
		expect(getGuildStatusMessage('guild-1')).toBeUndefined();
	});

	it('creates a new row when none exists', () => {
		setGuildStatusMessage('guild-1', 'channel-1', 'message-1');
		const status = getGuildStatusMessage('guild-1');
		expect(status?.channel_id).toBe('channel-1');
		expect(status?.message_id).toBe('message-1');
	});

	it('updates the existing row in place when called again for the same guild', () => {
		setGuildStatusMessage('guild-1', 'channel-1', 'message-1');
		setGuildStatusMessage('guild-1', 'channel-2', 'message-2');

		const status = getGuildStatusMessage('guild-1');
		expect(status?.channel_id).toBe('channel-2');
		expect(status?.message_id).toBe('message-2');
	});
});

describe('deleteGuildStatusMessage', () => {
	it('removes the tracked status message', () => {
		setGuildStatusMessage('guild-1', 'channel-1', 'message-1');
		deleteGuildStatusMessage('guild-1');
		expect(getGuildStatusMessage('guild-1')).toBeUndefined();
	});

	it('does nothing if no status message was tracked to begin with', () => {
		expect(() => deleteGuildStatusMessage('nonexistent-guild')).not.toThrow();
	});
});