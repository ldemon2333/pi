import fs from "node:fs";
import path from "node:path";

/** A delegate may only be asked to read archived tool outputs or large log files. */
export const DEFAULT_MIN_BYTES = 64 * 1024;
export const DEFAULT_MIN_LINES = 2000;

export interface DelegateScope {
	/** Directory that relative paths in the call resolve against (the workspace). */
	cwd: string;
	/** Where oversized tool outputs are archived as `obs_*.log`. */
	archiveDir: string;
	minBytes: number;
	minLines: number;
}

export interface ScopeTarget {
	path: string;
	kind: "archived_output" | "large_file";
	bytes: number;
}

export type ScopeVerdict = { ok: true; targets: ScopeTarget[] } | { ok: false; reason: string };

const PATH_PATTERN = /(?:^|[\s"'`(=[])((?:\/|\.{1,2}\/)[^\s"'`()[\],;]+)/g;
const ARCHIVE_NAME = /^obs_.*\.log$/;

/** Absolute or ./relative paths named in free text, without `:line[-line]` suffixes or trailing punctuation. */
export function extractPaths(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(PATH_PATTERN)) {
		const cleaned = match[1].replace(/:\d+(?:-\d+)?$/, "").replace(/[.:]+$/, "");
		if (cleaned.length > 1) found.add(cleaned);
	}
	return [...found];
}

/** Counts newlines, stopping as soon as `stopAt` is reached. */
function countLines(file: string, stopAt: number): number {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		let lines = 0;
		let read = fs.readSync(fd, buffer, 0, buffer.length, null);
		while (read > 0 && lines < stopAt) {
			for (let i = 0; i < read; i++) if (buffer[i] === 10) lines++;
			read = fs.readSync(fd, buffer, 0, buffer.length, null);
		}
		return lines;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Accepts a delegate call only when its context or prompt names at least one archived
 * tool output (`<archiveDir>/obs_*.log`) or an existing file of at least `minBytes`
 * bytes or `minLines` lines. Everything else should be read by the caller directly.
 */
export function checkDelegateScope(args: { context?: unknown; prompt?: unknown }, scope: DelegateScope): ScopeVerdict {
	const text = [args.context, args.prompt].filter((part): part is string => typeof part === "string").join("\n");
	const archiveRoot = path.resolve(scope.archiveDir);
	const targets: ScopeTarget[] = [];
	const checked: string[] = [];

	for (const candidate of extractPaths(text)) {
		const resolved = path.resolve(scope.cwd, candidate);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			checked.push(`${candidate} (not found)`);
			continue;
		}
		if (!stat.isFile()) {
			checked.push(`${candidate} (not a regular file)`);
			continue;
		}
		if (path.dirname(resolved) === archiveRoot && ARCHIVE_NAME.test(path.basename(resolved))) {
			targets.push({ path: resolved, kind: "archived_output", bytes: stat.size });
			continue;
		}
		if (stat.size >= scope.minBytes) {
			targets.push({ path: resolved, kind: "large_file", bytes: stat.size });
			continue;
		}
		const lines = countLines(resolved, scope.minLines);
		if (lines >= scope.minLines) {
			targets.push({ path: resolved, kind: "large_file", bytes: stat.size });
		} else {
			checked.push(`${candidate} (${stat.size} bytes, ${lines} lines)`);
		}
	}

	if (targets.length > 0) return { ok: true, targets };
	const seen = checked.length > 0 ? `Checked: ${checked.join("; ")}.` : "No file path was named in context or prompt.";
	return {
		ok: false,
		reason:
			`delegate is reserved for archived long tool outputs (${archiveRoot}/obs_*.log) and large log files ` +
			`(>= ${scope.minBytes} bytes or >= ${scope.minLines} lines). ${seen} ` +
			"Read smaller files directly with read, rg or sed.",
	};
}
