// Guided Demo Session chat card placement (SessionChat.tsx): pure geometry,
// kept apart from the component so it can be unit-tested.
export const MARGIN = 12;

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Where the card can actually go: the person's chosen place if it is clear,
// otherwise the first clear corner; null when nothing is clear.
export function placeCard(wanted: Point, size: { w: number; h: number }, clear: Rect[], view: { w: number; h: number }): Point | null {
  const fits = (p: Point) => !clear.some((r) => overlaps({ x: p.x, y: p.y, ...size }, r));
  const clamp = (p: Point) => ({
    x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, view.w - size.w - MARGIN)),
    y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, view.h - size.h - MARGIN)),
  });
  const first = clamp(wanted);
  if (fits(first)) return first;
  const bottom = view.h - size.h - MARGIN;
  const right = view.w - size.w - MARGIN;
  const below = Math.max(MARGIN, ...clear.filter((r) => r.y < 120).map((r) => r.y + r.h + MARGIN));
  const candidates = [
    { x: MARGIN, y: bottom },
    { x: right, y: bottom },
    { x: MARGIN, y: below },
    { x: right, y: below },
    { x: MARGIN, y: Math.round((view.h - size.h) / 2) },
    { x: right, y: Math.round((view.h - size.h) / 2) },
  ].map(clamp);
  return candidates.find(fits) ?? null;
}
