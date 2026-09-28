import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import { ApifyClient, type ActorRun, type ApiRequest } from './apify';
import { collectWebsites } from './inputs';
import { toOutputItems } from './pairing';

interface Options {
	maxCacheAgeHours?: number;
	maxTotalChargeUsd?: number;
	includeDetails?: boolean;
}

const DEFAULT_MAX_CACHE_AGE_HOURS = 720;
/** The lowest run spending limit the actor accepts (its `minimalMaxTotalChargeUsd` on Apify). */
const MIN_MAX_TOTAL_CHARGE_USD = 0.025;

function websiteText(value: unknown): string {
	if (Array.isArray(value)) return value.map(websiteText).join('\n');
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function runUrl(runId: string): string {
	return `https://console.apify.com/view/runs/${runId}`;
}

/** The actor's summary says some submitted websites were never processed. */
function leftOut(summary: IDataObject | null): boolean {
	const freePlan = summary?.freePlan as IDataObject | null | undefined;
	return (typeof freePlan?.omitted === 'number' && freePlan.omitted > 0) || !!summary?.unscheduled;
}

/** The access token of the selected Apify credential, API key or OAuth2. */
async function apifyToken(
	this: IExecuteFunctions,
	credentialType: string,
): Promise<string | undefined> {
	const credentials = await this.getCredentials(credentialType);
	const token =
		credentials.apiKey ?? (credentials.oauthTokenData as IDataObject | undefined)?.access_token;
	return typeof token === 'string' ? token : undefined;
}

/**
 * Aborts the Apify run of a stopped execution. n8n cancels every authenticated request of a
 * stopped execution before it is sent, so this one request goes through the plain HTTP helper.
 */
async function abortStoppedRun(
	this: IExecuteFunctions,
	credentialType: string,
	runId: string,
): Promise<void> {
	const token = await apifyToken.call(this, credentialType);
	if (!token) return;
	await this.helpers.httpRequest({
		method: 'POST',
		url: `https://api.apify.com/v2/actor-runs/${runId}/abort`,
		headers: { Authorization: `Bearer ${token}`, 'x-apify-integration-platform': 'n8n' },
		json: true,
	});
}

export class WebsiteContacts implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Website Contact & Socials Extractor',
		name: 'websiteContacts',
		icon: { light: 'file:entityplane.svg', dark: 'file:entityplane.svg' },
		group: ['transform'],
		version: 1,
		subtitle: 'Extract contacts',
		description: 'Extract emails, phone numbers and social media links from company websites',
		defaults: {
			name: 'Website Contact & Socials Extractor',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'apifyApi',
				required: true,
				displayOptions: { show: { authentication: ['apifyApi'] } },
			},
			{
				name: 'apifyOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['apifyOAuth2Api'] } },
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{ name: 'API Key', value: 'apifyApi' },
					{ name: 'OAuth2', value: 'apifyOAuth2Api' },
				],
				default: 'apifyApi',
				description: 'How to connect to your Apify account, which runs and bills the extraction',
			},
			{
				displayName: 'Website',
				name: 'website',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'example.com',
				description:
					'Website to extract contacts from, as a URL or a bare domain. Put several on separate lines to process them together. All input items are processed in one run.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Sources and Counts',
						name: 'includeDetails',
						type: 'boolean',
						default: false,
						description:
							'Whether to add the page and time each contact was found on, full value counts and redirect details',
					},
					{
						displayName: 'Max Cost per Run (USD)',
						name: 'maxTotalChargeUsd',
						type: 'number',
						typeOptions: { minValue: MIN_MAX_TOTAL_CHARGE_USD, numberPrecision: 3 },
						default: 5,
						description:
							'Stop the run once its charges reach this amount, at least $0.025. Websites not processed are reported in the output hint.',
					},
					{
						displayName: 'Maximum Result Age (Hours)',
						name: 'maxCacheAgeHours',
						type: 'number',
						typeOptions: { minValue: 4, numberPrecision: 0 },
						default: DEFAULT_MAX_CACHE_AGE_HOURS,
						description:
							'Websites processed within this window are served from cache at the lower cached rate instead of being crawled again',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const authentication = this.getNodeParameter('authentication', 0) as string;
		const options = this.getNodeParameter('options', 0, {}) as Options;
		const toolMode = typeof this.isToolExecution === 'function' && this.isToolExecution();

		const websites = collectWebsites(
			items.map((_, i) => websiteText(this.getNodeParameter('website', i, ''))),
		);
		if (websites.entries.length === 0) {
			throw new NodeOperationError(this.getNode(), 'No websites provided', {
				description:
					'Set Website to a URL or domain such as example.com, or map it from the input.',
			});
		}
		if (
			options.maxTotalChargeUsd !== undefined &&
			!(options.maxTotalChargeUsd >= MIN_MAX_TOTAL_CHARGE_USD)
		) {
			throw new NodeOperationError(
				this.getNode(),
				`Max Cost per Run must be at least $${MIN_MAX_TOTAL_CHARGE_USD}`,
			);
		}

		const client = new ApifyClient({
			node: this.getNode(),
			send: async ({ method, path, qs, body }: ApiRequest) => {
				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					authentication,
					{
						method,
						url: `https://api.apify.com${path}`,
						qs,
						body,
						json: true,
						headers: {
							'x-apify-integration-platform': 'n8n',
							'x-apify-integration-app-id': 'website-contact-socials-extractor-app',
							...(toolMode ? { 'x-apify-integration-ai-tool': 'true' } : {}),
						},
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
					},
				);
				return { statusCode: response.statusCode, body: response.body };
			},
			sleep,
		});

		let run: ActorRun | undefined;
		let output: INodeExecutionData[] = [];
		try {
			run = await client.startRun(
				{
					startUrls: websites.entries,
					maxCacheAgeHours: options.maxCacheAgeHours ?? DEFAULT_MAX_CACHE_AGE_HOURS,
				},
				options.maxTotalChargeUsd,
			);

			// Stopping the workflow stops the Apify run, so no further websites are charged.
			const runId = run.id;
			this.getExecutionCancelSignal?.()?.addEventListener(
				'abort',
				() => void abortStoppedRun.call(this, authentication, runId).catch(() => undefined),
				{ once: true },
			);

			run = await client.waitForFinish(run.id);
			const succeeded = run.status === 'SUCCEEDED';

			if (succeeded || this.continueOnFail()) {
				const contacts = await client.listItems(
					run.defaultDatasetId,
					options.includeDetails ? {} : { view: 'contacts' },
				);
				const rejectedId = run.storageIds?.datasets?.rejected_inputs;
				const rejected = rejectedId ? await client.listItems(rejectedId) : [];
				output = toOutputItems(contacts, rejected, websites, {
					includeDetails: options.includeDetails ?? false,
					toolMode,
				});
			}

			if (!succeeded) {
				throw new NodeOperationError(
					this.getNode(),
					run.statusMessage || `The Apify run ended with status ${run.status}`,
					{ description: `Results found before it stopped are in the run: ${runUrl(run.id)}` },
				);
			}

			// Only feeds the notice; the results are already paid for, so never fail over it.
			const summary = await client
				.getRecord(run.defaultKeyValueStoreId, 'OUTPUT')
				.catch(() => null);
			if (leftOut(summary)) {
				const message = `${run.statusMessage ?? 'Some websites were not processed.'} Run: ${runUrl(run.id)}`;
				if (typeof this.addExecutionHints === 'function') {
					this.addExecutionHints({ message, type: 'warning', location: 'outputPane' });
				} else if (output.length > 0) {
					output[0].json._notice = message;
				}
			}
			return [output];
		} catch (error) {
			const failure =
				error instanceof NodeApiError || error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error as Error);
			if (run && !failure.description) failure.description = `Apify run: ${runUrl(run.id)}`;
			if (this.continueOnFail()) {
				const json: IDataObject = { error: failure.message };
				if (run) json.runUrl = runUrl(run.id);
				return [[...output, { json, pairedItem: { item: 0 } }]];
			}
			throw failure;
		}
	}
}
