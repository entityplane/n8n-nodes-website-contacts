export interface Websites {
	/** Distinct entries in first-seen order, as sent to the actor. */
	entries: string[];
	/** Indexes of the input items that submitted each exact entry. */
	byEntry: Map<string, number[]>;
	/** Indexes of the input items whose entries resolve to each host. */
	byHost: Map<string, number[]>;
}

function hostnameOf(value: string): string {
	try {
		return new URL(value).hostname;
	} catch {
		return '';
	}
}

/** The host a URL or bare domain points at, as the actor reports it in `domain`. */
export function hostKey(entry: string): string {
	const s = entry.trim();
	const host = hostnameOf(s) || hostnameOf(`https://${s}`);
	return host ? host.replace(/\.$/, '') : s.toLowerCase();
}

function remember(index: Map<string, number[]>, key: string, itemIndex: number): void {
	const items = index.get(key);
	if (!items) index.set(key, [itemIndex]);
	else if (items[items.length - 1] !== itemIndex) items.push(itemIndex);
}

/** Collects the websites of every input item; `values[i]` is item i's Website field. */
export function collectWebsites(values: readonly string[]): Websites {
	const websites: Websites = { entries: [], byEntry: new Map(), byHost: new Map() };
	values.forEach((value, itemIndex) => {
		for (const line of value.split(/\r?\n/)) {
			const entry = line.trim();
			if (!entry) continue;
			if (!websites.byEntry.has(entry)) websites.entries.push(entry);
			remember(websites.byEntry, entry, itemIndex);
			remember(websites.byHost, hostKey(entry), itemIndex);
		}
	});
	return websites;
}
