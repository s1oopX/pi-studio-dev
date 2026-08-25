import assert from "node:assert/strict";
import test from "node:test";
import { assertPrerequisites, launchStudio, LAUNCH_TIMEOUT_MS } from "./harness.mjs";

test("forced colors and reduced motion preserve keyboard state", async (t) => {
	assertPrerequisites();
	const studio = await launchStudio({ extraWorkspaces: 1 });
	t.after(() => studio.close());

	try {
		await studio.waitUntilReady();

		// The task list stays hidden while only the primary task exists, so add a
		// pool task to get a rendered active row for the outline assertions.
		await studio.stubFolderPicker(studio.extraWorkspaceDirs[0]);
		await studio.page.locator(".parallel-tasks .workspace-navigation-add").click();
		await studio.page
			.locator(".parallel-task-row.active .parallel-task-dot.ready")
			.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
		await studio.waitForWorkspaceSettled();

		await studio.page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
		await studio.page.waitForFunction(
			() => matchMedia("(forced-colors: active)").matches && matchMedia("(prefers-reduced-motion: reduce)").matches,
			null,
			{ timeout: LAUNCH_TIMEOUT_MS },
		);
		const composer = studio.page.locator(".composer-input");
		await composer.focus();

		const audit = await studio.page.evaluate(() => {
			const visible = (element) => {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
			};
			const controls = [...document.querySelectorAll("button, input, textarea, select, a[href]")].filter(visible);
			const unnamed = controls.filter((element) =>
				!(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || element.getAttribute("placeholder"))?.trim()
			);
			const activeTask = document.querySelector(".parallel-task-row.active");
			const composer = document.querySelector(".composer");
			const shell = document.querySelector(".app-shell");
			if (!(activeTask instanceof HTMLElement) || !(composer instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
				return null;
			}
			const activeStyle = getComputedStyle(activeTask);
			const composerStyle = getComputedStyle(composer);
			const shellStyle = getComputedStyle(shell);
			return {
				fontFamily: getComputedStyle(document.body).fontFamily,
				unnamed: unnamed.length,
				activeOutline: activeStyle.outlineStyle,
				activeOutlineWidth: activeStyle.outlineWidth,
				focusOutline: composerStyle.outlineStyle,
				focusOutlineWidth: composerStyle.outlineWidth,
				transitionDuration: shellStyle.transitionDuration,
			};
		});

		assert.ok(audit, "accessibility audit targets were not rendered");
		// 22838d46e moved --font-sans off the Windows-only "Segoe UI Variable Text"
		// stack to a cross-platform one. Assert the shared family rather than the
		// whole list so reordering the stack does not fail this.
		assert.match(audit.fontFamily, /Segoe UI/u);
		assert.equal(audit.unnamed, 0);
		assert.equal(audit.activeOutline, "solid");
		assert.ok(parseFloat(audit.activeOutlineWidth) >= 1.5, audit.activeOutlineWidth);
		assert.equal(audit.focusOutline, "solid");
		assert.ok(parseFloat(audit.focusOutlineWidth) >= 1.5, audit.focusOutlineWidth);
		assert.ok(parseFloat(audit.transitionDuration) <= 0.001, audit.transitionDuration);

		// Expanded sidebars reach settings through the footer's "Account and
		// settings"; the plain "Settings" button only exists in the collapsed rail.
		// Match case-insensitively so either layout resolves, which stays a single
		// element because the two are mutually exclusive.
		const settingsTrigger = studio.page.getByRole("button", { name: /settings|设置/iu });
		await settingsTrigger.click();
		await studio.page.locator(".settings-panel").waitFor();
		assert.deepEqual(
			await studio.page.locator(".window-chrome, .app-shell").evaluateAll((elements) =>
				elements.map((element) => element.hasAttribute("inert"))),
			[true, true],
		);
		await studio.page.locator('.settings-nav-item[data-route="custom-providers"]').click();
		const providerName = studio.page.locator("#cp-provider-id");
		await providerName.fill("focus-test");
		await studio.page.waitForTimeout(50);
		assert.equal(
			await providerName.evaluate((element) => element === document.activeElement),
			true,
			"marking provider settings dirty must not steal input focus",
		);
		await studio.page.evaluate(() => { window.confirm = () => false; });
		await studio.page.keyboard.press("Escape");
		assert.equal(await studio.page.locator(".settings-panel").isVisible(), true);
		await providerName.fill("");
		await studio.page.waitForTimeout(50);
		await studio.page.keyboard.press("Escape");
		await studio.page.locator(".settings-panel").waitFor({ state: "hidden" });
		assert.equal(await settingsTrigger.evaluate((element) => element === document.activeElement), true);
		assert.deepEqual(
			await studio.page.locator(".window-chrome, .app-shell").evaluateAll((elements) =>
				elements.map((element) => element.hasAttribute("inert"))),
			[false, false],
		);

		await studio.app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0];
			window?.setSize(720, 520);
			window?.webContents.setZoomFactor(2);
		});
		await studio.page.waitForFunction(() => innerWidth <= 400, null, { timeout: LAUNCH_TIMEOUT_MS });
		const collapsedSidebar = studio.page.locator(".sidebar.collapsed");
		await collapsedSidebar.waitFor({ state: "attached" });
		assert.equal(await collapsedSidebar.isVisible(), false);
		const zoomedLayout = await studio.page.evaluate(() => {
			const main = document.querySelector(".main-panel")?.getBoundingClientRect();
			const composer = document.querySelector(".composer")?.getBoundingClientRect();
			const chrome = document.querySelector(".window-chrome-left");
			return {
				viewportWidth: innerWidth,
				bodyWidth: document.body.scrollWidth,
				mainWidth: main?.width ?? 0,
				composerWidth: composer?.width ?? 0,
				composerBottom: composer?.bottom ?? Number.POSITIVE_INFINITY,
				viewportHeight: innerHeight,
				chromeClientWidth: chrome?.clientWidth ?? 0,
				chromeScrollWidth: chrome?.scrollWidth ?? 0,
			};
		});
		assert.equal(zoomedLayout.bodyWidth, zoomedLayout.viewportWidth);
		assert.ok(zoomedLayout.chromeScrollWidth <= zoomedLayout.chromeClientWidth + 1, JSON.stringify(zoomedLayout));
		assert.ok(zoomedLayout.mainWidth >= zoomedLayout.viewportWidth - 1, JSON.stringify(zoomedLayout));
		assert.ok(zoomedLayout.composerWidth >= 300, JSON.stringify(zoomedLayout));
		assert.ok(zoomedLayout.composerBottom <= zoomedLayout.viewportHeight + 1, JSON.stringify(zoomedLayout));

		await studio.page.locator(".window-chrome-sidebar-toggle").click();
		const expandedSidebar = studio.page.locator(".sidebar:not(.collapsed)");
		await expandedSidebar.waitFor();
		assert.ok(await expandedSidebar.evaluate((element) => element.getBoundingClientRect().width <= 312));
		assert.ok(await studio.page.locator(".main-panel").evaluate((element) => element.getBoundingClientRect().width >= 359));
	} catch (error) {
		await studio.dumpDiagnostics();
		throw error;
	}
});
