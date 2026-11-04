// The maths of zooming and panning the map. The map is one SVG; the part of it
// on screen is its viewBox `{ x, y, w, h }` in map units, so text and lines are
// redrawn crisp at any zoom. Nothing here touches the page, so tests import it.

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;
/** The whole map: the page's own viewBox, and what "Fit" goes back to. */
export const FIT = { x: 0, y: 0, w: 1680, h: 1060 };

/** `scale` held between the least and most the map may be zoomed. */
export function clampScale(scale) {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** How far in `view` is, against the whole map: 1 is fitted, 2 shows half as much. */
export function scaleOf(view, fit = FIT) {
  return fit.w / view.w;
}

/** Screen pixels per map unit when `view` is drawn in `rect` (the whole viewBox fits, centred). */
export function pixelsPerUnit(view, rect) {
  return Math.min(rect.width / view.w, rect.height / view.h);
}

/** The map point under the screen point (`cx`, `cy`) when `view` is drawn in `rect`. */
export function toMap(view, rect, cx, cy) {
  const s = pixelsPerUnit(view, rect);
  const left = (rect.width - view.w * s) / 2;
  const top = (rect.height - view.h * s) / 2;
  return { x: view.x + (cx - rect.left - left) / s, y: view.y + (cy - rect.top - top) / s };
}

/**
 * `view` zoomed by `factor` (above 1 zooms in) so the map point `at` stays where it
 * is on screen; the result keeps `view`'s shape and stays within 0.5x to 4x of `fit`.
 */
export function zoomAt(view, factor, at, fit = FIT) {
  const scale = clampScale(scaleOf(view, fit) * factor);
  const w = fit.w / scale;
  const h = fit.h / scale;
  return {
    x: at.x - ((at.x - view.x) * w) / view.w,
    y: at.y - ((at.y - view.y) * h) / view.h,
    w,
    h,
  };
}

/** `view` moved so the map follows a drag of `dx`, `dy` screen pixels. */
export function panBy(view, dx, dy, rect) {
  const s = pixelsPerUnit(view, rect);
  return { ...view, x: view.x - dx / s, y: view.y - dy / s };
}

/** The factor one wheel event zooms by; a pinch (ctrl) sends small deltas, so it counts more. */
export function wheelFactor(event) {
  const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1;
  const rate = event.ctrlKey ? 0.01 : 0.0015;
  return Math.exp(-event.deltaY * unit * rate);
}

/** The middle of `view`, where + and - zoom around. */
export function centreOf(view) {
  return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
}

/** `now` moved `share` of the way to `goal`, on every edge of the view. */
export function approach(now, goal, share) {
  const step = (a, b) => a + (b - a) * share;
  return {
    x: step(now.x, goal.x),
    y: step(now.y, goal.y),
    w: step(now.w, goal.w),
    h: step(now.h, goal.h),
  };
}

/** True when `now` is so near `goal` that the eye cannot tell them apart. */
export function arrived(now, goal) {
  const near = (a, b, unit) => Math.abs(a - b) < unit * 0.0005;
  return (
    near(now.x, goal.x, goal.w) &&
    near(now.y, goal.y, goal.h) &&
    near(now.w, goal.w, goal.w) &&
    near(now.h, goal.h, goal.h)
  );
}
