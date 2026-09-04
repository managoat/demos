/**
 * The name, set in a seven-row block font.
 *
 * Conductor's empty state is a wall of rectangles spelling its name, and it is
 * the single thing that makes an otherwise blank screen feel like a product
 * rather than a page that failed to load. This is that, for a different word.
 *
 * Drawn rather than typeset because no font does this: the glyphs are a 5×7
 * bitmap and the *runs* are the shapes. Each horizontal run of set pixels
 * becomes one rounded rectangle, so a letter's crossbar is a single long bar
 * instead of five squares in a row — which is exactly what gives the reference
 * its chunky, slightly mechanical look, and what a naive one-rect-per-pixel
 * version gets wrong.
 */

/** 5×7, one string per row, `#` set. Only the letters this app needs. */
const GLYPHS: Record<string, string[]> = {
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
};

const ROWS = 7;
const COLS = 5;

interface Run {
  x: number;
  y: number;
  width: number;
}

/** Merge each row's set pixels into runs. One rect per run, not per pixel. */
function runsOf(glyph: string[]): Run[] {
  const runs: Run[] = [];
  glyph.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= COLS; x++) {
      const set = row[x] === "#";
      if (set && start === -1) start = x;
      if (!set && start !== -1) {
        runs.push({ x: start, y, width: x - start });
        start = -1;
      }
    }
  });
  return runs;
}

export function Wordmark({ text = "DRYDOCK", unit = 13, gap = 2 }: { text?: string; unit?: number; gap?: number }) {
  const letters = [...text.toUpperCase()].filter((c) => GLYPHS[c]);
  // One blank column between letters, in pixel units, so the spacing scales
  // with the glyphs rather than being a separate number to keep in step.
  const advance = COLS + 1;
  const width = letters.length * advance * unit - unit;
  const height = ROWS * unit;

  return (
    <svg
      className="dd-wordmark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={text}
      focusable="false"
    >
      {letters.map((char, i) =>
        runsOf(GLYPHS[char]!).map((run, j) => (
          <rect
            key={`${i}-${j}`}
            x={i * advance * unit + run.x * unit}
            y={run.y * unit}
            width={run.width * unit - gap}
            height={unit - gap}
            rx={1.5}
          />
        )),
      )}
    </svg>
  );
}
