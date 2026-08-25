/**
 * End-to-end parallel tasks (M2 definition of done): a second backend runs in
 * another folder, both stream at once, switching mid-stream loses nothing,
 * background completion surfaces an unread badge, and stopping a task leaves
 * the primary untouched.
 *
 * Both backends share one faux provider, so the script uses content-matched
 * steps (`when`) instead of positional order.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPrerequisites, launchStudio, LAUNCH_TIMEOUT_MS, REPLY_TIMEOUT_MS } from "./harness.mjs";

test("parallel tasks: two backends stream side by side and switching loses nothing", async (t) => {
	assertPrerequisites();

	const studio = await launchStudio({
		extraWorkspaces: 1,
		script: [
			{ when: "SLOW_TASK", reply: "slow reply done", delayMs: 10000 },
			{ when: "FAST_MAIN", reply: "fast reply done" },
			{ reply: "fallback" },
		],
	});
	t.after(() => studio.close());

	try {
		await studio.waitUntilReady();

		// Start a pool task in the second workspace; the folder picker is
		// stubbed at the Electron dialog layer.
		await studio.stubFolderPicker(studio.extraWorkspaceDirs[0]);
		await studio.page.locator(".parallel-tasks .workspace-navigation-add").click();

		// Creation auto-switches: the pool row becomes active and its backend
		// boots to ready.
		const activeRow = studio.page.locator(".parallel-task-row.active");
		await activeRow.locator(".parallel-task-label").filter({ hasText: "workspace-extra-1" }).first()
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.page
			.locator(".parallel-task-row.active .parallel-task-dot.ready")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.waitForWorkspaceSettled();

		// Kick off the slow run in the pool task; its dot flips to streaming.
		await studio.sendPrompt("please run SLOW_TASK");
		await studio.page
			.locator(".parallel-task-row.active .parallel-task-dot.streaming")
			.waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });

		// Switch to the primary mid-stream; the pool task keeps streaming in
		// the background.
		await studio.page.locator(".parallel-task-main").first().click();
		const poolRow = studio.page.locator(".parallel-task-row").nth(1);
		await poolRow.locator(".parallel-task-dot.streaming").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.waitForWorkspaceSettled();

		// The primary answers its own prompt while the pool task still runs.
		await studio.sendPrompt("please run FAST_MAIN");
		await studio.page.getByText("fast reply done").first().waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });

		// Background completion: the pool row gains an unread badge.
		await poolRow.locator(".parallel-task-unread").waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });

		// Switching back rehydrates the pool conversation from its backend -
		// the full slow reply is there, the badge clears, and completed work
		// opens directly in the delivery review surface.
		await poolRow.locator(".parallel-task-main").click();
		await studio.page.locator(".workbench-review").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.match(await studio.page.locator(".workbench-delivery").textContent(), /Ready for review|可以审阅/u);
		await studio.page.getByText("slow reply done").first().waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });
		assert.equal(await studio.page.locator(".parallel-task-unread").count(), 0);

		// Stop the pool task (it is active, so the UI falls back to the
		// primary first); the list collapses back to nothing because only the
		// primary is left, and the primary still answers.
		await poolRow.locator(".parallel-task-stop").click();
		await studio.page
			.locator(".parallel-task-row")
			.nth(1)
			.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal(await studio.page.locator(".parallel-task-row").count(), 0);
		await studio.page.getByText("fast reply done").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
	} catch (error) {
		try {
			console.error("--- parallel-tasks section HTML ---");
			console.error(await studio.page.locator(".parallel-tasks").evaluate((node) => node.outerHTML));
		} catch {
			// section not rendered
		}
		await studio.dumpDiagnostics();
		throw error;
	}
});

test("parallel tasks: app restart restores the task and its session", async (t) => {
	assertPrerequisites();
	const rootDir = mkdtempSync(join(tmpdir(), "pi-studio-task-recovery-e2e-"));
	let studio;
	t.after(async () => {
		await studio?.close();
		rmSync(rootDir, { recursive: true, force: true, maxRetries: 5 });
	});

	try {
		studio = await launchStudio({
			extraWorkspaces: 1,
			rootDir,
			script: [{ when: "PERSIST_INBOX", reply: "persisted inbox reply", delayMs: 1500 }],
		});
		await studio.waitUntilReady();
		const cwd = studio.extraWorkspaceDirs[0];
		await studio.stubFolderPicker(cwd);
		await studio.page.locator(".parallel-tasks .workspace-navigation-add").click();
		await studio.page
			.locator(".parallel-task-row.active .parallel-task-dot.ready")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		const firstList = await studio.page.evaluate(() => window.piDesktop?.listTasks?.());
		const created = firstList?.tasks?.find((task) => task.cwd === cwd);
		assert.ok(created?.taskId);
		const initialState = await studio.page.evaluate(
			async (taskId) => window.piDesktop?.request({ type: "get_state" }, taskId),
			created.taskId,
		);
		assert.ok(initialState?.sessionFile);

		await studio.sendPrompt("PERSIST_INBOX");
		await studio.page
			.locator(".parallel-task-row.active .parallel-task-dot.streaming")
			.waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });
		await studio.page.locator(".parallel-task-main").first().click();
		const backgroundRow = studio.page.locator(".parallel-task-row").filter({ hasText: "workspace-extra-1" });
		await backgroundRow.locator(".parallel-task-unread").waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });
		await backgroundRow.locator(".parallel-task-dot.streaming").waitFor({ state: "detached", timeout: REPLY_TIMEOUT_MS });

		await studio.close();
		studio = undefined;
		studio = await launchStudio({ extraWorkspaces: 1, rootDir });
		await studio.waitUntilReady();
		const restoredRow = studio.page.locator(".parallel-task-row").filter({ hasText: "workspace-extra-1" });
		await restoredRow.locator(".parallel-task-dot.ready")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await restoredRow.locator(".parallel-task-unread").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		const restored = await studio.page.evaluate(() => window.piDesktop?.listTasks?.());
		const restoredTask = restored?.tasks?.find((task) => task.taskId === created.taskId);
		assert.equal(restoredTask?.cwd, cwd);
		assert.equal(restoredTask?.unread, 1);
		assert.equal(restoredTask?.completed, true);
		const restoredState = await studio.page.evaluate(
			async (taskId) => window.piDesktop?.request({ type: "get_state" }, taskId),
			created.taskId,
		);
		assert.equal(restoredState?.sessionFile, initialState.sessionFile);

		await studio.app.evaluate(({ BrowserWindow }, taskId) => {
			BrowserWindow.getAllWindows()[0]?.webContents.send("task:focus", { taskId, view: "review" });
		}, created.taskId);
		await studio.page
			.locator(".parallel-task-row.active")
			.filter({ hasText: "workspace-extra-1" })
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.page.locator(".workbench-review").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.page.getByText("persisted inbox reply").first().waitFor({ state: "visible", timeout: REPLY_TIMEOUT_MS });
		assert.equal(await restoredRow.locator(".parallel-task-unread").count(), 0);
	} catch (error) {
		await studio?.dumpDiagnostics();
		throw error;
	}
});

test("parallel tasks: unavailable saved tasks can be retried or forgotten", async (t) => {
	assertPrerequisites();
	const rootDir = mkdtempSync(join(tmpdir(), "pi-studio-task-warning-e2e-"));
	const statePath = join(rootDir, "user-data", "tasks.json");
	const recoverableCwd = join(rootDir, "recoverable-workspace");
	const forgottenCwd = join(rootDir, "forgotten-workspace");
	mkdirSync(join(rootDir, "user-data"), { recursive: true });
	const original = `${JSON.stringify({
		version: 1,
		tasks: [
			{ taskId: "task_4", cwd: recoverableCwd },
			{ taskId: "task_5", cwd: forgottenCwd },
		],
	}, null, 2)}\n`;
	writeFileSync(statePath, original);
	const studio = await launchStudio({ rootDir });
	t.after(async () => {
		await studio.close();
		rmSync(rootDir, { recursive: true, force: true, maxRetries: 5 });
	});

	try {
		await studio.waitUntilReady();
		const recoverable = studio.page.locator('[data-unavailable-task-id="task_4"]');
		const forgotten = studio.page.locator('[data-unavailable-task-id="task_5"]');
		await recoverable.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await forgotten.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.match(await recoverable.textContent(), /recoverable-workspace.*Workspace not found/su);
		assert.equal(readFileSync(statePath, "utf8"), original);

		const freshCwd = join(rootDir, "fresh-workspace");
		mkdirSync(freshCwd);
		const fresh = await studio.page.evaluate((cwd) => window.piDesktop?.createTask(cwd), freshCwd);
		assert.equal(fresh?.taskId, "task_6");
		await studio.page.evaluate((taskId) => window.piDesktop?.stopTask(taskId), fresh.taskId);
		assert.equal(readFileSync(statePath, "utf8"), original);

		await recoverable.locator(".parallel-task-retry").click();
		await studio.page
			.locator(".toast-error")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal(readFileSync(statePath, "utf8"), original);

		mkdirSync(recoverableCwd);
		await recoverable.locator(".parallel-task-retry").click();
		await recoverable.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
		await studio.page
			.locator(".parallel-task-row")
			.filter({ hasText: "recoverable-workspace" })
			.locator(".parallel-task-dot.ready")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

		await studio.page.evaluate(() => {
			window.confirm = () => false;
		});
		await forgotten.locator(".parallel-task-forget").click();
		assert.equal(await forgotten.count(), 1, "cancel keeps the saved task");
		await studio.page.evaluate(() => {
			window.confirm = () => true;
		});
		await forgotten.locator(".parallel-task-forget").click();
		await forgotten.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });

		const stored = JSON.parse(readFileSync(statePath, "utf8"));
		assert.deepEqual(stored.tasks.map((task) => task.taskId), ["task_4"]);
		assert.equal(stored.tasks[0].cwd, recoverableCwd);
	} catch (error) {
		await studio.dumpDiagnostics();
		throw error;
	}
});
