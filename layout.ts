/**
 * Where every circle goes, worked out here rather than in the page: themes
 * fixed on an ellipse round the centre, members pulled out from their theme
 * by d3-force, seeded from the last positions so nothing jumps.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { ItemKind, Link } from "./types";

export const FRAME = { width: 1680, height: 1060 } as const;
export const CENTRE = { x: 840, y: 530 } as const;
export const ROOT_R = 66;
export const THEME_R = 54;
export const MEMBER_R = 52;
export const SMALL_R = 38;
const ELLIPSE = { rx: 500, ry: 270 };
const FAN = { distance: 150, step: 0.55 };
const TICKS = 900;
const GAP = 7;
const EDGE = 4;

export type Point = { x: number; y: number };

export function radiusOf(kind: ItemKind): number {
  return kind === "session" ? MEMBER_R : SMALL_R;
}

/**
 * Themes in the order they go round the ellipse: each next to the one it
 * shares the most links with, the largest first; ties keep the last order.
 */
export function orderThemes(
  themes: readonly string[],
  themeOf: Readonly<Record<string, string>>,
  links: readonly Link[],
  sizes: ReadonlyMap<string, number>,
  previous: readonly string[] = [],
): string[] {
  const weight = new Map<string, number>();
  const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const link of links) {
    const a = themeOf[link.a];
    const b = themeOf[link.b];
    if (a !== undefined && b !== undefined && a !== b)
      weight.set(pair(a, b), (weight.get(pair(a, b)) ?? 0) + 1);
  }
  const rank = (id: string) => {
    const i = previous.indexOf(id);
    return i === -1 ? previous.length + themes.indexOf(id) : i;
  };
  const left = [...themes].sort(
    (a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0) || rank(a) - rank(b),
  );
  const order: string[] = [];
  let last = left.shift();
  while (last !== undefined) {
    order.push(last);
    const from = last;
    left.sort(
      (a, b) =>
        (weight.get(pair(from, b)) ?? 0) - (weight.get(pair(from, a)) ?? 0) || rank(a) - rank(b),
    );
    last = left.shift();
  }
  return order;
}

/** Each theme's place: evenly round the ellipse, starting at the top, clockwise. */
export function themePlaces(count: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, count);
    return {
      x: CENTRE.x + ELLIPSE.rx * Math.cos(angle),
      y: CENTRE.y + ELLIPSE.ry * Math.sin(angle),
    };
  });
}

function outward(from: Point): Point {
  const dx = from.x - CENTRE.x;
  const dy = from.y - CENTRE.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

export type LayoutMember = { id: string; theme: string; r: number };
export type LayoutInput = {
  /** Theme ids, in their order round the ellipse. */
  themes: readonly string[];
  members: readonly LayoutMember[];
  /** Where circles (members and themes) were last time, by id. */
  previous?: ReadonlyMap<string, Point>;
  /** Each member's theme last time: a member that changed theme, or whose theme moved, starts afresh. */
  previousTheme?: ReadonlyMap<string, string>;
};
export type Placed = Point & { id: string; r: number };
export type LayoutResult = { themes: Placed[]; members: Placed[] };

type Node = SimulationNodeDatum & { id: string; r: number; home: Point; fixed: boolean };

/** A small deterministic random source, so the same input lays out the same. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function clamp(node: Node): void {
  if (node.fixed) return;
  node.x = Math.min(FRAME.width - node.r - EDGE, Math.max(node.r + EDGE, node.x ?? CENTRE.x));
  node.y = Math.min(FRAME.height - node.r - EDGE, Math.max(node.r + EDGE, node.y ?? CENTRE.y));
}

/**
 * The last places worth starting from: a member's, when it is under the same
 * theme as last time and that theme is where it was. Anything else would hold
 * a circle far from its theme.
 */
export function seedsOf(input: LayoutInput): Map<string, Point> {
  const places = themePlaces(input.themes.length);
  const stayed = new Set(
    input.themes.filter((id, i) => {
      const was = input.previous?.get(id);
      const now = places[i];
      return was !== undefined && now !== undefined && Math.hypot(was.x - now.x, was.y - now.y) < 1;
    }),
  );
  const seeds = new Map<string, Point>();
  for (const member of input.members) {
    const last = input.previous?.get(member.id);
    const sameTheme = input.previousTheme?.get(member.id) === member.theme;
    if (last !== undefined && sameTheme && stayed.has(member.theme)) seeds.set(member.id, last);
  }
  return seeds;
}

function startNodes(
  input: LayoutInput,
  seeds: ReadonlyMap<string, Point>,
): { fixed: Node[]; members: Node[] } {
  const places = themePlaces(input.themes.length);
  const themeNodes = new Map<string, Node>();
  const fixed: Node[] = [
    {
      id: "root",
      r: ROOT_R,
      home: CENTRE,
      fixed: true,
      x: CENTRE.x,
      y: CENTRE.y,
      fx: CENTRE.x,
      fy: CENTRE.y,
    },
  ];
  input.themes.forEach((id, i) => {
    const at = places[i] ?? CENTRE;
    const node: Node = {
      id,
      r: THEME_R,
      home: at,
      fixed: true,
      x: at.x,
      y: at.y,
      fx: at.x,
      fy: at.y,
    };
    themeNodes.set(id, node);
    fixed.push(node);
  });
  const members: Node[] = [];
  for (const theme of input.themes) {
    const own = input.members.filter((member) => member.theme === theme);
    const at = themeNodes.get(theme)?.home ?? CENTRE;
    const out = outward(at);
    const base = Math.atan2(out.y, out.x);
    own.forEach((member, j) => {
      const angle = base + (j - (own.length - 1) / 2) * FAN.step;
      const last = seeds.get(member.id);
      const home = { x: at.x + out.x * 120, y: at.y + out.y * 120 };
      members.push({
        id: member.id,
        r: member.r,
        home,
        fixed: false,
        x: last?.x ?? at.x + FAN.distance * Math.cos(angle),
        y: last?.y ?? at.y + FAN.distance * Math.sin(angle),
      });
    });
  }
  return { fixed, members };
}

/** Push apart any two circles still overlapping after the simulation, and keep them in the frame. */
function separate(nodes: Node[]): void {
  for (let round = 0; round < 300; round++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        moved = pushApart(nodes[i], nodes[j]) || moved;
      }
    }
    for (const node of nodes) clamp(node);
    if (!moved) return;
  }
}

