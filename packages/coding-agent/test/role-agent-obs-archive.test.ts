import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM module without type declarations
import { compactObservation } from "../role-agent/protocol.mjs";

const cfg = { enabled: true, bash_max_chars: 1000, head_chars: 100, tail_chars: 100 };
const big = (tag: string) => `${tag}\n${"x".repeat(5000)}\n${tag}-end`;

describe("ObservationArchive file names", () => {
	it("keeps the plain name when there is no collision", () => {
		const dir = mkdtempSync(join(tmpdir(), "obs-"));
		const r = compactObservation("bash", {}, big("lead"), cfg, dir, 2);
		expect(r.compacted).toBe(true);
		expect(r.archivePath).toBe(join(dir, "obs_0002_bash.log"));
		expect(r.text).toContain(`saved to \`${join(dir, "obs_0002_bash.log")}\``);
	});

	it("never overwrites another session's archive with the same sequence number", () => {
		const dir = mkdtempSync(join(tmpdir(), "obs-"));
		const lead = compactObservation("bash", {}, big("lead"), cfg, dir, 2);
		const reader = compactObservation("bash", {}, big("reader"), cfg, dir, 2);
		const reader2 = compactObservation("bash", {}, big("reader2"), cfg, dir, 2);
		expect(lead.archivePath).toBe(join(dir, "obs_0002_bash.log"));
		expect(reader.archivePath).toBe(join(dir, "obs_0002_bash_1.log"));
		expect(reader2.archivePath).toBe(join(dir, "obs_0002_bash_2.log"));
		expect(readFileSync(lead.archivePath, "utf8")).toBe(big("lead"));
		expect(readFileSync(reader.archivePath, "utf8")).toBe(big("reader"));
		expect(reader.text).toContain(reader.archivePath);
		expect(readdirSync(dir).sort()).toEqual(["obs_0002_bash.log", "obs_0002_bash_1.log", "obs_0002_bash_2.log"]);
	});
});
