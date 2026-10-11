/**
 * Original Pioneer alpine scene. Vertex City's camera-plane projection and its separation of
 * scene pixels from terminal glyphs informed this renderer; no map data or engine code is copied.
 * The terrain is a world-space height field, so moving along the trail changes perspective,
 * occlusion, and parallax rather than enlarging the reference illustration.
 */
export const PIONEER_INTRO_DURATION_MS = 9000;
export type PioneerIntroStyle = "ascii" | "pixel";
type Vec3 = { x: number; y: number; z: number };

export interface PioneerIntroFrame {
	width: number;
	height: number;
	/** Packed 0xRRGGBB pixels, two vertical pixels per terminal row. */
	pixels: Uint32Array;
	depth: Float32Array;
	camera: Vec3;
}

const SKY = 0x080e20;
const FOV_SCALE = Math.tan(Math.PI / 5);
const BITCOIN = [
	"..#.#...",
	".######.",
	"..#...##",
	"..#...##",
	"..#####.",
	"..#...##",
	"..#...##",
	".######.",
	"..#.#...",
];
const HIKER = [
	"...hh...",
	"...hh...",
	"..booo..",
	".bbooo..",
	".bbooo.h",
	"..ooo.hh",
	"..ooo..h",
	"..o.o..h",
	".oo.oo.h",
];
const PEAKS = [
	[-110, 118, 73, 0.9],
	[-73, 170, 102, 0.95],
	[-30, 238, 136, 1.05],
	[32, 264, 100, 0.95],
	[102, 228, 127, 1.1],
	[136, 152, 81, 0.95],
] as const;

function rgb(r: number, g: number, b: number): number {
	return (
		(Math.max(0, Math.min(255, Math.round(r))) << 16) |
		(Math.max(0, Math.min(255, Math.round(g))) << 8) |
		Math.max(0, Math.min(255, Math.round(b)))
	);
}

