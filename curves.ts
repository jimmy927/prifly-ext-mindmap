/**
 * The curves between circles and where their labels go. Every curve is a
 * quadratic from one centre to another, its control point the midpoint moved
 * across the line by `bend` times the line's length — the page draws it with
 * the same rule (`panel/draw.js`). A label sits at a point of its curve no
 * circle and no other label covers.
 */

import type { Point } from "./layout";

export type Circle = Point & { r: number };
export type Box = { x: number; y: number; w: number; h: number };

/** The control point of the curve from `a` to `b` bent by `bend`. */
export function control(a: Point, b: Point, bend: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
}

/** The point at `t` of the curve from `a` to `b` bent by `bend`. */
export function pointAt(a: Point, b: Point, bend: number, t: number): Point {
  const c = control(a, b, bend);
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** A stable number in [0, 1) from a text. */
export function hashUnit(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0) / 2 ** 32;
}

/** A branch's bend: ±0.12 to ±0.16, the same for the same branch every time. */
export function branchBend(id: string): number {
  const unit = hashUnit(id);
  const size = 0.12 + 0.04 * ((unit * 7) % 1);
  return unit < 0.5 ? -size : size;
}

/** 10.5 px italic Segoe UI, about this wide a character. */
const CHAR_W = 5.6;
const LABEL_H = 14;
const LABEL_PAD = 6;

export function labelBox(at: Point, text: string): Box {
  const w = text.length * CHAR_W + LABEL_PAD;
  return { x: at.x - w / 2, y: at.y - LABEL_H / 2, w, h: LABEL_H };
}

function hitsCircle(box: Box, circle: Circle): boolean {
  const nx = Math.max(box.x, Math.min(circle.x, box.x + box.w));
  const ny = Math.max(box.y, Math.min(circle.y, box.y + box.h));
  return Math.hypot(circle.x - nx, circle.y - ny) < circle.r + 2;
}

function hitsBox(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export const LABEL_TS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8];

function bendsFrom(base: number): number[] {
  const bends = [base];
  for (let k = 1; k <= 10; k++) bends.push(base * k, -base * k);
  return bends;
}

/** Shorter forms of a label, tried when the whole one finds no room: its first word, then cut. */
function shorter(text: string): string[] {
  const forms: string[] = [];
  const first = text.split(" ")[0] ?? text;
  if (first !== text) forms.push(first);
  for (const n of [8, 5]) if (first.length > n) forms.push(`${first.slice(0, n - 1)}…`);
  return forms;
}

export type Placement = { bend: number; at: Point; text: string };

/**
 * Where a link's label goes: at the first point t of LABEL_TS on its curve
 * whose box is free of every circle and every label in `placed`; failing
 * that, with the bend raised ±1x to ±10x; failing that, with the label
 * shortened. With no room at all it goes at the middle of the first curve.
 * The chosen box is added to `placed`.
 */
export function placeLabel(
  a: Point,
  b: Point,
  base: number,
  text: string,
  circles: readonly Circle[],
  placed: Box[],
): Placement {
  for (const form of [text, ...shorter(text)]) {
    for (const bend of bendsFrom(base)) {
      for (const t of LABEL_TS) {
        const at = pointAt(a, b, bend, t);
        const box = labelBox(at, form);
        if (circles.some((circle) => hitsCircle(box, circle))) continue;
        if (placed.some((other) => hitsBox(box, other))) continue;
        placed.push(box);
        return { bend, at: roundPoint(at), text: form };
      }
    }
  }
  const at = pointAt(a, b, base, 0.5);
  placed.push(labelBox(at, text));
  return { bend: base, at: roundPoint(at), text };
}

/** True when a label's box at `at` is clear of every circle (for tests). */
export function clearOf(at: Point, text: string, circles: readonly Circle[]): boolean {
  const box = labelBox(at, text);
  return !circles.some((circle) => hitsCircle(box, circle));
}

function roundPoint(at: Point): Point {
  return { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 };
}
