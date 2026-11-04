// What the reader does to the view of the map: wheel and pinch zoom around the
// pointer, a drag on the background pans, a double-click or 0 fits the whole map,
// + and - zoom around the centre. The view is the SVG's viewBox, kept apart from
// the circles, so the map's refreshes and easing draw inside it and never move it.

import { closeMenu } from "./menu.js";
import { approach, arrived, centreOf, FIT, panBy, toMap, wheelFactor, zoomAt } from "./zoom.js";

const KEY_FACTOR = 1.25;
const SETTLE_MS = 90; // how quickly the picture catches up with the view the reader asked for

let svg = null;
let goal = { ...FIT }; // the view the reader asked for
let now = { ...FIT }; // the view on screen, on its way to the goal
let frame = 0;
let last = 0;

function apply() {
  svg.setAttribute("viewBox", `${now.x} ${now.y} ${now.w} ${now.h}`);
}

function step(time) {
  const share = 1 - Math.exp(-(time - last) / SETTLE_MS);
  last = time;
  now = arrived(now, goal) ? goal : approach(now, goal, share);
  apply();
  frame = now === goal ? 0 : requestAnimationFrame(step);
}

/** Move the view toward `view`, smoothly (at once while the page is hidden). */
function go(view) {
  goal = view;
  if (document.hidden) {
    cancelAnimationFrame(frame);
    frame = 0;
    now = goal;
    apply();
    return;
  }
  if (frame === 0) {
    last = performance.now();
    frame = requestAnimationFrame(step);
  }
}

/** Set the view now, without easing (a drag follows the pointer exactly). */
function jump(view) {
  cancelAnimationFrame(frame);
  frame = 0;
  goal = view;
  now = view;
  apply();
}

function isCircle(target) {
  return Boolean(target.closest?.(".node, .sub, .theme, .root"));
}

function onWheel(event) {
  if (event.target.closest?.(".menu")) return;
  event.preventDefault(); // the page never scrolls, and ctrl+wheel never zooms the page
  closeMenu();
  const at = toMap(goal, svg.getBoundingClientRect(), event.clientX, event.clientY);
  go(zoomAt(goal, wheelFactor(event), at));
}

function onKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "0") go({ ...FIT });
  else if (event.key === "+" || event.key === "=") go(zoomAt(goal, KEY_FACTOR, centreOf(goal)));
  else if (event.key === "-" || event.key === "_") go(zoomAt(goal, 1 / KEY_FACTOR, centreOf(goal)));
}

function onDrag() {
  let drag = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || isCircle(event.target)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Capture only keeps a fast drag going outside the map; the drag works without it.
    }
    svg.classList.add("panning");
  });
  svg.addEventListener("pointermove", (event) => {
    if (drag === null || event.pointerId !== drag.id) return;
    const rect = svg.getBoundingClientRect();
    jump(panBy(goal, event.clientX - drag.x, event.clientY - drag.y, rect));
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  const end = (event) => {
    if (drag === null || event.pointerId !== drag.id) return;
    drag = null;
    svg.classList.remove("panning");
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
}

/** Wires the zoom and pan onto the map's SVG and the "Fit" button. */
export function startViewport(map, fitButton) {
  svg = map;
  document.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("keydown", onKey);
  svg.addEventListener("dblclick", (event) => {
    if (!isCircle(event.target)) go({ ...FIT });
  });
  fitButton.addEventListener("click", () => go({ ...FIT }));
  onDrag();
}
