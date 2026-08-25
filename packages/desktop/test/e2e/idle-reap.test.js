/**
 * End-to-end idle reaping (M4): a backgrounded pool task with no backend
 * traffic stops itself after the idle window, while the renderer's active
 * primary is untouched. PI_STUDIO_IDLE_REAP_MS shrinks the window and sweep
 * cadence so the reap is observable in seconds.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { assertPrerequisites, launchStudio, LAUNCH_TIMEOUT_MS } from "./harness.mjs";

test("idle reaping: a backgrounded task stops itself, the active primary stays", async (t) => {
	assertPrerequisites();

	const studio = await launchStudio({
		reply: "ok",
		extraWorkspaces: 1,
		extraEnv: { PI_STUDIO_IDLE_REAP_MS: "4000" },
	});
	t.after(() => studio.close());

	try {
		await studio.waitUntilReady();

		// Create a pool task in another folder; creation auto-switches to it.
		await studio.stubFolderPicker(studio.extraWorkspaceDirs[0]);
		await studio.page.locator(".parallel-tasks .workspace-navigation-add").click();
		await studio.page
			.locator(".parallel-task-row.active .parallel-task-dot.ready")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.waitForWorkspaceSettled();
		assert.equal(await studio.page.locator(".parallel-task-row").count(), 2);

		// While the pool task is ACTIVE it must not be reaped, no matter how
		// idle its backend is: stay on it well past the window.
		await studio.page.waitForTimeout(9000);
		assert.equal(await studio.page.locator(".parallel-task-row").count(), 2, "the viewed task must never be reaped");

		// Background it; with no backend traffic the sweep stops it.
		await studio.page.locator(".parallel-task-main").first().click();
		await studio.waitForWorkspaceSettled();
		await studio.page
			.locator(".parallel-task-row")
			.nth(1)
			.waitFor({ state: "detached", timeout: 30_000 });
		// The list collapses entirely once the primary is the only task left.
		assert.equal(await studio.page.locator(".parallel-task-row").count(), 0);

		// The primary keeps serving after the reap.
		await studio.sendPrompt("still alive?");
		await studio.page.getByText("ok").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
	} catch (error) {
		await studio.dumpDiagnostics();
		throw error;
	}
});
