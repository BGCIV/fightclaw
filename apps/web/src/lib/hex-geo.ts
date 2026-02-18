import { type HexId, parseHexId as parseHexIdEngine } from "@fightclaw/engine";
export { parseHexIdEngine as parseHexId };

export type PixelPoint = { x: number; y: number };

export const STACK_OFFSET_Y = 4; // SVG units per elevation layer

export const BOARD_ROWS = 9;
export const BOARD_COLS = 21;
export const HEX_RADIUS = 20;

/**
 * Convert odd-r pointy-top hex grid coordinates to a 2D pixel position.
 *
 * Uses the odd-r offset layout where odd-numbered rows are shifted right by half a hex width.
 *
 * @param row - Grid row index
 * @param col - Grid column index
 * @param R - Hex radius (distance from center to any corner) in pixels
 * @returns The pixel coordinates `{ x, y }` of the hex center
 */
export function hexToPixel(row: number, col: number, R: number): PixelPoint {
	const W = Math.sqrt(3) * R;
	const oddShift = row % 2 === 1 ? W / 2 : 0;
	return {
		x: col * W + W / 2 + oddShift,
		y: row * R * 1.5 + R,
	};
}

/**
 * Convert a hex identifier to the center pixel coordinates for a pointy-top hex.
 *
 * @param id - Hex identifier in engine format (containing row and column)
 * @param R - Hex radius in SVG units
 * @returns The pixel coordinates of the hex center as an object with `x` and `y`
 */
export function hexIdToPixel(id: HexId, R: number): PixelPoint {
	const { row, col } = parseHexIdEngine(id);
	return hexToPixel(row, col, R);
}

/**
 * Generate an SVG polygon `points` string for a pointy-top hexagon centered at (cx, cy).
 *
 * @param cx - X coordinate of the hexagon center in SVG user units
 * @param cy - Y coordinate of the hexagon center in SVG user units
 * @param R - Radius of the hexagon (distance from center to a vertex)
 * @returns A string of vertex coordinates formatted as `"x,y x,y ..."` suitable for an SVG polygon `points` attribute
 */
export function hexPoints(cx: number, cy: number, R: number): string {
	const pts: string[] = [];
	for (let i = 0; i < 6; i++) {
		const angle = (Math.PI / 180) * (60 * i - 30);
		pts.push(
			`${(cx + R * Math.cos(angle)).toFixed(2)},${(cy + R * Math.sin(angle)).toFixed(2)}`,
		);
	}
	return pts.join(" ");
}

/**
 * Compute an SVG viewBox string that centers and fits a hexagonal board for the given hex radius and grid size.
 *
 * @param R - Hex radius in the same SVG units used for rendering
 * @param pad - Padding added to all sides of the content (default: 4)
 * @param cols - Number of columns in the board (default: BOARD_COLS)
 * @param rows - Number of rows in the board (default: BOARD_ROWS)
 * @returns The viewBox string in the form "minX minY width height" that encloses the board content with the specified padding and horizontal centering
 */
export function boardViewBox(
	R: number,
	pad = 4,
	cols = BOARD_COLS,
	rows = BOARD_ROWS,
): string {
	const W = Math.sqrt(3) * R;
	// Content extents (polygon outer edges)
	const contentLeft = 0;
	const contentRight = cols * W + W / 2; // odd-row last col right edge
	const contentMid = (contentLeft + contentRight) / 2;
	const contentH = (rows - 1) * R * 1.5 + 2 * R;
	// ViewBox: centred on content mid, padded equally on all sides
	const vbW = contentRight - contentLeft + pad * 2;
	const vbH = contentH + pad * 2;
	return `${(contentMid - vbW / 2).toFixed(2)} ${-pad} ${vbW.toFixed(2)} ${vbH.toFixed(2)}`;
}