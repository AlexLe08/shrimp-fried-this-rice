import { describe, it, expect, vi, afterEach } from 'vitest';
import { toEventListener } from '../src/eventListener.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

// Lets the wrapper's promise settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('toEventListener', () => {
	it('passes the event arguments to the handler', async () => {
		const execute = vi.fn().mockResolvedValue(undefined);

		toEventListener('interactionCreate', execute)('a', 'b');
		await settle();

		expect(execute).toHaveBeenCalledWith('a', 'b');
	});

	it('logs a rejected handler instead of leaving the rejection unhandled', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const error = new Error('Unknown interaction');

		toEventListener('interactionCreate', () => Promise.reject(error))();
		await settle();

		expect(consoleSpy).toHaveBeenCalledWith('Unhandled error in the interactionCreate handler:', error);
	});

	it('logs a handler that throws synchronously, and returns normally', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const error = new Error('boom');
		const listener = toEventListener('clientReady', () => {
			throw error;
		});

		expect(() => listener()).not.toThrow();
		await settle();

		expect(consoleSpy).toHaveBeenCalledWith('Unhandled error in the clientReady handler:', error);
	});
});
