import { describe, expect, it } from 'vitest';
import { MAX_KEYS, createRateLimiter, visitorKey } from '../../src/dashboard/rateLimit.ts';

describe('createRateLimiter', () => {
	it('allows `limit` requests per key in a window, then says how long until it resets', () => {
		let time = 0;
		const limiter = createRateLimiter(2, 60_000, () => time);

		expect(limiter.take('a')).toBe(0);
		expect(limiter.take('a')).toBe(0);
		time = 15_000;
		expect(limiter.take('a')).toBe(45_000);
		expect(limiter.take('b')).toBe(0);
	});

	it('allows the key again once its window has passed', () => {
		let time = 0;
		const limiter = createRateLimiter(1, 60_000, () => time);
		limiter.take('a');

		time = 59_999;
		expect(limiter.take('a')).toBe(1);
		time = 60_000;
		expect(limiter.take('a')).toBe(0);
	});

	it('puts new keys in one shared bucket once it holds MAX_KEYS live ones', () => {
		const limiter = createRateLimiter(1, 60_000, () => 0);
		for (let i = 0; i < MAX_KEYS; i++) limiter.take(`k${i}`);

		expect(limiter.take('new-1')).toBe(0);
		expect(limiter.take('new-2')).toBeGreaterThan(0);
		expect(limiter.take('k0')).toBeGreaterThan(0);
	});

	it('makes room for new keys once the old ones have expired', () => {
		let time = 0;
		const limiter = createRateLimiter(1, 60_000, () => time);
		for (let i = 0; i < MAX_KEYS; i++) limiter.take(`k${i}`);

		time = 60_000;
		expect(limiter.take('new-1')).toBe(0);
		expect(limiter.take('new-2')).toBe(0);
	});
});

describe('visitorKey', () => {
	it('keys an IPv4 address as itself', () => {
		expect(visitorKey('203.0.113.7')).toBe('203.0.113.7');
		expect(visitorKey(' 203.0.113.7 ')).toBe('203.0.113.7');
	});

	it.each([
		['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
		['2001:DB8:1:2::9', '2001:db8:1:2::/64'],
		['2001:db8::1', '2001:db8:0:0::/64'],
		['::1', '0:0:0:0::/64'],
		['2001:db8:1:2:3:4:1.2.3.4', '2001:db8:1:2::/64'],
	])('keys the IPv6 address %s by its /64, %s', (address, key) => {
		expect(visitorKey(address)).toBe(key);
	});

	it('gives every address in one /64 the same key', () => {
		expect(visitorKey('2001:db8:1:2::a')).toBe(visitorKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
	});

	it.each([undefined, '', 'not-an-ip', '203.0.113.7, 198.51.100.1'])(
		'puts a missing or malformed header (%s) in one shared bucket',
		(header) => {
			expect(visitorKey(header)).toBe('unknown');
		},
	);
});
