import { describe, expect, it } from 'vitest';

import { collectWebsites } from '../nodes/WebsiteContacts/inputs';
import { toOutputItems } from '../nodes/WebsiteContacts/pairing';

const flat = { includeDetails: false, toolMode: false };

function row(domain: string, extra: Record<string, unknown> = {}) {
	return {
		domain,
		outcome: 'contacts_found',
		emails: [`hello@${domain}`],
		phones: [],
		start_urls: [domain],
		...extra,
	};
}

describe('toOutputItems', () => {
	it('pairs each contacts row with the item that submitted its host', () => {
		const websites = collectWebsites(['a.com', 'https://b.com/contact']);
		const out = toOutputItems(
			[row('b.com', { start_urls: ['https://b.com/contact'] }), row('a.com')],
			[],
			websites,
			flat,
		);
		expect(out.map((i) => [i.json.domain, i.pairedItem])).toEqual([
			['a.com', { item: 0 }],
			['b.com', { item: 1 }],
		]);
	});

	it('pairs one row with every item that asked for the same website', () => {
		const websites = collectWebsites(['a.com', 'https://a.com/about', 'b.com']);
		const [item] = toOutputItems([row('a.com')], [], websites, flat);
		expect(item.pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('pairs a www redirect row through redirected_from or its inherited start URLs', () => {
		const websites = collectWebsites(['x.com', 'example.com']);
		const viaFull = toOutputItems(
			[row('www.example.com', { redirected_from: 'example.com', start_urls: [] })],
			[],
			websites,
			flat,
		);
		const viaStartUrls = toOutputItems(
			[row('www.example.com', { start_urls: ['example.com'] })],
			[],
			websites,
			flat,
		);
		expect(viaFull[0].pairedItem).toEqual({ item: 1 });
		expect(viaStartUrls[0].pairedItem).toEqual({ item: 1 });
	});

	it('matches start URLs the backend normalised', () => {
		const websites = collectWebsites(['x.com', 'Example.com']);
		const [item] = toOutputItems(
			[row('example.com', { start_urls: ['https://example.com/'] })],
			[],
			websites,
			flat,
		);
		expect(item.pairedItem).toEqual({ item: 1 });
	});

	it('falls back to the first item when nothing matches', () => {
		const websites = collectWebsites(['a.com']);
		const [item] = toOutputItems([row('other.com', { start_urls: [] })], [], websites, flat);
		expect(item.pairedItem).toEqual({ item: 0 });
	});

	it('keeps the first row of a repeated domain', () => {
		const websites = collectWebsites(['a.com']);
		const out = toOutputItems(
			[row('a.com', { emails: ['first@a.com'] }), row('a.com', { emails: ['second@a.com'] })],
			[],
			websites,
			flat,
		);
		expect(out).toHaveLength(1);
		expect(out[0].json.emails).toEqual(['first@a.com']);
	});

	it('turns rejected inputs into items paired by exact input or by host', () => {
		const websites = collectWebsites(['not a url', 'https://gov.example/x']);
		const out = toOutputItems(
			[],
			[
				{ input: 'not a url', rejection_reason: 'not_a_url' },
				{ input: 'gov.example', rejection_reason: 'government domains are not supported' },
			],
			websites,
			flat,
		);
		expect(out.map((i) => [i.json, i.pairedItem])).toEqual([
			[{ input: 'not a url', outcome: 'rejected', rejection_reason: 'not_a_url' }, { item: 0 }],
			[
				{
					input: 'gov.example',
					outcome: 'rejected',
					rejection_reason: 'government domains are not supported',
				},
				{ item: 1 },
			],
		]);
	});

	it('includes rejected_input details only when asked', () => {
		const websites = collectWebsites(['x']);
		const rejected = [
			{
				input: 'xxx…',
				rejection_reason: 'not_a_url',
				rejected_input: { truncated: true, original_bytes: 5000, sha256: 'abc' },
			},
		];
		const [plain] = toOutputItems([], rejected, websites, flat);
		const [detailed] = toOutputItems([], rejected, websites, { ...flat, includeDetails: true });
		expect(plain.json.rejected_input).toBeUndefined();
		expect(detailed.json.rejected_input).toEqual(rejected[0].rejected_input);
	});

	it('removes repeated rejected rows by fingerprint or input', () => {
		const websites = collectWebsites(['bad']);
		const out = toOutputItems(
			[],
			[
				{ input: 'bad', rejection_reason: 'not_a_url' },
				{ input: 'bad', rejection_reason: 'not_a_url' },
				{ input: 'p…', rejection_reason: 'not_a_url', rejected_input: { sha256: 'h' } },
				{ input: 'p…', rejection_reason: 'not_a_url', rejected_input: { sha256: 'h' } },
			],
			websites,
			flat,
		);
		expect(out).toHaveLength(2);
	});

	it('orders output by the first input item it belongs to', () => {
		const websites = collectWebsites(['a.com', 'bad', 'c.com']);
		const out = toOutputItems(
			[row('c.com'), row('a.com')],
			[{ input: 'bad', rejection_reason: 'not_a_url' }],
			websites,
			flat,
		);
		expect(out.map((i) => i.json.domain ?? i.json.input)).toEqual(['a.com', 'bad', 'c.com']);
	});

	it('leaves out empty lists when running as an AI tool', () => {
		const websites = collectWebsites(['a.com']);
		const [item] = toOutputItems([row('a.com')], [], websites, { ...flat, toolMode: true });
		expect(item.json).not.toHaveProperty('phones');
		expect(item.json.emails).toEqual(['hello@a.com']);
	});
});
