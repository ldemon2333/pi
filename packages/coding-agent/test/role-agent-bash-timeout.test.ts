import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM module without type declarations
import { BASH_TIMEOUT_DOC, documentBashTimeout, normalizeBashTimeout } from "../role-agent/protocol.mjs";

type Schema = { properties: Record<string, Record<string, unknown>> };
type ResponsesTool = { type: string; name: string; parameters: Schema };
type ChatTool = { type: string; function: { name: string; parameters: Schema } };

describe("bash timeout unit", () => {
	it("documents seconds in responses- and chat-style tool schemas only for bash", () => {
		const responses: ResponsesTool[] = [
			{
				type: "function",
				name: "bash",
				parameters: { properties: { command: {}, timeout: { type: "number", description: "x" } } },
			},
			{ type: "function", name: "read", parameters: { properties: { path: {} } } },
		];
		const chat: ChatTool[] = [
			{ type: "function", function: { name: "bash", parameters: { properties: { timeout: { type: "number" } } } } },
		];
		expect(documentBashTimeout(responses)).toBe(1);
		expect(responses[0].parameters.properties.timeout).toEqual({ type: "number", description: BASH_TIMEOUT_DOC });
		expect(responses[1].parameters.properties).toEqual({ path: {} });
		expect(documentBashTimeout(chat)).toBe(1);
		expect(chat[0].function.parameters.properties.timeout.description).toBe(BASH_TIMEOUT_DOC);
		expect(documentBashTimeout(undefined)).toBe(0);
	});

	it("treats values above 28800 as milliseconds and leaves the rest alone", () => {
		const cases: [unknown, unknown, unknown][] = [
			[120000, 120, { from: 120000, to: 120 }],
			[600000, 600, { from: 600000, to: 600 }],
			["300000", 300, { from: 300000, to: 300 }],
			[36000000, 28800, { from: 36000000, to: 28800 }],
			[28801, 29, { from: 28801, to: 29 }],
			[28800, 28800, null],
			[120, 120, null],
			[undefined, undefined, null],
		];
		for (const [given, want, change] of cases) {
			const input: Record<string, unknown> = { command: "ls", timeout: given };
			expect(normalizeBashTimeout(input)).toEqual(change);
			expect(input.timeout).toBe(want);
		}
		expect(normalizeBashTimeout(null)).toBeNull();
	});
});
