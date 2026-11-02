import { describe, expect, test } from "bun:test";
import { clearOf, placeLabel } from "../curves";
import { CENTRE, FRAME, layout, MEMBER_R, type Placed, ROOT_R, SMALL_R } from "../layout";

function input() {
  const themes = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"];
  const members = themes.flatMap((theme, t) =>
    Array.from({ length: 4 + (t % 4) * 2 }, (_, i) => ({
      id: `${theme}-m${i}`,
      theme,
      r: i % 3 === 2 ? SMALL_R : MEMBER_R,
    })),
  );
  return { themes, members };
}

function all(result: { themes: Placed[]; members: Placed[] }): Placed[] {
  return [{ id: "root", x: CENTRE.x, y: CENTRE.y, r: ROOT_R }, ...result.themes, ...result.members];
}

describe("the layout", () => {
  const first = layout(input());

  test("every circle apart from every other and inside the frame", () => {
    const circles = all(first);
    expect(first.members.length).toBe(input().members.length);
    for (const c of circles) {
      expect(c.x - c.r).toBeGreaterThanOrEqual(0);
      expect(c.y - c.r).toBeGreaterThanOrEqual(0);
      expect(c.x + c.r).toBeLessThanOrEqual(FRAME.width);
      expect(c.y + c.r).toBeLessThanOrEqual(FRAME.height);
    }
    for (let i = 0; i < circles.length; i++) {
      for (let j = i + 1; j < circles.length; j++) {
        const a = circles[i];
        const b = circles[j];
        if (a === undefined || b === undefined) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
      }
    }
  });

  test("themes on the ellipse, the first at the top", () => {
    expect(first.themes[0]).toMatchObject({ x: CENTRE.x, y: CENTRE.y - 270 });
  });

  test("the same input lays out the same", () => {
    expect(layout(input())).toEqual(first);
  });

  test("seeded with the last positions, circles hardly move", () => {
    const previous = new Map(all(first).map((c) => [c.id, { x: c.x, y: c.y }]));
    const again = layout({ ...input(), previous });
    const moved = again.members.map((m) => {
      const was = previous.get(m.id);
      return was === undefined ? Number.POSITIVE_INFINITY : Math.hypot(m.x - was.x, m.y - was.y);
    });
    expect(Math.max(...moved)).toBeLessThan(25);
  });

  test("one new member leaves the others near where they were", () => {
    const previous = new Map(all(first).map((c) => [c.id, { x: c.x, y: c.y }]));
    const more = input();
    more.members.push({ id: "t0-new", theme: "t0", r: MEMBER_R });
    const again = layout({ ...more, previous });
    const moved = again.members
      .filter((m) => m.id !== "t0-new")
      .map((m) => {
        const was = previous.get(m.id);
        return was === undefined ? 0 : Math.hypot(m.x - was.x, m.y - was.y);
      })
      .sort((a, b) => a - b);
    // Most stay put; a few near the newcomer make room.
    expect(moved[Math.floor(moved.length / 2)]).toBeLessThan(25);
  });
});

describe("link labels", () => {
  test("a label goes where no circle and no other label is", () => {
    const circles = [
      { x: 100, y: 100, r: 40 },
      { x: 400, y: 100, r: 40 },
      { x: 250, y: 100, r: 30 },
    ];
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const one = placeLabel(
      circles[0] as never,
      circles[1] as never,
      0.18,
      "same customer",
      circles,
      placed,
    );
    expect(clearOf(one.at, one.text, circles)).toBe(true);
    const two = placeLabel(
      circles[0] as never,
      circles[1] as never,
      0.18,
      "same customer",
      circles,
      placed,
    );
    expect(clearOf(two.at, two.text, circles)).toBe(true);
    expect(Math.hypot(one.at.x - two.at.x, one.at.y - two.at.y)).toBeGreaterThan(10);
  });
});
