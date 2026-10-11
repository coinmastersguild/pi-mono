import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PioneerIntroComponent } from "../src/modes/interactive/components/pioneer-intro.ts";
import {
	PioneerIntroScene,
	pioneerIntroCamera,
	pioneerIntroLines,
	pioneerTerrainHeight,
	pioneerTrailX,
} from "../src/modes/interactive/components/pioneer-intro-scene.ts";

describe("Pioneer trail intro", () => {
	const scene = new PioneerIntroScene();
	afterEach(() => vi.useRealTimers());
	it("follows the trail above the terrain and settles at the overlook", () => {
		let previousZ = -Infinity;
		for (let time = 0; time <= 10000; time += 100) {
			const camera = pioneerIntroCamera(time);
			expect(camera.x).toBe(pioneerTrailX(camera.z));
			expect(camera.y).toBeGreaterThan(pioneerTerrainHeight(camera.x, camera.z) + 6);
			expect(camera.z).toBeGreaterThanOrEqual(previousZ);
			previousZ = camera.z;
		}
		expect(pioneerIntroCamera(9000)).toEqual(pioneerIntroCamera(10000));
	});
	it("moves through the scene while continuing to sparkle at the final camera position", () => {
		const first = scene.render(100, 32, 0);
		const final = scene.render(100, 32, 7500);
		expect(final.camera).not.toEqual(first.camera);
		expect(final.pixels).not.toEqual(first.pixels);
		expect(scene.render(100, 32, 7500).pixels).toEqual(final.pixels);
		const twinkled = scene.render(100, 32, 8000);
		expect(twinkled.camera).toEqual(final.camera);
		expect(twinkled.pixels).not.toEqual(final.pixels);
		// Gold pixels above the terrain remain visible throughout travel, including narrow terminals.
		for (const time of [0, 3000, 6000, 9000]) {
			const frame = scene.render(80, 17, time);
			expect(Array.from(frame.pixels).some((p) => p >> 16 > 200 && ((p >> 8) & 255) > 120 && (p & 255) < 100)).toBe(
				true,
			);
		}
	});
	it.each(["ascii", "pixel"] as const)("fits %s output to resized terminals", (style) => {
		for (const [width, rows] of [
			[1, 1],
			[20, 8],
			[80, 24],
			[160, 50],
		]) {
			const lines = pioneerIntroLines(scene.render(width, rows, 4000), style);
			expect(lines).toHaveLength(rows);
			expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
			if (style === "ascii") expect(lines.every((line) => /^[\x20-\x7e]*$/.test(stripAnsi(line)))).toBe(true);
		}
	});
	it("supports remapped skip keys and stops requesting frames when closed", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		const requestRender = vi.fn(),
			close = vi.fn();
		const tui = { terminal: { rows: 24 }, requestRender };
		const component = new PioneerIntroComponent(
			tui,
			new KeybindingsManager({ "tui.select.cancel": "ctrl+q" }),
			close,
		);
		component.handleInput("\x1b");
		expect(close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(requestRender).toHaveBeenCalled();
		expect(component.render(80)).toHaveLength(24);
		const cached = component.render(80);
		expect(component.render(80)).toBe(cached);
		expect(cached.every((line) => /^[\x20-\x7e]*$/.test(stripAnsi(line)))).toBe(true);
		tui.terminal.rows = 30;
		expect(component.render(80)).toHaveLength(30);
		expect(component.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
		component.handleInput("\x11");
		expect(close).toHaveBeenCalledTimes(1);
		requestRender.mockClear();
		vi.advanceTimersByTime(10000);
		expect(requestRender).not.toHaveBeenCalled();
		component.handleInput("\r");
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("finishes automatically after nine seconds and releases its timer", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		const close = vi.fn();
		const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
		new PioneerIntroComponent(tui, new KeybindingsManager(), close);
		vi.advanceTimersByTime(9100);
		expect(close).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
