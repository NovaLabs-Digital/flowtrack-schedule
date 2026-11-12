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

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const sumOverlap = (card: Box, boxes: Box[]) => boxes.reduce((n, b) => n + overlapArea(card, b), 0);

// Where to put the instruction card. Tries the sides of the spotlight and
// of every element it must keep clear, then the screen corners, at the full
// card width and then narrower ones (a narrower card is taller). Picks the
// first position that covers nothing it must keep clear (`avoid`: a form
// being filled in, the card being looked at) and, among those, the one
// covering the least of the spotlight; failing that, the least of `avoid`.
// Every position is kept inside the viewport.
export function placeCard(opts: {
  cardWidth: number;
  cardHeight: number;
  holes: Box[];
  avoid: Box[];
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
  minWidth?: number;
  // The card's height at a given width, when known (a narrower card is taller).
  heightFor?: (width: number) => number;
}): Box {
  const { holes, avoid, viewportWidth: vw, viewportHeight: vh } = opts;
  const margin = opts.margin ?? 16;
  const gap = opts.gap ?? 16;
  const widths = [opts.cardWidth, Math.round(opts.cardWidth * 0.82), opts.minWidth ?? 272].filter(
    (w, i, all) => w <= vw - margin * 2 && all.indexOf(w) === i
  );
  if (widths.length === 0) widths.push(Math.max(vw - margin * 2, 200));
  const union = (boxes: Box[]): Box | null => {
    if (boxes.length === 0) return null;
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    return { left, top, width: Math.max(...boxes.map((b) => b.left + b.width)) - left, height: Math.max(...boxes.map((b) => b.top + b.height)) - top };
  };
  const anchors = [union(holes), ...avoid, union(avoid)].filter((b): b is Box => !!b);
  const clampBox = (b: Box): Box => ({
    ...b,
    left: Math.min(Math.max(b.left, margin), Math.max(vw - b.width - margin, margin)),
    top: Math.min(Math.max(b.top, margin), Math.max(vh - b.height - margin, margin)),
  });

  let best: { box: Box; avoidHit: number; holeHit: number } | null = null;
  for (const width of widths) {
    const height = opts.heightFor ? opts.heightFor(width) : Math.round(opts.cardHeight * (opts.cardWidth / width));
    const candidates: Box[] = [];
    for (const a of anchors) {
      candidates.push(
        { left: a.left, top: a.top + a.height + gap, width, height },
        { left: a.left + a.width + gap, top: a.top, width, height },
        { left: a.left - width - gap, top: a.top, width, height },
        { left: a.left, top: a.top - height - gap, width, height },
      );
    }
    candidates.push(
      { left: vw - width - margin, top: margin, width, height },
      { left: vw - width - margin, top: vh - height - margin, width, height },
      { left: margin, top: vh - height - margin, width, height },
      { left: margin, top: margin, width, height },
    );
    for (const c of candidates) {
      const box = clampBox(c);
      const avoidHit = sumOverlap(box, avoid);
      const holeHit = sumOverlap(box, holes);
      if (!best || avoidHit < best.avoidHit || (avoidHit === best.avoidHit && holeHit < best.holeHit)) {
        best = { box, avoidHit, holeHit };
      }
    }
    // A full-width position that keeps everything clear wins outright.
    if (best && best.avoidHit === 0 && best.holeHit === 0) break;
  }
  return best!.box;
}
