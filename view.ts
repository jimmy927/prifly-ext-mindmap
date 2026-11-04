/**
 * The map as the page draws it (`api/map`): every circle placed, every curve's
 * bend, every label's place, colours, the legend and the footer. The page
 * only draws this and animates from the last one.
 */

import { OTHER } from "./areas";
import { type Box, branchBend, type Circle, placeLabel } from "./curves";
import {
  CENTRE,
  FRAME,
  HUB_R,
  type LayoutMember,
  layout,
  orderThemes,
  type Point,
  ROOT_R,
  radiusOf,
} from "./layout";
import { type MenuEntry, menuFor } from "./opening";
import { normalise } from "./rules";
import type { Item, Link, LinkKind, Sorting, Status } from "./types";

/** The colour of "Other", the area for what fits none of the reader's. */
export const OTHER_COLOUR = "#6b7280";
/** A sub-topic gets a hub of its own from this many members; one alone hangs from its area. */
export const MIN_HUB = 2;

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
  /** Every place the circle can be opened, the first being a left-click; empty: nowhere. */
  menu: MenuEntry[];
  /** With areas: its sub-topic, the hub it hangs from (when the sub-topic has one), and whether the reader placed it. */
  sub?: string;
  hub?: string;
  manual?: boolean;
};
/** A sub-topic's hub inside an area's branch. */
export type ViewSub = Point & {
  id: string;
  theme: string;
  name: string;
  color: string;
  r: number;
  bend: number;
};
/** An area as the "Move to theme…" list offers it, with its sub-topics now. */
export type ViewArea = { id: string; name: string; subs: string[] };
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
  /** Sub-topic hubs; absent on a map saved before there were any. */
  subs?: ViewSub[];
  nodes: ViewNode[];
  links: ViewLink[];
  /** The reader's areas, for "Move to theme…"; absent without areas. */
  areas?: ViewArea[];
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

/**
 * `view` with only the circles whose item is in `ids`: a node whose item has
 * gone, every link to one, and any theme left with no node. Adds nothing.
 * Null when nothing is left.
 */
export function restrictView(view: MapView, ids: ReadonlySet<string>): MapView | null {
  const nodes = view.nodes.filter((node) => ids.has(node.id));
  if (nodes.length === 0) return null;
  const hubs = new Set(nodes.map((node) => node.hub));
  // The reader's areas stay on the map empty; a model's theme (and "Other") goes with its last item.
  const themes = new Set([
    ...nodes.map((node) => node.theme),
    ...(view.areas ?? []).map((area) => area.id),
  ]);
  const count = (kind: Item["kind"]) => nodes.filter((node) => node.kind === kind).length;
  const services = new Set(
    nodes.flatMap((node) => (node.service === undefined ? [] : [node.service])),
  );
  return {
    ...view,
    themes: view.themes.filter((theme) => themes.has(theme.id)),
    ...(view.subs === undefined ? {} : { subs: view.subs.filter((sub) => hubs.has(sub.id)) }),
    nodes,
    links: view.links.filter((link) => ids.has(link.a) && ids.has(link.b)),
    legend: { services: view.legend.services.filter((s) => services.has(s.name)) },
    footer: {
      ...view.footer,
      sessions: count("session"),
      conversations: count("conversation"),
      cards: count("card"),
    },
  };
}

export type ViewInput = {
  items: readonly Item[];
  sorting: Sorting;
  links: readonly Link[];
  previous: ReadonlyMap<string, Point>;
  /** Each item's theme last time, by id. */
  previousTheme: ReadonlyMap<string, string>;
  previousOrder: readonly string[];
  colours: ReadonlyMap<string, string>;
  footer: MapView["footer"];
};

function nodeOf(
  item: Item,
  sorting: Sorting,
  colour: string,
  at: Point,
  r: number,
  menu: MenuEntry[],
): ViewNode {
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
    menu,
  };
  if (item.kind === "session") node.status = item.status;
  else {
    node.service = item.repo;
    node.ring = SERVICE_COLOURS[item.repo] ?? "#6b7280";
  }
  if (item.url !== undefined) node.url = item.url;
  const sub = sorting.subOf?.[item.id];
  if (sub !== undefined && sub !== "") node.sub = sub;
  if (sorting.manual?.includes(item.id) === true) node.manual = true;
  return node;
}

type Hub = { id: string; theme: string; name: string; members: string[] };

/** The sub-topics drawn as hubs: those with at least `MIN_HUB` members in one area. */
export function hubsOf(items: readonly Item[], sorting: Sorting): Hub[] {
  const hubs = new Map<string, Hub>();
  for (const item of items) {
    const theme = sorting.themeOf[item.id];
    const sub = sorting.subOf?.[item.id] ?? "";
    if (theme === undefined || normalise(sub) === "") continue;
    const id = `sub:${theme}:${normalise(sub)}`;
    const hub = hubs.get(id) ?? { id, theme, name: sub, members: [] };
    hub.members.push(item.id);
    hubs.set(id, hub);
  }
  return [...hubs.values()].filter((hub) => hub.members.length >= MIN_HUB);
}

