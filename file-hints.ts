export type FileOps = { read?: Set<string>; written?: Set<string>; edited?: Set<string> };
export type FileLists = { readFiles: string[]; modifiedFiles: string[] };

export const FILE_HINTS_MAX_CHARS = 6000;
const MAX_HINTS = 24;
const MAX_GROUPS = 8;
const FILE_TAGS = new Set(["read-files", "modified-files", "file-hints"]);

/** Exact legacy serialization disambiguates path lines that resemble closing tags. */
function legacyBodies(sources: readonly unknown[]): Map<string, string[][]> {
	const bodies = new Map<string, string[][]>();
	for (const source of sources) {
		if (!source || typeof source !== "object") continue;
		for (const [tag, field] of [["read-files", "readFiles"], ["modified-files", "modifiedFiles"]]) {
			const paths = (source as Record<string, unknown>)[field];
			if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === "string")) continue;
			if (!paths.some((path) => path.split(/\r?\n/).includes(`</${tag}>`))) continue;
			const variants = new Set([paths.join("\n"), [...paths].sort().join("\n")]);
			bodies.set(tag, [...(bodies.get(tag) ?? []), ...[...variants].map((body) => body.split(/\r?\n/))]);
		}
	}
	return bodies;
}

/** Removes generated tracking blocks, never fenced examples or incomplete blocks. */
export function withoutFileTracking(summary: string, sources: readonly unknown[] = []): string {
	const lines = summary.split("\n");
	const kept: string[] = [];
	const bodies = legacyBodies(sources);
	let fence: { character: string; length: number } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (fence) {
			const close = trimmed.match(/^(`+|~+)\s*$/)?.[1];
			if (close && close[0] === fence.character && close.length >= fence.length) fence = undefined;
			kept.push(lines[i]);
			continue;
		}
		const opening = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
		if (opening) {
			fence = { character: opening[0], length: opening.length };
			kept.push(lines[i]);
			continue;
		}
		const tag = /^<(read-files|modified-files|file-hints)>$/.exec(lines[i].replace(/\r$/, ""))?.[1];
		if (tag && FILE_TAGS.has(tag)) {
			let end = i + 1;
			let verifiedEnd = false;
			for (const body of bodies.get(tag) ?? []) {
				if (body.every((line, offset) => lines[i + 1 + offset]?.replace(/\r$/, "") === line)
					&& lines[i + 1 + body.length]?.replace(/\r$/, "") === `</${tag}>`) {
					end = i + 1 + body.length;
					verifiedEnd = true;
					break;
				}
			}
			while (end < lines.length && lines[end].replace(/\r$/, "") !== `</${tag}>`) {
				// Legacy paths are unescaped: markup-like names and backticks are data here.
				end++;
			}
			const ambiguousEnd = !verifiedEnd && (bodies.get(tag) ?? []).some((body) => end - i - 1 < body.length
				&& body.slice(0, end - i).every((line, offset) => lines[i + 1 + offset]?.replace(/\r$/, "") === line));
			if (!ambiguousEnd && lines[end]?.replace(/\r$/, "") === `</${tag}>`) { i = end; continue; }
			// An incomplete block is ambiguous; preserve it and the remaining text verbatim.
			return kept.concat(lines.slice(i)).join("\n").trimEnd();
		}
		kept.push(lines[i]);
	}
	return kept.join("\n").trimEnd();
}

/** Keeps exact historical spellings; a write/edit supersedes a read of the same path. */
export function collectFileLists(fileOps: FileOps | undefined, entries: readonly any[]): FileLists {
	const read = new Set<string>(fileOps?.read ?? []);
	const modified = new Set<string>([...(fileOps?.written ?? []), ...(fileOps?.edited ?? [])]);
	for (const entry of entries) {
		if (entry?.type !== "compaction" && entry?.type !== "branch_summary") continue;
		const details = entry.details;
		if (!details || typeof details !== "object") continue;
		for (const path of Array.isArray(details.readFiles) ? details.readFiles : []) if (typeof path === "string") read.add(path);
		for (const path of Array.isArray(details.modifiedFiles) ? details.modifiedFiles : []) if (typeof path === "string") modified.add(path);
	}
	return { readFiles: [...read].filter((path) => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}

/** Copies only summary messages; user/tool text is not ours to sanitize. */
export function withoutMessageFileTracking(messages: readonly any[], sources: readonly unknown[] = []): any[] {
	return messages.map((message) => (message.role === "compactionSummary" || message.role === "branchSummary") && typeof message.summary === "string"
		? { ...message, summary: withoutFileTracking(message.summary, sources) }
		: message);
}

/** Recent direct tool calls are hints, not a complete or verified filesystem change ledger. */
function recentPaths(messages: readonly any[]): string[] {
	const paths = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !["read", "write", "edit"].includes(block.name)) continue;
			const path = block.arguments?.path;
			if (typeof path !== "string") continue;
			paths.delete(path);
			paths.add(path);
		}
	}
	return [...paths].reverse();
}

function parent(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return slash < 0 ? "." : path.slice(0, slash + 1);
}

/** Bounded navigation only: semantic obligations and their exact paths stay in the prose. */
export function formatFileHints(files: FileLists, messages: readonly any[], body: string): string {
	const all = [...files.modifiedFiles, ...files.readFiles];
	if (!all.length) return "";
	const known = new Set(all);
	const modified = new Set(files.modifiedFiles);
	const candidates = [...new Set([
		...all.filter((path) => path.length > 0 && body.includes(path)),
		...recentPaths(messages).filter((path) => known.has(path)),
	])];
	const groups = new Map<string, string[]>();
	let selected = 0;
	let used = 0;
	// Reserve room for labels, counts and the retrieval hint; paths are never truncated.
	for (const path of candidates) {
		if (selected >= MAX_HINTS) break;
		const directory = parent(path);
		const name = directory === "." ? path : path.slice(directory.length);
		const line = `  ${JSON.stringify(name)} [${modified.has(path) ? "изменялся" : "читался"}]`;
		const cost = line.length + 1 + (groups.has(directory) ? 0 : JSON.stringify(directory).length + 2);
		if (used + cost > FILE_HINTS_MAX_CHARS - 1500) continue;
		if (!groups.has(directory)) groups.set(directory, []);
		groups.get(directory)!.push(line);
		used += cost;
		selected++;
	}
	const lines = [
		"<file-hints>",
		"Наводки, не список текущих изменений. Точные пути для незавершённой работы — в тексте сводки.",
		...Array.from(groups, ([directory, names]) => `${JSON.stringify(directory)}:\n${names.join("\n")}`),
	];
	const counts = new Map<string, number>();
	for (const path of all) counts.set(parent(path), (counts.get(parent(path)) ?? 0) + 1);
	let groupChars = 0;
	let shownGroups = 0;
	for (const [directory, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
		if (shownGroups >= MAX_GROUPS) break;
		const line = `История ${JSON.stringify(directory)}: ${count} путей`;
		if (groupChars + line.length > 650) continue;
		lines.push(line);
		groupChars += line.length + 1;
		shownGroups++;
	}
	lines.push(
		`Всего в учёте: ${files.readFiles.length} прочитанных, ${files.modifiedFiles.length} изменявшихся; точных наводок: ${selected}.`,
		"Полный учёт сохранён в details.readFiles/modifiedFiles этой записи. Для возврата к смыслу и решениям используй доступный поиск истории сессии (session_search/session_get); не перечитывай журнал без необходимости.",
		"</file-hints>",
	);
	return `\n\n${lines.join("\n")}`;
}
