import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDelegateScope, extractPaths } from "../role-agent/delegate-scope.ts";

describe("role-agent delegate scope", () => {
	let dir: string;
	let archiveDir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-scope-"));
		archiveDir = path.join(dir, "archive");
		fs.mkdirSync(archiveDir);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const scope = () => ({ cwd: dir, archiveDir, minBytes: 1024, minLines: 50 });

	it("extracts absolute and relative paths without line suffixes or punctuation", () => {
		expect(extractPaths("see /tmp/a.log:120-180, then ./build/out.txt.")).toEqual(["/tmp/a.log", "./build/out.txt"]);
		expect(extractPaths("no paths here")).toEqual([]);
	});

	it("accepts archived tool outputs regardless of size", () => {
		const archived = path.join(archiveDir, "obs_0001_bash.log");
		fs.writeFileSync(archived, "short\n");
		const verdict = checkDelegateScope({ context: `Inspect ${archived}`, prompt: "find the first error" }, scope());
		expect(verdict).toEqual({ ok: true, targets: [{ path: archived, kind: "archived_output", bytes: 6 }] });
	});

	it("accepts files at or above the line or byte threshold", () => {
		fs.writeFileSync(path.join(dir, "tall.log"), "line\n".repeat(50));
		fs.writeFileSync(path.join(dir, "wide.log"), "x".repeat(1024));
		expect(checkDelegateScope({ context: "./tall.log", prompt: "q" }, scope()).ok).toBe(true);
		expect(checkDelegateScope({ context: "", prompt: "read ./wide.log" }, scope()).ok).toBe(true);
	});

	it("rejects small files, directories, missing paths and calls without paths", () => {
		fs.writeFileSync(path.join(dir, "small.ts"), "export {};\n");
		const cases = [
			{ context: "./small.ts", prompt: "explain this module" },
			{ context: `${dir}`, prompt: "look around" },
			{ context: "./missing.log", prompt: "q" },
			{ context: "", prompt: "summarize the repository" },
		];
		for (const args of cases) {
			const verdict = checkDelegateScope(args, scope());
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.reason).toContain("delegate is reserved for archived long tool outputs");
		}
	});

	it("does not treat an obs_*.log outside the archive directory as archived", () => {
		fs.writeFileSync(path.join(dir, "obs_0001_bash.log"), "short\n");
		expect(checkDelegateScope({ context: "./obs_0001_bash.log", prompt: "q" }, scope()).ok).toBe(false);
	});
});