function mix(a: number, b: number, amount: number): number {
	const t = Math.max(0, Math.min(1, amount));
	return rgb(
		(a >> 16) * (1 - t) + (b >> 16) * t,
		((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t,
		(a & 255) * (1 - t) + (b & 255) * t,
	);
}

function hash(n: number): number {
	const value = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return value - Math.floor(value);
}

export function pioneerTrailX(z: number): number {
	return -27 + Math.sin(z * 0.043) * 8;
}

function lakeDistance(x: number, z: number): number {
	return Math.hypot((x - 32) / 48, (z - 117) / 63);
}

export function pioneerTerrainHeight(x: number, z: number): number {
	const lake = lakeDistance(x, z);
	if (lake < 1) return 0;
	const foothills = 4 + 2.5 * Math.sin(x * 0.11 + z * 0.06) + 1.5 * Math.cos(z * 0.09);
	let height = Math.min(1, (lake - 1) * 3) * foothills;
	const ridge = Math.sin(x * 0.31 + z * 0.17) * 2.5 + Math.sin(x * 0.1 - z * 0.21) * 3;
	for (const [px, pz, peak, slope] of PEAKS) {
		const distance = Math.hypot(x - px, (z - pz) * 0.92);
		height = Math.max(height, (peak - distance * slope + ridge) * 0.6);
	}
	return Math.max(0, height) * Math.min(1, (lake - 1) * 3);
}

/** Smooth travel with a short establishing shot and a final lake overlook. */
export function pioneerIntroCamera(elapsedMs: number): Vec3 & { yaw: number; pitch: number } {
	const progress = Math.max(0, Math.min(1, (elapsedMs - 500) / 6800));
	const travel = progress * progress * (3 - 2 * progress);
	const z = -35 + travel * 100;
	const x = pioneerTrailX(z);
	const lookAhead = pioneerTrailX(z + 25);
	return {
		x,
		z,
		y: pioneerTerrainHeight(x, z) + 7 + travel * 4,
		yaw: Math.atan2(lookAhead - x, 25) * (1 - travel * 0.65) + travel * 0.12,
		pitch: -0.04 + travel * 0.015,
	};
}

export class PioneerIntroScene {
	// Cache world samples, independent of screen resolution and animation time.
	private readonly heights = new Float32Array(321 * 401);
	private readonly trees: Vec3[] = [];

	constructor() {
		for (let z = 0; z <= 400; z++) {
			for (let x = 0; x <= 320; x++) this.heights[z * 321 + x] = pioneerTerrainHeight(x - 160, z - 40);
		}
		for (let i = 0; i < 300; i++) {
			const x = hash(i * 3) * 230 - 115;
			const z = hash(i * 3 + 1) * 200 - 20;
			const y = this.heightAt(x, z);
			if (lakeDistance(x, z) > 1.07 && y < 35 && Math.abs(x - pioneerTrailX(z)) > 3) this.trees.push({ x, y, z });
		}
	}

	private heightAt(x: number, z: number): number {
		const ix = Math.round(x + 160);
		const iz = Math.round(z + 40);
		return ix < 0 || ix > 320 || iz < 0 || iz > 400 ? pioneerTerrainHeight(x, z) : this.heights[iz * 321 + ix];
	}

	render(columns: number, rows: number, elapsedMs: number): PioneerIntroFrame {
		const width = Math.max(1, Math.min(320, Math.floor(columns)));
		const height = Math.max(2, Math.min(180, Math.floor(rows) * 2));
		const pixels = new Uint32Array(width * height);
		const depth = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
		const camera = pioneerIntroCamera(elapsedMs);
		const frame: PioneerIntroFrame = { width, height, pixels, depth, camera };
		const projection = Math.min(width / (2 * FOV_SCALE), height);
		const horizon = height * 0.67 + camera.pitch * projection;
		const sin = Math.sin(camera.yaw),
			cos = Math.cos(camera.yaw);
		const seconds = elapsedMs / 1000;
		const project = (point: Vec3) => {
			const dx = point.x - camera.x,
				dz = point.z - camera.z;
			const d = dx * sin + dz * cos;
			if (d < 0.8) return undefined;
			return {
				x: width / 2 + ((dx * cos - dz * sin) * projection) / d,
				y: horizon - ((point.y - camera.y) * projection) / d,
				d,
				scale: projection / d,
			};
		};
		const plot = (x: number, y: number, color: number, distance = Number.POSITIVE_INFINITY) => {
			const px = Math.round(x),
				py = Math.round(y);
			if (px < 0 || px >= width || py < 0 || py >= height) return;
			const index = py * width + px;
			if (distance > depth[index]) return;
			pixels[index] = color;
			depth[index] = distance;
		};
		for (let y = 0; y < height; y++) pixels.fill(mix(SKY, 0x223349, (y / height) * 0.7), y * width, (y + 1) * width);
		// Celestial objects are projected at effectively infinite distance, with no altitude parallax.
		for (let i = 0; i < 130; i++) {
			const angle = (hash(i + 400) - 0.5) * 2.3 - camera.yaw;
			const x = width / 2 + Math.tan(angle) * projection;
			const y = horizon - (0.18 + hash(i + 600) * 0.9) * projection;
			const brightness = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(seconds * 1.8 + i * 2.4));
			plot(x, y, mix(0x4e668b, 0xffffff, brightness));
			if (i % 19 === 0 && brightness > 0.9) {
				plot(x - 1, y, 0x506488);
				plot(x + 1, y, 0x506488);
				plot(x, y - 1, 0x506488);
				plot(x, y + 1, 0x506488);
			}
		}
		const moonX = width / 2 + Math.tan(0.43 - camera.yaw) * projection;
		const moonY = horizon - projection * 0.46;
		const moonRadius = Math.max(1.3, projection * 0.04);
		for (let y = -Math.ceil(moonRadius); y <= moonRadius; y++) {
			for (let x = -Math.ceil(moonRadius); x <= moonRadius; x++) {
				if (x * x + y * y <= moonRadius * moonRadius)
					plot(moonX + x, moonY + y, mix(0xfcc76c, 0xffedbd, hash(x + y * 7)));
			}
		}

		// Front-to-back height-field projection; every column keeps its occlusion frontier.
		for (let column = 0; column < width; column++) {
			const side = (column + 0.5 - width / 2) / projection;
			const rayX = sin + cos * side,
				rayZ = cos - sin * side;
			let bottom = height;
			for (let distance = 1; distance < 370 && bottom > 0; distance += 0.55 + distance * 0.018) {
				const x = camera.x + rayX * distance,
					z = camera.z + rayZ * distance;
				const terrain = this.heightAt(x, z);
				const top = Math.max(0, Math.floor(horizon + ((camera.y - terrain) * projection) / distance));
				if (top >= bottom) continue;
				let color: number;
				if (lakeDistance(x, z) < 1 && terrain < 1) {
					const ripple = Math.sin(z * 2.8 + seconds * 2.1 + Math.sin(x * 0.4)) * 0.5 + 0.5;
					const reflection = Math.max(0, Math.sin(x * 0.09 + z * 0.045)) * 0.55;
					color = mix(0x005274, 0x2edfff, ripple * 0.45 + reflection);
				} else if (z < 165 && Math.abs(x - pioneerTrailX(z)) < 1.8) {
					color = mix(0x815b35, 0xc18c4c, 0.5 + 0.3 * Math.sin(z * 1.4));
				} else {
					const slope = (this.heightAt(x - 1, z + 1) - terrain) * 0.15;
					const light = Math.max(0.15, Math.min(0.95, 0.48 + slope));
					const snow = terrain > 29 + Math.sin(x * 0.22 + z * 0.09) * 4;
					color = snow ? mix(0x637991, 0xe7edf3, light) : mix(0x182236, 0x677587, light);
				}
				color = mix(color, 0x263951, Math.min(0.55, distance / 650));
				for (let y = top; y < bottom; y++) {
					pixels[y * width + column] = color;
					depth[y * width + column] = distance;
				}
				bottom = top;
			}
		}

		for (const tree of this.trees) {
			const base = project(tree);
			if (!base || base.d > 180) continue;
			const size = Math.max(1, base.scale * (3.5 + hash(tree.x) * 2));
			const color = mix(0x071422, 0x253448, base.d / 260);
			for (let y = 0; y < size; y++) {
				const halfWidth = (y / size) * size * 0.3;
				for (let x = -halfWidth; x <= halfWidth; x++) plot(base.x + x, base.y - size + y, color, base.d);
			}
		}
		// World-anchored hiker beside the trail. The camera passes the figure as the trip begins.
		const hikerZ = -14,
			hikerX = pioneerTrailX(hikerZ) - 4;
		for (let row = 0; row < HIKER.length; row++) {
			for (let col = 0; col < HIKER[row].length; col++) {
				const cell = HIKER[row][col];
				if (cell === ".") continue;
				const p = project({
					x: hikerX + (col - 4) * 0.35,
					y: this.heightAt(hikerX, hikerZ) + (9 - row) * 0.48,
					z: hikerZ,
				});
				if (!p) continue;
				for (let y = 0; y < Math.max(1, p.scale * 0.5); y++) {
					for (let x = 0; x < Math.max(1, p.scale * 0.4); x++)
						plot(p.x + x, p.y + y, cell === "o" ? 0xd57625 : cell === "h" ? 0xe6a35b : 0x593b25, p.d);
				}
			}
		}

		// A raised, gold Bitcoin glyph, fixed above the mountain skyline with sparkling edges.
		const coin = { x: -81, y: 89, z: 245 };
		for (let layer = 2; layer >= 0; layer--) {
			for (let row = 0; row < BITCOIN.length; row++) {
				for (let col = 0; col < BITCOIN[row].length; col++) {
					if (BITCOIN[row][col] !== "#") continue;
					const p = project({
						x: coin.x + (col - 4) * 3 + layer * 0.7,
						y: coin.y + (4 - row) * 3 - layer * 0.3,
						z: coin.z + layer,
					});
					if (!p) continue;
					const glint = Math.max(0, Math.cos(col * 0.5 - row * 0.22 - seconds * 2.2)) ** 12;
					const color = layer ? 0xa95d17 : mix(0xf5a623, 0xfff5ce, glint);
					for (let y = 0; y < Math.max(1, p.scale * 3); y++) {
						for (let x = 0; x < Math.max(1, p.scale * 3); x++) plot(p.x + x, p.y + y, color, p.d);
					}
				}
			}
		}
		for (let i = 0; i < 5; i++) {
			const p = project({ x: coin.x + Math.cos(i * 2.4) * 17, y: coin.y + Math.sin(i * 2.4) * 17, z: coin.z - 2 });
			const sparkle = Math.max(0, Math.sin(seconds * 3 + i * 1.7)) ** 10;
			if (!p || sparkle < 0.1) continue;
			plot(p.x, p.y, mix(0xd18c30, 0xffffff, sparkle), p.d);
			if (sparkle > 0.65) {
				for (const [dx, dy] of [
					[-1, 0],
					[1, 0],
					[0, -1],
					[0, 1],
				])
					plot(p.x + dx, p.y + dy, 0xffdd80, p.d);
			}
		}
		return frame;
	}
}

const ASCII_RAMP = "  .,:;irsXA253hMHGS#9B&@";
const ASCII_CELLS = new Map<number, { glyph: string; color: number; ansi: string }>();
const CUBE = [0, 95, 135, 175, 215, 255];

/** A bounded RGB555 cache shares the exact glyph/palette conversion with the browser preview. */
export function pioneerAsciiCell(a: number, b: number): { glyph: string; color: number; ansi: string } {
	const color = mix(a, b, 0.5) & 0xf8f8f8;
	const cached = ASCII_CELLS.get(color);
	if (cached) return cached;
	const r = color >> 16,
		g = (color >> 8) & 255,
		blue = color & 255;
	const luminance = (r * 0.21 + g * 0.72 + blue * 0.07) / 255;
	const glyph =
		luminance < 0.11
			? " "
			: ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(luminance ** 0.65 * (ASCII_RAMP.length - 1)))];
	const indices = [r, g, blue].map((channel) =>
		channel < 48 ? 0 : channel < 115 ? 1 : Math.min(5, Math.floor((channel - 115) / 40) + 2),
	);
	let index = 16 + indices[0] * 36 + indices[1] * 6 + indices[2];
	let mapped = rgb(CUBE[indices[0]], CUBE[indices[1]], CUBE[indices[2]]);
	if (Math.max(r, g, blue) - Math.min(r, g, blue) < 24) {
		const gray = Math.max(0, Math.min(23, Math.round((luminance * 255 - 8) / 10)));
		index = 232 + gray;
		mapped = rgb(8 + gray * 10, 8 + gray * 10, 8 + gray * 10);
	}
	const cell = { glyph, color: mapped, ansi: `\x1b[38;5;${index}m` };
	ASCII_CELLS.set(color, cell);
	return cell;
}

