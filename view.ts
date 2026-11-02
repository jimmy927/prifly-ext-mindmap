/**
 * The map as the page draws it (`api/map`): every circle placed, every curve's
 * bend, every label's place, colours, the legend and the footer. The page
 * only draws this and animates from the last one.
 */

import { type Box, branchBend, type Circle, placeLabel } from "./curves";
import { CENTRE, FRAME, layout, orderThemes, type Point, ROOT_R, radiusOf } from "./layout";
import type { Item, Link, LinkKind, Sorting, Status } from "./types";

export const THEME_COLOURS = [
  "#2a78d6",
  "#1b9e6e",
  "#e0662f",
  "#7d55c7",
  "#c9497f",
  "#0e8fb0",
  "#b07d12",
  "#5d7a2a",
  "#8f5a74",
];

export const SERVICE_COLOURS: Record<string, string> = {
  WhatsApp: "#25d366",
  Gmail: "#ea4335",
  Outlook: "#0078d4",
  Telegram: "#229ed9",
  Instagram: "#e1306c",
  LinkedIn: "#0a66c2",
  Messenger: "#0084ff",
  Trello: "#0079bf",
};

export type ViewTheme = Point & {
  id: string;
  name: string;
  sub: string;
  color: string;
  r: number;
  bend: number;
};
export type ViewNode = Point & {
  id: string;
  kind: Item["kind"];
  title: string;
  lines: string[];
  theme: string;
  color: string;
  r: number;
  bend: number;
  /** A session's state; absent on conversations and cards. */
  status?: Status;
  /** A conversation's or card's service, and its colour for the ring. */
  service?: string;
  ring?: string;
  url?: string;
};
export type ViewLink = {
  a: string;
  b: string;
  kind: LinkKind;
  bend: number;
  label: { x: number; y: number; text: string };
};
export type MapView = {
  frame: { width: number; height: number };
  root: Point & { r: number; label: string };
  themes: ViewTheme[];
  nodes: ViewNode[];
  links: ViewLink[];
  legend: { services: { name: string; color: string }[] };
  footer: {
    model: string;
    skipped: string[];
    sessions: number;
    conversations: number;
    cards: number;
  };
};

/** The colours themes keep across updates: a new theme takes the first colour no theme now has. */
export function assignColours(
  themeIds: readonly string[],
  kept: ReadonlyMap<string, string>,
): Map<string, string> {
  const live = new Map([...kept].filter(([id]) => themeIds.includes(id)));
  for (const id of themeIds) {
    if (live.has(id)) continue;
    const used = new Set(live.values());
    const free = THEME_COLOURS.find((colour) => !used.has(colour));
    live.set(id, free ?? THEME_COLOURS[live.size % THEME_COLOURS.length] ?? "#2a78d6");
  }
  return live;
}

export type ViewInput = {
  items: readonly Item[];
  sorting: Sorting;
  links: readonly Link[];
  previous: ReadonlyMap<string, Point>;
  previousOrder: readonly string[];
  colours: ReadonlyMap<string, string>;
  footer: MapView["footer"];
};

function nodeOf(item: Item, sorting: Sorting, colour: string, at: Point, r: number): ViewNode {
  const node: ViewNode = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    lines: sorting.lines[item.id] ?? [],
    theme: sorting.themeOf[item.id] ?? "",
    color: colour,
    r,
    x: at.x,
    y: at.y,
    bend: branchBend(item.id),
  };
  if (item.kind === "session") node.status = item.status;
  else {
    node.service = item.repo;
    node.ring = SERVICE_COLOURS[item.repo] ?? "#6b7280";
  }
  if (item.url !== undefined) node.url = item.url;
  return node;
}

function placeLinks(links: readonly Link[], circles: Map<string, Circle>): ViewLink[] {
  const placed: Box[] = [];
  const all = [...circles.values()];
  return links.flatMap((link) => {
    const a = circles.get(link.a);
    const b = circles.get(link.b);
    if (a === undefined || b === undefined) return [];
    const base = link.kind === "related" ? 0.18 : 0.1;
    const spot = placeLabel(a, b, base, link.label, all, placed);
    return [
      {
        a: link.a,
        b: link.b,
        kind: link.kind,
        bend: spot.bend,
        label: { ...spot.at, text: spot.text },
      },
    ];
  });
}

/** The whole map, laid out. Also the themes' order and colours, for the next layout to keep. */
export function buildView(input: ViewInput): {
  view: MapView;
  order: string[];
  colours: Map<string, string>;
} {
  const { items, sorting } = input;
  const sizes = new Map<string, number>();
  for (const item of items) {
    const theme = sorting.themeOf[item.id];
    if (theme !== undefined) sizes.set(theme, (sizes.get(theme) ?? 0) + 1);
  }
  const themeIds = sorting.themes.map((theme) => theme.id).filter((id) => sizes.has(id));
  const order = orderThemes(themeIds, sorting.themeOf, input.links, sizes, input.previousOrder);
  const colours = assignColours(order, input.colours);
  const members = items.flatMap((item) => {
    const theme = sorting.themeOf[item.id];
    return theme === undefined ? [] : [{ id: item.id, theme, r: radiusOf(item.kind) }];
  });
  const placed = layout({ themes: order, members, previous: input.previous });
  const themes: ViewTheme[] = placed.themes.map((spot) => {
    const theme = sorting.themes.find((t) => t.id === spot.id);
    return {
      ...spot,
      name: theme?.name ?? spot.id,
      sub: theme?.sub ?? "",
      color: colours.get(spot.id) ?? "#2a78d6",
      bend: branchBend(`theme:${spot.id}`),
    };
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  const nodes = placed.members.flatMap((spot) => {
    const item = byId.get(spot.id);
    if (item === undefined) return [];
    const colour = colours.get(sorting.themeOf[item.id] ?? "") ?? "#2a78d6";
    return [nodeOf(item, sorting, colour, spot, spot.r)];
  });
  const circles = new Map<string, Circle>([
    ["root", { ...CENTRE, r: ROOT_R }],
    ...themes.map((t): [string, Circle] => [t.id, t]),
    ...nodes.map((n): [string, Circle] => [n.id, n]),
  ]);
  const services = [
    ...new Set(nodes.flatMap((node) => (node.service === undefined ? [] : [node.service]))),
  ];
  const view: MapView = {
    frame: { ...FRAME },
    root: { ...CENTRE, r: ROOT_R, label: "all sessions" },
    themes,
    nodes,
    links: placeLinks(input.links, circles),
    legend: {
      services: services.map((name) => ({ name, color: SERVICE_COLOURS[name] ?? "#6b7280" })),
    },
    footer: input.footer,
  };
  return { view, order, colours };
}
