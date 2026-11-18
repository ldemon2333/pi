import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("before_provider_request", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-request-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(...extensions: string[]) {
		for (let i = 0; i < extensions.length; i++) fs.writeFileSync(path.join(extensionsDir, `e${i}.ts`), extensions[i]);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sm = SessionManager.inMemory();
		const mr = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sm, mr);
	}

	it("returns the payload rewritten by handlers", async () => {
		const runner = await createRunner(
			`export default p => p.on("before_provider_request", (e) => ({ ...e.payload, rewritten: true }));`,
		);
		expect(await runner.emitBeforeProviderRequest({ model: "m" })).toEqual({ model: "m", rewritten: true });
	});

	it("aborts the request instead of sending the original payload when a handler throws", async () => {
		const runner = await createRunner(
			`export default p => p.on("before_provider_request", () => { throw new Error("projection failed"); });`,
			`export default p => p.on("before_provider_request", (e) => { globalThis.__laterHandlerRan = true; return e.payload; });`,
		);
		const errors: string[] = [];
		runner.onError((e) => errors.push(e.error));

		await expect(runner.emitBeforeProviderRequest({ model: "m" })).rejects.toThrow("projection failed");
		expect(errors).toEqual(["projection failed"]);
		expect((globalThis as { __laterHandlerRan?: boolean }).__laterHandlerRan).toBeUndefined();
	});
});