/** ASCII uses a compact 256-color palette; half-block mode retains true color. */
export function pioneerIntroLines(frame: PioneerIntroFrame, style: PioneerIntroStyle): string[] {
	const lines: string[] = [];
	for (let y = 0; y < frame.height; y += 2) {
		let line = style === "ascii" ? "\x1b[48;2;8;14;32m" : "",
			lastTop = -1,
			lastBottom = -1;
		for (let x = 0; x < frame.width; x++) {
			const a = frame.pixels[y * frame.width + x];
			const b = frame.pixels[Math.min(frame.height - 1, y + 1) * frame.width + x];
			if (style === "ascii") {
				const cell = pioneerAsciiCell(a, b);
				if (cell.glyph !== " " && cell.color !== lastTop) {
					line += cell.ansi;
					lastTop = cell.color;
				}
				line += cell.glyph;
				continue;
			}
			const top = a & 0xf8f8f8;
			const bottom = b & 0xf8f8f8;
			if (top !== lastTop) {
				line += `\x1b[38;2;${top >> 16};${(top >> 8) & 255};${top & 255}m`;
				lastTop = top;
			}
			if (bottom !== lastBottom) {
				line += `\x1b[48;2;${bottom >> 16};${(bottom >> 8) & 255};${bottom & 255}m`;
				lastBottom = bottom;
			}
			line += "▀";
		}
		lines.push(`${line}\x1b[0m`);
	}
	return lines;
}
