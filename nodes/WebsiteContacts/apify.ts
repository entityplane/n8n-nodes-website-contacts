import type { IDataObject, IHttpRequestMethods, INode } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/** entityplane/website-contact-socials-extractor */
export const ACTOR_ID = '0upbAlRdfGcknhwjW';

const FINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'];
/** Apify holds a run request open for at most 60 seconds while it waits for the run to finish. */
const WAIT_FOR_FINISH_SECONDS = 60;
const PAGE_SIZE = 1000;
const MAX_RETRIES = 5;
const FIRST_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 16_000;

export interface ApiRequest {
	method: IHttpRequestMethods;
	/** Path on api.apify.com, such as `/v2/actor-runs/abc`. */
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
}

export interface ApiResponse {
	statusCode: number;
	body: unknown;
}

export interface ApifyClientDeps {
	/** The node that errors are reported on. */
	node: INode;
	/** Sends one request; resolves on every HTTP status and rejects only on network failure. */
	send: (request: ApiRequest) => Promise<ApiResponse>;
	sleep: (ms: number) => Promise<void>;
}

export interface ActorRun {
	id: string;
	status: string;
	statusMessage?: string | null;
	defaultDatasetId: string;
	defaultKeyValueStoreId: string;
	storageIds?: { datasets?: Record<string, string> };
}

function errorMessage(body: unknown, statusCode: number): string {
	const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
	return typeof message === 'string' && message ? message : `Apify API returned HTTP ${statusCode}`;
}

export class ApifyClient {
	constructor(private readonly deps: ApifyClientDeps) {}

	async startRun(input: IDataObject, maxTotalChargeUsd?: number): Promise<ActorRun> {
		const qs: IDataObject = {};
		if (maxTotalChargeUsd !== undefined) qs.maxTotalChargeUsd = maxTotalChargeUsd;
		// Never retried after a server error: the first attempt may have started a run.
		return this.runFrom(
			await this.call(
				{ method: 'POST', path: `/v2/acts/${ACTOR_ID}/runs`, qs, body: input },
				false,
			),
		);
	}

	async waitForFinish(runId: string): Promise<ActorRun> {
		for (;;) {
			const run = this.runFrom(
				await this.call({
					method: 'GET',
					path: `/v2/actor-runs/${runId}`,
					qs: { waitForFinish: WAIT_FOR_FINISH_SECONDS },
				}),
			);
			if (FINAL_STATUSES.includes(run.status)) return run;
		}
	}

	async abortRun(runId: string): Promise<void> {
		await this.call({ method: 'POST', path: `/v2/actor-runs/${runId}/abort` });
	}

	async listItems(datasetId: string, qs: IDataObject = {}): Promise<IDataObject[]> {
		const rows: IDataObject[] = [];
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const page = await this.call({
				method: 'GET',
				path: `/v2/datasets/${datasetId}/items`,
				qs: { ...qs, offset, limit: PAGE_SIZE },
			});
			if (!Array.isArray(page)) throw this.error('The Apify API returned an unexpected response');
			rows.push(...(page as IDataObject[]));
			if (page.length < PAGE_SIZE) return rows;
		}
	}

	async getRecord(storeId: string, key: string): Promise<IDataObject | null> {
		const { statusCode, body } = await this.request({
			method: 'GET',
			path: `/v2/key-value-stores/${storeId}/records/${key}`,
		});
		if (statusCode === 404) return null;
		if (statusCode >= 300) throw this.error(errorMessage(body, statusCode), statusCode);
		return body && typeof body === 'object' ? (body as IDataObject) : null;
	}

	private async call(request: ApiRequest, retry = true): Promise<unknown> {
		const { statusCode, body } = await this.request(request, retry);
		if (statusCode >= 300) throw this.error(errorMessage(body, statusCode), statusCode);
		return body;
	}

	/**
	 * Retries network failures, rate limits and (when `retry`) server errors, then returns the
	 * last response whatever its status.
	 */
	private async request(request: ApiRequest, retry = true): Promise<ApiResponse> {
		for (let attempt = 0; ; attempt++) {
			const lastAttempt = attempt >= MAX_RETRIES;
			let response: ApiResponse | undefined;
			try {
				response = await this.deps.send(request);
			} catch (error) {
				if (!retry || lastAttempt) {
					throw this.error(`Could not reach the Apify API: ${(error as Error).message}`);
				}
			}
			if (response) {
				const retryable = response.statusCode === 429 || (retry && response.statusCode >= 500);
				if (!retryable || lastAttempt) return response;
			}
			await this.deps.sleep(Math.min(FIRST_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS));
		}
	}

	private runFrom(body: unknown): ActorRun {
		const run = (body as { data?: ActorRun } | null)?.data;
		if (!run || typeof run.id !== 'string' || typeof run.status !== 'string') {
			throw this.error('The Apify API returned an unexpected response');
		}
		return run;
	}

	private error(message: string, statusCode?: number): NodeApiError {
		return new NodeApiError(
			this.deps.node,
			{ message },
			{ message, httpCode: statusCode === undefined ? undefined : String(statusCode) },
		);
	}
}
