import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INode,
	NodeExecutionHint,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { ACTOR_ID } from '../nodes/WebsiteContacts/apify';
import { WebsiteContacts } from '../nodes/WebsiteContacts/WebsiteContacts.node';

const node: INode = {
	id: 'node1',
	name: 'Website Contact & Socials Extractor',
	type: '@entityplane/n8n-nodes-website-contacts.websiteContacts',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

type Reply = { statusCode: number; body: unknown };
type Route = (options: IHttpRequestOptions) => Reply;

interface Setup {
	websites: string[];
	options?: IDataObject;
	continueOnFail?: boolean;
	toolMode?: boolean;
	signal?: AbortSignal;
	routes: Record<string, Route>;
}

const ok = (body: unknown): Reply => ({ statusCode: 200, body });
const runData = (status: string, extra: IDataObject = {}) =>
	ok({
		data: {
			id: 'run1',
			status,
			statusMessage: null,
			defaultDatasetId: 'contacts',
			defaultKeyValueStoreId: 'kv',
			storageIds: { datasets: { default: 'contacts', rejected_inputs: 'rejected' } },
			...extra,
		},
	});

function execute(setup: Setup) {
	const requests: IHttpRequestOptions[] = [];
	const hints: NodeExecutionHint[] = [];
	const route = (options: IHttpRequestOptions) => {
		const path = new URL(options.url).pathname;
		const handler = setup.routes[`${options.method} ${path}`];
		if (!handler) throw new Error(`no route for ${options.method} ${path}`);
		return handler(options);
	};
	const context = {
		getInputData: () => setup.websites.map((website) => ({ json: { website } })),
		getNodeParameter: (name: string, i: number, fallback?: unknown) => {
			if (name === 'website') return setup.websites[i];
			if (name === 'authentication') return 'apifyApi';
			if (name === 'options') return setup.options ?? {};
			return fallback;
		},
		getNode: () => node,
		isToolExecution: () => setup.toolMode ?? false,
		continueOnFail: () => setup.continueOnFail ?? false,
		getExecutionCancelSignal: () => setup.signal,
		addExecutionHints: (...added: NodeExecutionHint[]) => hints.push(...added),
		getCredentials: async (type: string) => {
			expect(type).toBe('apifyApi');
			return { apiKey: 'apify-token' };
		},
		helpers: {
			httpRequestWithAuthentication: async (credential: string, options: IHttpRequestOptions) => {
				expect(credential).toBe('apifyApi');
				// Like n8n, which ties authenticated requests to the execution's cancel signal.
				if (setup.signal?.aborted) throw new Error('This operation was aborted');
				requests.push(options);
				return route(options);
			},
			httpRequest: async (options: IHttpRequestOptions) => {
				requests.push(options);
				return route(options);
			},
		},
	} as unknown as IExecuteFunctions;
	const result = new WebsiteContacts().execute.call(context);
	return { result, requests, hints };
}

const finishedRun = (status = 'SUCCEEDED', extra: IDataObject = {}): Record<string, Route> => ({
	[`POST /v2/acts/${ACTOR_ID}/runs`]: () => runData('READY'),
	'GET /v2/actor-runs/run1': () => runData(status, extra),
	'GET /v2/datasets/contacts/items': () =>
		ok([
			{
				domain: 'a.com',
				outcome: 'contacts_found',
				emails: ['hi@a.com'],
				phones: [],
				start_urls: ['a.com'],
			},
		]),
	'GET /v2/datasets/rejected/items': () => ok([{ input: 'bad', rejection_reason: 'not_a_url' }]),
	'GET /v2/key-value-stores/kv/records/OUTPUT': () =>
		ok({ freePlan: { kept: 2, omitted: 0 }, unscheduled: null }),
});

describe('WebsiteContacts.execute', () => {
	it('runs the actor once for all items and returns one item per result', async () => {
		const { result, requests, hints } = execute({
			websites: ['a.com', 'bad', 'a.com'],
			options: { maxCacheAgeHours: 48, maxTotalChargeUsd: 1.5 },
			routes: finishedRun(),
		});
		const [output] = await result;

		const start = requests[0];
		expect(start.body).toEqual({ startUrls: ['a.com', 'bad'], maxCacheAgeHours: 48 });
		expect(start.qs).toEqual({ maxTotalChargeUsd: 1.5 });
		expect(start.headers).toMatchObject({ 'x-apify-integration-platform': 'n8n' });
		expect(start.returnFullResponse).toBe(true);
		expect(requests.find((r) => r.url.endsWith('/contacts/items'))?.qs).toMatchObject({
			view: 'contacts',
		});

		expect(output.map((i) => [i.json.domain ?? i.json.input, i.pairedItem])).toEqual([
			['a.com', [{ item: 0 }, { item: 2 }]],
			['bad', { item: 1 }],
		]);
		expect(hints).toEqual([]);
	});

	it('reads full rows when sources and counts are requested', async () => {
		const { result, requests } = execute({
			websites: ['a.com'],
			options: { includeDetails: true },
			routes: finishedRun(),
		});
		await result;
		expect(requests.find((r) => r.url.endsWith('/contacts/items'))?.qs).not.toHaveProperty('view');
	});

	it('shows the run message when websites were left out', async () => {
		const routes = finishedRun('SUCCEEDED', {
			statusMessage: 'Done: 10 host results. Free plan: 10 of 12 websites accepted, 2 left out.',
		});
		routes['GET /v2/key-value-stores/kv/records/OUTPUT'] = () =>
			ok({ freePlan: { kept: 10, omitted: 2 }, unscheduled: null });
		const { result, hints } = execute({ websites: ['a.com'], routes });
		await result;
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatchObject({ type: 'warning', location: 'outputPane' });
		expect(hints[0].message).toContain('2 left out.');
		expect(hints[0].message).toContain('https://console.apify.com/view/runs/run1');
	});

	it("fails with the actor's message when the run does not succeed", async () => {
		const { result, requests } = execute({
			websites: ['a.com'],
			routes: finishedRun('FAILED', { statusMessage: 'Charge limit reached after 3 domains.' }),
		});
		await expect(result).rejects.toThrow('Charge limit reached after 3 domains.');
		expect(requests.some((r) => r.url.includes('/datasets/'))).toBe(false);
	});

	it('returns the results so far plus an error item when continuing on fail', async () => {
		const { result } = execute({
			websites: ['a.com', 'bad'],
			continueOnFail: true,
			routes: finishedRun('TIMED-OUT', { statusMessage: 'The run reached its timeout.' }),
		});
		const [output] = await result;
		expect(output).toHaveLength(3);
		expect(output[2].json).toEqual({
			error: 'The run reached its timeout.',
			runUrl: 'https://console.apify.com/view/runs/run1',
		});
	});

	it('refuses a cost limit below the minimum the actor accepts', async () => {
		const { result, requests } = execute({
			websites: ['a.com'],
			options: { maxTotalChargeUsd: 0.01 },
			routes: finishedRun(),
		});
		await expect(result).rejects.toThrow('Max Cost per Run must be at least $0.025');
		expect(requests).toHaveLength(0);
	});

	it('refuses to start without websites', async () => {
		const { result, requests } = execute({ websites: ['', '  '], routes: finishedRun() });
		await expect(result).rejects.toThrow(NodeOperationError);
		expect(requests).toHaveLength(0);
	});

	it('aborts the Apify run when the execution is cancelled', async () => {
		const controller = new AbortController();
		const routes = finishedRun();
		routes['GET /v2/actor-runs/run1'] = () => {
			controller.abort();
			return runData('ABORTED');
		};
		routes['POST /v2/actor-runs/run1/abort'] = () => runData('ABORTING');
		const { result, requests } = execute({
			websites: ['a.com'],
			signal: controller.signal,
			routes,
		});
		await expect(result).rejects.toThrow();
		await vi.waitFor(() => {
			const abort = requests.find((r) => r.url.endsWith('/v2/actor-runs/run1/abort'));
			expect(abort?.headers).toMatchObject({ Authorization: 'Bearer apify-token' });
		});
	});

	it('marks AI tool calls and trims empty lists', async () => {
		const { result, requests } = execute({
			websites: ['a.com'],
			toolMode: true,
			routes: finishedRun(),
		});
		const [output] = await result;
		expect(requests[0].headers).toMatchObject({ 'x-apify-integration-ai-tool': 'true' });
		expect(output[0].json).not.toHaveProperty('phones');
	});

	it('reports Apify API errors with their status code', async () => {
		const { result } = execute({
			websites: ['a.com'],
			routes: {
				[`POST /v2/acts/${ACTOR_ID}/runs`]: () => ({
					statusCode: 401,
					body: { error: { message: 'User was not found or authentication token is not valid' } },
				}),
			},
		});
		await expect(result).rejects.toMatchObject({
			message: 'User was not found or authentication token is not valid',
			httpCode: '401',
		});
	});
});
