import type { IDataObject, INodeExecutionData, IPairedItemData } from 'n8n-workflow';

import { hostKey, type Websites } from './inputs';

export interface OutputOptions {
	/** Keep `rejected_input` on rejected rows. */
	includeDetails: boolean;
	/** Running as an AI agent tool: leave out empty lists to save tokens. */
	toolMode: boolean;
}

function strings(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Input items that submitted any of `entries` or any entry on `hosts`; item 0 when none did. */
function sourceItems(websites: Websites, entries: string[], hosts: string[]): number[] {
	const found = new Set<number>();
	for (const entry of entries) websites.byEntry.get(entry)?.forEach((i) => found.add(i));
	for (const host of hosts) websites.byHost.get(host)?.forEach((i) => found.add(i));
	return found.size > 0 ? [...found].sort((a, b) => a - b) : [0];
}

function withoutEmptyLists(json: IDataObject): IDataObject {
	return Object.fromEntries(
		Object.entries(json).filter(([, v]) => !(Array.isArray(v) && v.length === 0)),
	);
}

/**
 * One output item per Contacts row and per Rejected inputs row, each paired with the input
 * items it came from and ordered by the first of them.
 */
export function toOutputItems(
	contacts: IDataObject[],
	rejected: IDataObject[],
	websites: Websites,
	options: OutputOptions,
): INodeExecutionData[] {
	const out: Array<{ first: number; item: INodeExecutionData }> = [];
	const add = (json: IDataObject, items: number[]) => {
		const pairedItem: IPairedItemData | IPairedItemData[] =
			items.length === 1 ? { item: items[0] } : items.map((item) => ({ item }));
		out.push({
			first: items[0],
			item: { json: options.toolMode ? withoutEmptyLists(json) : json, pairedItem },
		});
	};

	const domains = new Set<string>();
	for (const row of contacts) {
		const domain = String(row.domain ?? '');
		if (domains.has(domain)) continue;
		domains.add(domain);
		// A row reached through a www redirect carries the start URLs of the host it came from.
		const startUrls = strings(row.start_urls);
		const hosts = [domain, ...strings(row.redirected_from), ...startUrls.map(hostKey)];
		add(row, sourceItems(websites, startUrls, hosts));
	}

	const refused = new Set<string>();
	for (const row of rejected) {
		const input = String(row.input ?? '');
		const details = row.rejected_input as IDataObject | undefined;
		const key = typeof details?.sha256 === 'string' ? details.sha256 : input;
		if (refused.has(key)) continue;
		refused.add(key);
		const json: IDataObject = {
			input,
			outcome: 'rejected',
			rejection_reason: row.rejection_reason ?? null,
		};
		if (options.includeDetails && details) json.rejected_input = details;
		add(json, sourceItems(websites, [input], [hostKey(input)]));
	}

	return out.sort((a, b) => a.first - b.first).map(({ item }) => item);
}