/** What the layout places: the loose members of each theme, then each hub followed by its members. */
function layoutMembers(items: readonly Item[], sorting: Sorting, hubs: Hub[]): LayoutMember[] {
  const inHub = new Set(hubs.flatMap((hub) => hub.members));
  const byId = new Map(items.map((item) => [item.id, item]));
  const loose = items.flatMap((item) => {
    const theme = sorting.themeOf[item.id];
    return theme === undefined || inHub.has(item.id)
      ? []
      : [{ id: item.id, theme, r: radiusOf(item.kind) }];
  });
  const grouped = hubs.flatMap((hub): LayoutMember[] => [
    { id: hub.id, theme: hub.theme, r: HUB_R },
    ...hub.members.map((id) => ({
      id,
      theme: hub.theme,
      r: radiusOf(byId.get(id)?.kind ?? "session"),
      parent: hub.id,
    })),
  ]);
  return [...loose, ...grouped];
}

/**
 * The themes' order round the ellipse and their colours. The reader's areas
 * keep their own order, and each area the colour of its place in it ("Other"
 * grey, shown only with an item); a model's themes are ordered by their links
 * and keep the colours they had.
 */
function orderAndColours(
  input: ViewInput,
  sizes: ReadonlyMap<string, number>,
): { order: string[]; colours: Map<string, string> } {
  const { sorting } = input;
  const areas = sorting.areaOrder;
  if (areas === undefined) {
    const themeIds = sorting.themes.map((theme) => theme.id).filter((id) => sizes.has(id));
    const order = orderThemes(themeIds, sorting.themeOf, input.links, sizes, input.previousOrder);
    return { order, colours: assignColours(order, input.colours) };
  }
  const order = areas.filter((id) => id !== OTHER.id || sizes.has(id));
  const colourOf = (id: string, i: number) =>
    id === OTHER.id ? OTHER_COLOUR : (THEME_COLOURS[i % THEME_COLOURS.length] ?? OTHER_COLOUR);
  return { order, colours: new Map(areas.map((id, i) => [id, colourOf(id, i)])) };
}

/** The areas for "Move to theme…", each with the sub-topics its items have now. */
function areasOf(items: readonly Item[], sorting: Sorting): ViewArea[] | undefined {
  if (sorting.areaOrder === undefined) return undefined;
  const names = new Map(sorting.themes.map((theme) => [theme.id, theme.name]));
  return sorting.areaOrder
    .filter((id) => id !== OTHER.id)
    .map((id) => {
      const subs = items.flatMap((item) => {
        const sub = sorting.subOf?.[item.id] ?? "";
        return sorting.themeOf[item.id] === id && sub !== "" ? [sub] : [];
      });
      return { id, name: names.get(id) ?? id, subs: [...new Set(subs)].sort() };
    });
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
  const { order, colours } = orderAndColours(input, sizes);
  const hubs = hubsOf(items, sorting);
  const hubOf = new Map(hubs.flatMap((hub) => hub.members.map((id) => [id, hub.id])));
  const placed = layout({
    themes: order,
    members: layoutMembers(items, sorting, hubs),
    previous: input.previous,
    previousTheme: input.previousTheme,
  });
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
  const hubById = new Map(hubs.map((hub) => [hub.id, hub]));
  const subs: ViewSub[] = placed.members.flatMap((spot) => {
    const hub = hubById.get(spot.id);
    if (hub === undefined) return [];
    const color = colours.get(hub.theme) ?? "#2a78d6";
    return [{ ...spot, theme: hub.theme, name: hub.name, color, bend: branchBend(spot.id) }];
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  const nodes = placed.members.flatMap((spot) => {
    const item = byId.get(spot.id);
    if (item === undefined) return [];
    const colour = colours.get(sorting.themeOf[item.id] ?? "") ?? "#2a78d6";
    const node = nodeOf(item, sorting, colour, spot, spot.r, menuFor(item, items, input.links));
    const hub = hubOf.get(item.id);
    if (hub !== undefined) node.hub = hub;
    return [node];
  });
  const circles = new Map<string, Circle>([
    ["root", { ...CENTRE, r: ROOT_R }],
    ...[...themes, ...subs, ...nodes].map((c): [string, Circle] => [c.id, c]),
  ]);
  const services = [
    ...new Set(nodes.flatMap((node) => (node.service === undefined ? [] : [node.service]))),
  ];
  const areas = areasOf(items, sorting);
  const view: MapView = {
    frame: { ...FRAME },
    root: { ...CENTRE, r: ROOT_R, label: "all sessions" },
    themes,
    subs,
    nodes,
    links: placeLinks(input.links, circles),
    legend: {
      services: services.map((name) => ({ name, color: SERVICE_COLOURS[name] ?? "#6b7280" })),
    },
    footer: input.footer,
    ...(areas === undefined ? {} : { areas }),
  };
  return { view, order, colours };
}
