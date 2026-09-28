import { describe, expect, it } from 'vitest';

import { collectWebsites, hostKey } from '../nodes/WebsiteContacts/inputs';

describe('hostKey', () => {
	it('reads the host of a full URL', () => {
		expect(hostKey('https://Example.COM/contact?x=1')).toBe('example.com');
	});

	it('reads a bare domain', () => {
		expect(hostKey('example.com')).toBe('example.com');
		expect(hostKey('shop.example.com/about')).toBe('shop.example.com');
	});

	it('keeps www and other subdomains', () => {
		expect(hostKey('www.example.com')).toBe('www.example.com');
	});

	it('drops a trailing dot', () => {
		expect(hostKey('example.com.')).toBe('example.com');
	});

	it('punycodes international domains', () => {
		expect(hostKey('bücher.de')).toBe('xn--bcher-kva.de');
	});

	it('falls back to the lowercased text when it is not a URL', () => {
		expect(hostKey('  Not A URL ')).toBe('not a url');
	});
});

describe('collectWebsites', () => {
	it('takes one website per item', () => {
		const w = collectWebsites(['a.com', 'https://b.com']);
		expect(w.entries).toEqual(['a.com', 'https://b.com']);
		expect(w.byHost.get('a.com')).toEqual([0]);
		expect(w.byHost.get('b.com')).toEqual([1]);
		expect(w.byEntry.get('https://b.com')).toEqual([1]);
	});

	it('splits lines, trims and skips blanks', () => {
		const w = collectWebsites(['  a.com \r\n\n b.com\n', '', '   ']);
		expect(w.entries).toEqual(['a.com', 'b.com']);
		expect(w.byHost.get('b.com')).toEqual([0]);
	});

	it('sends a repeated website once and remembers every item that asked for it', () => {
		const w = collectWebsites(['a.com', 'a.com', 'A.com']);
		expect(w.entries).toEqual(['a.com', 'A.com']);
		expect(w.byEntry.get('a.com')).toEqual([0, 1]);
		expect(w.byHost.get('a.com')).toEqual([0, 1, 2]);
	});

	it('records an item once per key even when it lists a host twice', () => {
		const w = collectWebsites(['a.com\nhttps://a.com/about']);
		expect(w.entries).toEqual(['a.com', 'https://a.com/about']);
		expect(w.byHost.get('a.com')).toEqual([0]);
	});

	it('returns no entries when every value is blank', () => {
		expect(collectWebsites(['', ' \n ']).entries).toEqual([]);
	});
});
