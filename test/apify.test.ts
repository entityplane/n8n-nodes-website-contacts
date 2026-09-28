import type { INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
	ACTOR_ID,
	ApifyClient,
	type ApiRequest,
	type ApiResponse,
} from '../nodes/WebsiteContacts/apify';

const node: INode = {
	id: 'node1',
	name: 'Website Contact & Socials Extractor',
	type: '@entityplane/n8n-nodes-website-contacts.websiteContacts',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function fakeApi(responses: Array<ApiResponse | Error>) {
	const requests: ApiRequest[] = [];
	const sleeps: number[] = [];
	const client = new ApifyClient({
		node,
		send: async (request) => {
			requests.push(request);
			const next = responses.shift();
			if (!next) throw new Error('unexpected request');
			if (next instanceof Error) throw next;
			return next;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { client, requests, sleeps };
}

const ok = (body: unknown): ApiResponse => ({ statusCode: 200, body });
const run = (status: string, extra: Record<string, unknown> = {}) =>
	ok({
		data: {
			id: 'run1',
			status,
			statusMessage: null,
			defaultDatasetId: 'ds1',
			defaultKeyValueStoreId: 'kv1',
			...extra,
		},
	});

describe('startRun', () => {
	it('starts the actor with the input and the optional cost limit', async () => {
		const { client, requests } = fakeApi([run('READY')]);
		const started = await client.startRun({ startUrls: ['a.com'] }, 2.5);
		expect(started.id).toBe('run1');
		expect(requests[0]).toEqual({
			method: 'POST',
			path: `/v2/acts/${ACTOR_ID}/runs`,
			qs: { maxTotalChargeUsd: 2.5 },
			body: { startUrls: ['a.com'] },
		});
	});

	it('does not retry a failed start, which could start the actor twice', async () => {
		const { client, requests } = fakeApi([{ statusCode: 502, body: '' }]);
		await expect(client.startRun({ startUrls: ['a.com'] })).rejects.toThrow(NodeApiError);
		expect(requests).toHaveLength(1);
	});

	it('retries a rate-limited start', async () => {
		const { client, requests } = fakeApi([{ statusCode: 429, body: {} }, run('READY')]);
		await client.startRun({ startUrls: ['a.com'] });
		expect(requests).toHaveLength(2);
	});

	it("passes Apify's error message through", async () => {
		const { client } = fakeApi([
			{ statusCode: 402, body: { error: { message: 'Not enough usage left.' } } },
		]);
		await expect(client.startRun({ startUrls: ['a.com'] })).rejects.toMatchObject({
			message: 'Not enough usage left.',
			httpCode: '402',
		});
	});
});

describe('waitForFinish', () => {
	it('long-polls until the run reaches a final status', async () => {
		const { client, requests } = fakeApi([
			run('RUNNING'),
			run('TIMING-OUT'),
			run('TIMED-OUT', { statusMessage: 'The run reached its timeout.' }),
		]);
		const finished = await client.waitForFinish('run1');
		expect(finished.status).toBe('TIMED-OUT');
		expect(finished.statusMessage).toBe('The run reached its timeout.');
		expect(requests.map((r) => r.qs)).toEqual([
			{ waitForFinish: 60 },
			{ waitForFinish: 60 },
			{ waitForFinish: 60 },
		]);
	});

	it('rides out network errors and server errors with growing pauses', async () => {
		const { client, sleeps } = fakeApi([
			new Error('socket hang up'),
			{ statusCode: 503, body: '' },
			run('SUCCEEDED'),
		]);
		expect((await client.waitForFinish('run1')).status).toBe('SUCCEEDED');
		expect(sleeps).toEqual([1000, 2000]);
	});

	it('gives up after the last retry', async () => {
		const failures = Array.from({ length: 6 }, () => ({ statusCode: 500, body: '' }));
		const { client, requests } = fakeApi(failures);
		await expect(client.waitForFinish('run1')).rejects.toThrow('Apify API returned HTTP 500');
		expect(requests).toHaveLength(6);
	});
});

describe('listItems', () => {
	it('pages until a short page', async () => {
		const full = Array.from({ length: 1000 }, (_, i) => ({ domain: `d${i}.com` }));
		const { client, requests } = fakeApi([ok(full), ok([{ domain: 'last.com' }])]);
		const rows = await client.listItems('ds1', { view: 'contacts' });
		expect(rows).toHaveLength(1001);
		expect(requests.map((r) => r.qs)).toEqual([
			{ view: 'contacts', offset: 0, limit: 1000 },
			{ view: 'contacts', offset: 1000, limit: 1000 },
		]);
	});
});

describe('getRecord', () => {
	it('returns the record, or null when it does not exist', async () => {
		const { client } = fakeApi([ok({ phase: 'done' }), { statusCode: 404, body: {} }]);
		expect(await client.getRecord('kv1', 'OUTPUT')).toEqual({ phase: 'done' });
		expect(await client.getRecord('kv1', 'OUTPUT')).toBeNull();
	});
});

describe('abortRun', () => {
	it('asks Apify to abort the run', async () => {
		const { client, requests } = fakeApi([run('ABORTING')]);
		await client.abortRun('run1');
		expect(requests[0]).toMatchObject({ method: 'POST', path: '/v2/actor-runs/run1/abort' });
	});
});
