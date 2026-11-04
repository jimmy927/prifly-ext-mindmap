import { describe, expect, test } from "bun:test";
import {
  approach,
  arrived,
  centreOf,
  clampScale,
  FIT,
  panBy,
  scaleOf,
  toMap,
  wheelFactor,
  zoomAt,
} from "../panel/zoom.js";

const rect = { left: 10, top: 20, width: 840, height: 530 }; // half of FIT, no letterbox

describe("clampScale", () => {
  test("keeps 0.5x to 4x", () => {
    expect(clampScale(0.1)).toBe(0.5);
    expect(clampScale(9)).toBe(4);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("zoomAt", () => {
  test("keeps the point under the pointer where it is", () => {
    const at = { x: 400, y: 300 };
    const out = zoomAt(FIT, 2, at);
    expect(scaleOf(out)).toBeCloseTo(2);
    // The point sits at the same share of the view before and after.
    expect((at.x - out.x) / out.w).toBeCloseTo((at.x - FIT.x) / FIT.w);
    expect((at.y - out.y) / out.h).toBeCloseTo((at.y - FIT.y) / FIT.h);
  });

  test("never goes past 4x or under 0.5x, however far it is pushed", () => {
    let view = FIT;
    for (let i = 0; i < 40; i++) view = zoomAt(view, 1.5, { x: 100, y: 100 });
    expect(scaleOf(view)).toBeCloseTo(4);
    for (let i = 0; i < 40; i++) view = zoomAt(view, 0.5, { x: 100, y: 100 });
    expect(scaleOf(view)).toBeCloseTo(0.5);
  });

  test("zooming in then out by the same factor comes back", () => {
    const at = { x: 1200, y: 700 };
    const back = zoomAt(zoomAt(FIT, 2, at), 0.5, at);
    expect(back.x).toBeCloseTo(FIT.x);
    expect(back.w).toBeCloseTo(FIT.w);
  });

  test("a point that does not move on screen keeps its screen position", () => {
    const view = { x: 100, y: 50, w: 840, h: 530 };
    const at = toMap(view, rect, 300, 200);
    const out = zoomAt(view, 1.7, at);
    const after = toMap(out, rect, 300, 200);
    expect(after.x).toBeCloseTo(at.x);
    expect(after.y).toBeCloseTo(at.y);
  });
});

describe("toMap and panBy", () => {
  test("maps the corner of the rect to the corner of the view", () => {
    expect(toMap(FIT, rect, 10, 20)).toEqual({ x: 0, y: 0 });
    const far = toMap(FIT, rect, 850, 550);
    expect(far.x).toBeCloseTo(1680);
    expect(far.y).toBeCloseTo(1060);
  });

  test("centres the map when the window is wider than the map", () => {
    const wide = { left: 0, top: 0, width: 2000, height: 530 }; // 0.5 px per unit, 1160 px spare
    expect(toMap(FIT, wide, 580, 0).x).toBeCloseTo(0);
  });

  test("a drag moves the map with the pointer", () => {
    const out = panBy(FIT, 50, -20, rect);
    expect(out.x).toBeCloseTo(-100);
    expect(out.y).toBeCloseTo(40);
    expect(out.w).toBe(FIT.w);
  });
});

describe("fit and keys", () => {
  test("FIT is scale 1 and zooming around the centre keeps the centre", () => {
    expect(scaleOf(FIT)).toBe(1);
    const out = zoomAt(FIT, 1.25, centreOf(FIT));
    expect(centreOf(out).x).toBeCloseTo(centreOf(FIT).x);
    expect(centreOf(out).y).toBeCloseTo(centreOf(FIT).y);
  });
});

describe("wheelFactor", () => {
  test("a wheel turned away zooms out, toward zooms in, a pinch counts more", () => {
    const wheel = { deltaMode: 0, ctrlKey: false };
    expect(wheelFactor({ ...wheel, deltaY: 100 })).toBeLessThan(1);
    expect(wheelFactor({ ...wheel, deltaY: -100 })).toBeGreaterThan(1);
    expect(wheelFactor({ ...wheel, deltaY: 0 })).toBe(1);
    const pinch = wheelFactor({ ...wheel, ctrlKey: true, deltaY: -5 });
    expect(pinch).toBeGreaterThan(wheelFactor({ ...wheel, deltaY: -5 }));
  });
});

describe("approach", () => {
  test("moves part of the way and arrives", () => {
    const goal = { x: 100, y: 100, w: 840, h: 530 };
    const half = approach(FIT, goal, 0.5);
    expect(half.x).toBe(50);
    expect(half.w).toBe(1260);
    expect(arrived(FIT, goal)).toBe(false);
    expect(arrived(goal, goal)).toBe(true);
  });
});