function nudge(node: Node, dx: number, dy: number): void {
  if (node.fixed) return;
  node.x = (node.x ?? 0) + dx;
  node.y = (node.y ?? 0) + dy;
}

function pushApart(a: Node | undefined, b: Node | undefined): boolean {
  if (a === undefined || b === undefined || (a.fixed && b.fixed)) return false;
  const dx = (b.x ?? 0) - (a.x ?? 0);
  const dy = (b.y ?? 0) - (a.y ?? 0);
  const distance = Math.hypot(dx, dy) || 0.01;
  const need = a.r + b.r + 2;
  if (distance >= need) return false;
  const push = ((need - distance) / distance) * (a.fixed || b.fixed ? 1 : 0.5);
  nudge(a, -dx * push, -dy * push);
  nudge(b, dx * push, dy * push);
  return true;
}

/** Every circle's place. Deterministic for the same input. */
export function layout(input: LayoutInput): LayoutResult {
  const seeds = seedsOf(input);
  const { fixed, members } = startNodes(input, seeds);
  const nodes = [...fixed, ...members];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: SimulationLinkDatum<Node>[] = input.members.flatMap((member) => {
    const source = byId.get(member.id);
    const target = byId.get(member.theme);
    return source !== undefined && target !== undefined ? [{ source, target }] : [];
  });
  // Seeded from the last places, the simulation starts cool so circles settle where they were;
  // with newcomers among them, warmer, so the others make room.
  const seededCount = members.filter((m) => seeds.has(m.id)).length;
  const heat = seededCount === 0 ? 1 : seededCount === members.length ? 0.05 : 0.3;
  const simulation = forceSimulation<Node>(nodes)
    .randomSource(seeded(nodes.length * 7919 + 17))
    .alpha(heat)
    .force("link", forceLink<Node, SimulationLinkDatum<Node>>(links).distance(132).strength(0.9))
    .force(
      "collide",
      forceCollide<Node>((node) => node.r + GAP),
    )
    .force("charge", forceManyBody<Node>().strength(-40))
    .force(
      "x",
      forceX<Node>((node) => node.home.x).strength((node) => (node.fixed ? 0 : 0.06)),
    )
    .force(
      "y",
      forceY<Node>((node) => node.home.y).strength((node) => (node.fixed ? 0 : 0.06)),
    )
    .stop();
  for (let i = 0; i < TICKS; i++) {
    simulation.tick();
    for (const node of members) clamp(node);
  }
  separate(nodes);
  const place = (node: Node): Placed => ({
    id: node.id,
    r: node.r,
    x: round(node.x),
    y: round(node.y),
  });
  return { themes: fixed.slice(1).map(place), members: members.map(place) };
}

function round(value: number | undefined): number {
  return Math.round((value ?? 0) * 10) / 10;
}
