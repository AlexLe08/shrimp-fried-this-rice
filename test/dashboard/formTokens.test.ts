import { describe, expect, it } from 'vitest';
import { FORM_TOKEN_LIFETIME_MS, MAX_FORM_TOKENS, createFormTokens } from '../../src/dashboard/formTokens.ts';

describe('form tokens', () => {
	it('takes a token once', () => {
		const tokens = createFormTokens(() => 0);
		const token = tokens.issue('pair:g1:u1');

		expect(tokens.take(token, 'pair:g1:u1')).toBe(true);
		expect(tokens.take(token, 'pair:g1:u1')).toBe(false);
	});

	it("refuses another form's token, and uses it up", () => {
		const tokens = createFormTokens(() => 0);
		const token = tokens.issue('pair:g1:u2');

		expect(tokens.take(token, 'pair:g1:u1')).toBe(false);
		expect(tokens.take(token, 'pair:g1:u2')).toBe(false);
	});

	it('refuses an unknown token', () => {
		expect(createFormTokens(() => 0).take('made-up', 'pair:g1:u1')).toBe(false);
	});

	it(`refuses a token ${FORM_TOKEN_LIFETIME_MS / 60_000} minutes old`, () => {
		let time = 0;
		const tokens = createFormTokens(() => time);
		const fresh = tokens.issue('k');
		const stale = tokens.issue('k');

		time = FORM_TOKEN_LIFETIME_MS - 1;
		expect(tokens.take(fresh, 'k')).toBe(true);
		time = FORM_TOKEN_LIFETIME_MS;
		expect(tokens.take(stale, 'k')).toBe(false);
	});

	it(`keeps at most ${MAX_FORM_TOKENS}, dropping the oldest`, () => {
		const tokens = createFormTokens(() => 0);
		const first = tokens.issue('k');
		const second = tokens.issue('k');
		for (let i = 2; i < MAX_FORM_TOKENS; i += 1) tokens.issue('k');

		const last = tokens.issue('k');

		expect(tokens.take(first, 'k')).toBe(false);
		expect(tokens.take(second, 'k')).toBe(true);
		expect(tokens.take(last, 'k')).toBe(true);
	});
});
