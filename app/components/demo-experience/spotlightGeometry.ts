export type Box = { top: number; left: number; width: number; height: number };

// The dimmed backdrop as non-overlapping rectangles covering the viewport
// minus every spotlight hole. Splitting the screen on each hole's edges
// keeps several nearby (or overlapping) holes correct -- e.g. the schedule
// step spotlights both the Today/Prev/Next controls and the calendar while
// leaving the Add Appointment button between them dimmed.
export function backdropCells(holes: Box[], viewportWidth: number, viewportHeight: number): Box[] {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const xs = [...new Set([0, viewportWidth, ...holes.flatMap((h) => [clamp(h.left, viewportWidth), clamp(h.left + h.width, viewportWidth)])])].sort((a, b) => a - b);
  const ys = [...new Set([0, viewportHeight, ...holes.flatMap((h) => [clamp(h.top, viewportHeight), clamp(h.top + h.height, viewportHeight)])])].sort((a, b) => a - b);
  const cells: Box[] = [];
  for (let yi = 0; yi < ys.length - 1; yi++) {
    for (let xi = 0; xi < xs.length - 1; xi++) {
      const cx = (xs[xi] + xs[xi + 1]) / 2;
      const cy = (ys[yi] + ys[yi + 1]) / 2;
      const insideHole = holes.some((h) => cx > h.left && cx < h.left + h.width && cy > h.top && cy < h.top + h.height);
      if (!insideHole) cells.push({ left: xs[xi], top: ys[yi], width: xs[xi + 1] - xs[xi], height: ys[yi + 1] - ys[yi] });
    }
  }
  return cells;
}
