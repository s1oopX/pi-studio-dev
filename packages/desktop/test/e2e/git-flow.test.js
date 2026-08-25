/**
 * End-to-end git flow: open the top-bar git panel against a real repository,
 * create a branch, and push to a local bare remote. Exercises the git:changes,
 * git:branches, git:switch-branch, and git:push IPC wiring.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertPrerequisites, launchStudio, LAUNCH_TIMEOUT_MS } from "./harness.mjs";

function git(cwd, args) {
	execFileSync("git", args, {
		cwd,
		stdio: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "E2E",
			GIT_AUTHOR_EMAIL: "e2e@example.com",
			GIT_COMMITTER_NAME: "E2E",
			GIT_COMMITTER_EMAIL: "e2e@example.com",
			GIT_CONFIG_GLOBAL: "",
			GIT_CONFIG_SYSTEM: "",
		},
	});
}

test("git flow: create a branch and push to a bare remote", async (t) => {
	assertPrerequisites();

	let remoteDir;
	const studio = await launchStudio({
		reply: "ok",
		setupWorkspace: (workspaceDir, tempRoot) => {
			remoteDir = join(tempRoot, "remote.git");
			git(tempRoot, ["init", "--bare", "-b", "main", remoteDir]);
			git(workspaceDir, ["init", "-b", "main"]);
			// The app commits through its own git child process, which does not
			// inherit the GIT_AUTHOR_*/GIT_COMMITTER_* env above, so record the
			// identity in the repository config as well.
			git(workspaceDir, ["config", "user.email", "e2e@example.com"]);
			git(workspaceDir, ["config", "user.name", "E2E"]);
			git(workspaceDir, ["remote", "add", "origin", remoteDir]);
			writeFileSync(join(workspaceDir, "README.md"), "# e2e\n");
			git(workspaceDir, ["add", "README.md"]);
			git(workspaceDir, ["commit", "-m", "initial"]);
			// Leave an untracked file so the changes list is non-empty.
			writeFileSync(join(workspaceDir, "notes.txt"), "scratch\n");
		},
	});
	t.after(() => studio.close());

	try {
		await studio.waitUntilReady();

		// Review defaults to the existing changes UI while preserving the
		// session-branch navigator as a second, keyboard-accessible tab.
		await studio.page.locator(".top-bar-workbench-toggle").click();
		await studio.page.locator('[data-workbench-view="review"]').click();
		const review = studio.page.locator(".workbench-review");
		await review.getByText("notes.txt").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		const changesTab = review.locator("#workbench-review-tab-changes");
		const branchesTab = review.locator("#workbench-review-tab-branches");
		assert.equal(await changesTab.getAttribute("role"), "tab");
		assert.equal(await changesTab.getAttribute("aria-selected"), "true");
		await changesTab.focus();
		await changesTab.press("ArrowRight");
		await review.locator(".branch-navigator-description").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal(await branchesTab.getAttribute("aria-selected"), "true");
		await studio.page.locator(".workbench-header > .icon-button:last-child").click();

		// Open the git panel from the top-bar branch button.
		await studio.page.locator(".top-bar-git").click();
		const panel = studio.page.locator(".git-panel");
		await panel.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

		// The untracked file appears in the changes list.
		await studio.page.getByText("notes.txt").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

		// Create a new branch.
		await studio.page.locator(".git-panel-branch-toggle").click();
		await studio.page.locator(".git-panel-new-branch-input").fill("feature/e2e");
		await studio.page.locator(".git-panel-new-branch-btn").click();

		// The branch label updates to the new branch.
		await studio.page
			.locator(".git-panel-branch-name")
			.filter({ hasText: "feature/e2e" })
			.first()
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal(
			execFileSync("git", ["branch", "--show-current"], { cwd: studio.workspaceDir }).toString().trim(),
			"feature/e2e",
		);

		// Push the new branch; it has no upstream, so this sets one on the bare
		// remote. Assert the durable effect (the remote ref) rather than the
		// transient success toast.
		await studio.page.locator(".git-panel-push-btn").click();
		let remoteRef = "";
		for (let attempt = 0; attempt < 40 && !remoteRef; attempt++) {
			try {
				remoteRef = execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "feature/e2e"], {
					stdio: ["ignore", "pipe", "ignore"],
				})
					.toString()
					.trim();
			} catch {
				await studio.page.waitForTimeout(500);
			}
		}
		assert.match(remoteRef, /^[0-9a-f]{40}$/u, "the bare remote should have received feature/e2e");

		// PR context: a filesystem remote is not GitHub, so the PR section only
		// shows an explanatory note (no head/base form).
		await studio.page.locator(".git-panel-pr-toggle").click();
		const prSection = studio.page.locator(".git-panel-pr");
		await prSection.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await prSection.locator(".git-panel-note").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal(await prSection.locator(".git-panel-pr-route").count(), 0);

		// With a GitHub-shaped origin the context resolves head -> base; the
		// upstream tracking from the earlier push persists across the URL change.
		git(studio.workspaceDir, ["remote", "set-url", "origin", "https://github.com/e2e-org/e2e-repo.git"]);
		await studio.page.locator(".git-panel-pr-toggle").click(); // close
		await studio.page.locator(".git-panel-pr-toggle").click(); // reopen -> refetch
		const prHead = studio.page.locator(".git-panel-pr-head");
		await prHead.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal((await prHead.textContent())?.trim(), "feature/e2e");
		assert.equal(await studio.page.locator(".git-panel-pr-base-input").inputValue(), "main");

		// Per-file review: expanding a changed file shows its diff, and the
		// armed two-click discard recycles an untracked file off the disk.
		await studio.page.locator(".git-panel-file-path", { hasText: "notes.txt" }).first().click();
		const fileDiff = studio.page.locator(".git-panel-file-diff");
		await fileDiff.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await fileDiff.getByText("scratch").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		// Line-anchored review: selecting the added line opens a comment form;
		// submitting drafts the exact file, side, line, comment, and diff text.
		const lineAnchor = fileDiff.locator('.diff-line-anchor[data-diff-side="new"][data-diff-line="1"]');
		await lineAnchor.focus();
		await lineAnchor.press("Enter");
		await studio.page.locator(".git-panel-line-comment textarea").fill("Keep this note durable.");
		await studio.page.locator('.git-panel-line-comment-actions button[type="submit"]').click();
		await studio.page
			.locator(".composer-input")
			.evaluate((el) => /** @type {HTMLTextAreaElement} */ (el).value)
			.then((value) => {
				for (const expected of ["@notes.txt", "1", "Keep this note durable.", "scratch"]) {
					assert.ok(value.includes(expected), `line comment draft should include ${expected}, got: ${value}`);
				}
			});
		await studio.page.locator(".top-bar-git").click();
		await studio.page.locator(".git-panel-file-path", { hasText: "notes.txt" }).first().click();
		await studio.page.locator(".git-panel-file-diff").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		// "Ask agent" drafts an @file prompt into the composer and closes the
		// panel; reopen and re-expand for the discard flow below.
		await studio.page.locator(".git-panel-ask-btn").click();
		await studio.page
			.locator(".composer-input")
			.evaluate((el) => /** @type {HTMLTextAreaElement} */ (el).value)
			.then((value) => assert.ok(value.includes("@notes.txt"), `composer draft should reference the file, got: ${value}`));
		await studio.page.locator(".top-bar-git").click();
		await studio.page.locator(".git-panel-file-path", { hasText: "notes.txt" }).first().click();
		await studio.page.locator(".git-panel-file-diff").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

		const discard = studio.page.locator(".git-panel-restore-btn");
		await discard.click(); // arm
		await discard.click(); // confirm
		let removed = false;
		for (let attempt = 0; attempt < 40 && !removed; attempt++) {
			removed = !existsSync(join(studio.workspaceDir, "notes.txt"));
			if (!removed) await studio.page.waitForTimeout(500);
		}
		assert.equal(removed, true, "discarding an untracked file should recycle it off the disk");

		// Commit a file, then edit the same path again. The first click after the
		// commit must load the new diff instead of toggling stale review state.
		const repeatPath = join(studio.workspaceDir, "repeat.txt");
		writeFileSync(repeatPath, "first revision\n");
		await panel.locator(".git-panel-refresh").click();
		await panel.getByText("repeat.txt").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await panel.locator(".git-panel-file").filter({ hasText: "repeat.txt" }).click();
		await panel.locator(".git-panel-file-diff").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await panel.getByText("first revision").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await panel.locator(".git-panel-hunk-action").filter({ hasText: /Stage hunk|暂存此块/u }).click();
		await panel.getByText(/Staged changes|已暂存更改/u).waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		assert.equal(
			await panel.locator(".git-panel-file").filter({ hasText: "repeat.txt" }).getAttribute("aria-expanded"),
			"true",
			"staging a hunk should keep the refreshed diff open",
		);

		await panel.locator(".git-panel-message").fill("Commit repeat file");
		await panel.locator(".git-panel-commit-btn").click();
		let committedSubject = "";
		for (let attempt = 0; attempt < 40 && committedSubject !== "Commit repeat file"; attempt++) {
			committedSubject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: studio.workspaceDir })
				.toString()
				.trim();
			if (committedSubject !== "Commit repeat file") await studio.page.waitForTimeout(250);
		}
		assert.equal(committedSubject, "Commit repeat file");
		await panel.getByText(/Working tree clean|工作树干净/u).waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

		writeFileSync(repeatPath, "second revision\n");
		await panel.locator(".git-panel-refresh").click();
		await panel.getByText("repeat.txt").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		const repeatFile = panel.locator(".git-panel-file").filter({ hasText: "repeat.txt" });
		await repeatFile.click();
		assert.equal(await repeatFile.getAttribute("aria-expanded"), "true", "the refreshed file should open its latest diff");
		await panel.locator(".git-panel-file-diff").waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await panel.getByText("second revision").first().waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

		git(studio.workspaceDir, ["remote", "set-url", "origin", remoteDir]);
		await panel.locator(".git-panel-push-btn").click();
		const localHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: studio.workspaceDir }).toString().trim();
		let pushedHead = "";
		for (let attempt = 0; attempt < 40 && pushedHead !== localHead; attempt++) {
			try {
				pushedHead = execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "feature/e2e"], {
					stdio: ["ignore", "pipe", "ignore"],
				})
					.toString()
					.trim();
			} catch {}
			if (pushedHead !== localHead) await studio.page.waitForTimeout(250);
		}
		assert.equal(pushedHead, localHead, "the post-commit push should update the remote branch");
	} catch (error) {
		await studio.dumpDiagnostics();
		throw error;
	}
});
