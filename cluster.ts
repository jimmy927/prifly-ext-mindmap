/**
 * Topics: the items split into 6 to 9 clusters by a weighted graph of shared
 * entities (strong edges) and embedding similarity (weak ones), with Louvain
 * community detection — our own, deterministic: nodes in id order, ties to the
 * lowest community. Each item starts in its last topic and is a little sticky
 * there, so one new item does not reshuffle the map; topics keep their ids
 * while most of their members stay.
 */

import { cosine } from "./embed";
import type { Item } from "./types";

export const MIN_TOPICS = 6;
export const MAX_TOPICS = 9;
/**
 * Cosine similarity above this is a weak edge, and above `VERY_SIMILAR` a
 * related link worth drawing. Set for EmbeddingGemma, whose cosines run high:
 * on 48 real items the median pair was 0.75, the top 10 % above 0.84 and the
 * top 1 % above 0.90.
 */
export const SIMILAR = 0.84;
export const VERY_SIMILAR = 0.9;
/** Each item's weak edges: to its closest few only. */
const NEIGHBOURS = 4;
/** How much an item prefers staying in its last topic, as a share of its degree. */
const STICK = 0.15;
/** A loose item joins the nearest topic only when it is at least this close. */
const NEAR = SIMILAR;

export type Edge = { a: string; b: string; weight: number };

/** The weak edges: each item to its closest few items above `SIMILAR`. */
export function similarityEdges(vectors: ReadonlyMap<string, readonly number[]>): Edge[] {
  const ids = [...vectors.keys()].sort();
  const best = new Map<string, Edge>();
  for (const a of ids) {
    const va = vectors.get(a) ?? [];
    const near = ids
      .filter((b) => b !== a)
      .map((b) => ({ b, sim: cosine(va, vectors.get(b) ?? []) }))
      .filter(({ sim }) => sim >= SIMILAR)
      .sort((x, y) => y.sim - x.sim || (x.b < y.b ? -1 : 1))
      .slice(0, NEIGHBOURS);
    for (const { b, sim } of near) {
      const [x, y] = a < b ? [a, b] : [b, a];
      best.set(`${x}|${y}`, { a: x, b: y, weight: 0.2 + (sim - SIMILAR) / (1 - SIMILAR) });
    }
  }
  return [...best.values()];
}

type Adjacency = Map<number, number>[];

function renumber(labels: readonly number[]): number[] {
  const seen = new Map<number, number>();
  return labels.map((label) => {
    const known = seen.get(label);
    if (known !== undefined) return known;
    seen.set(label, seen.size);
    return seen.size - 1;
  });
}

function degrees(adj: Adjacency): number[] {
  return adj.map((row) => [...row.values()].reduce((sum, w) => sum + w, 0));
}

/** Louvain's first phase: move each node to the neighbouring community that gains most. */
function localMove(
  adj: Adjacency,
  comm: number[],
  resolution: number,
  seed: readonly number[] | null,
): boolean {
  const k = degrees(adj);
  const m2 = k.reduce((sum, x) => sum + x, 0);
  if (m2 === 0) return false;
  const tot = new Map<number, number>();
  comm.forEach((c, i) => {
    tot.set(c, (tot.get(c) ?? 0) + (k[i] ?? 0));
  });
  let any = false;
  for (let pass = 0; pass < 50; pass++) {
    let moved = false;
    for (let i = 0; i < adj.length; i++) {
      const best = bestCommunity(i, adj, comm, k, tot, { m2, resolution, seed });
      if (best !== comm[i]) {
        comm[i] = best;
        moved = true;
        any = true;
      }
    }
    if (!moved) break;
  }
  return any;
}

function bestCommunity(
  i: number,
  adj: Adjacency,
  comm: number[],
  k: readonly number[],
  tot: Map<number, number>,
  opts: { m2: number; resolution: number; seed: readonly number[] | null },
): number {
  const own = comm[i] ?? i;
  const ki = k[i] ?? 0;
  tot.set(own, (tot.get(own) ?? 0) - ki);
  const links = new Map<number, number>();
  for (const [j, w] of adj[i] ?? []) {
    if (j === i) continue;
    const c = comm[j] ?? j;
    links.set(c, (links.get(c) ?? 0) + w);
  }
  const gain = (c: number) =>
    (links.get(c) ?? 0) -
    (opts.resolution * (tot.get(c) ?? 0) * ki) / opts.m2 +
    (opts.seed !== null && opts.seed[i] === c ? STICK * ki : 0);
  let best = own;
  let bestGain = gain(own);
  for (const c of [...links.keys()].sort((x, y) => x - y)) {
    const g = gain(c);
    if (g > bestGain + 1e-9) {
      best = c;
      bestGain = g;
    }
  }
  tot.set(best, (tot.get(best) ?? 0) + ki);
  return best;
}

/** The graph of communities: one node each, edges summed. */
function aggregate(adj: Adjacency, comm: readonly number[], count: number): Adjacency {
  const out: Adjacency = Array.from({ length: count }, () => new Map<number, number>());
  adj.forEach((row, i) => {
    const ci = comm[i] ?? 0;
    const target = out[ci];
    if (target === undefined) return;
    for (const [j, w] of row) {
      const cj = comm[j] ?? 0;
      target.set(cj, (target.get(cj) ?? 0) + w);
    }
  });
  return out;
}

/** Louvain from the partition `init`: each node's community, renumbered from 0 in node order. */
export function louvain(adj: Adjacency, init: readonly number[], resolution = 1): number[] {
  let graph = adj;
  let comm = renumber(init);
  const seed = [...comm];
  let membership = adj.map((_, i) => i);
  for (let level = 0; level < 20; level++) {
    const moved = localMove(graph, comm, resolution, level === 0 ? seed : null);
    comm = renumber(comm);
    const now = comm;
    membership = membership.map((node) => now[node] ?? node);
    const count = Math.max(-1, ...comm) + 1;
    if (level > 0 && (!moved || count === graph.length)) break;
    graph = aggregate(graph, comm, count);
    comm = graph.map((_, i) => i);
  }
  return renumber(membership);
}

export type ClusterInput = {
  items: readonly Item[];
  edges: readonly Edge[];
  vectors: ReadonlyMap<string, readonly number[]>;
  /** Each item's topic last time. */
  previous: ReadonlyMap<string, string>;
  /** The next new topic gets `t<nextId>`. */
  nextId: number;
};

export type Topics = {
  /** Topic id → its members, in id order. */
  members: Map<string, string[]>;
  topicOf: Map<string, string>;
  nextId: number;
};

type Groups = string[][];

function partition(
  ids: readonly string[],
  edges: readonly Edge[],
  previous: ReadonlyMap<string, string>,
  resolution: number,
): { groups: Groups; loose: string[] } {
  const index = new Map(ids.map((id, i) => [id, i]));
  const adj: Adjacency = ids.map(() => new Map<number, number>());
  for (const { a, b, weight } of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined || i === j || weight <= 0) continue;
    adj[i]?.set(j, (adj[i]?.get(j) ?? 0) + weight);
    adj[j]?.set(i, (adj[j]?.get(i) ?? 0) + weight);
  }
  const linked = ids.filter((_, i) => (adj[i]?.size ?? 0) > 0);
  const loose = ids.filter((_, i) => (adj[i]?.size ?? 0) === 0);
  const sub = new Map(linked.map((id, i) => [id, i]));
  const subAdj: Adjacency = linked.map((id) => {
    const row = new Map<number, number>();
    for (const [j, w] of adj[index.get(id) ?? 0] ?? []) {
      const at = sub.get(ids[j] ?? "");
      if (at !== undefined) row.set(at, w);
    }
    return row;
  });
  const labels = new Map<string, number>();
  const init = linked.map((id, i) => {
    const topic = previous.get(id);
    if (topic === undefined) return linked.length + i;
    if (!labels.has(topic)) labels.set(topic, labels.size);
    return labels.get(topic) ?? i;
  });
  const comm = louvain(subAdj, init, resolution);
  const groups: Groups = [];
  linked.forEach((id, i) => {
    const c = comm[i] ?? 0;
    groups[c] = [...(groups[c] ?? []), id];
  });
  return { groups: groups.filter((g) => g !== undefined), loose };
}

function centroid(ids: readonly string[], vectors: ReadonlyMap<string, readonly number[]>) {
  const list = ids.flatMap((id) => {
    const v = vectors.get(id);
    return v === undefined ? [] : [v];
  });
  if (list.length === 0) return null;
  const sum = new Array<number>(list[0]?.length ?? 0).fill(0);
  for (const v of list) {
    v.forEach((x, i) => {
      sum[i] = (sum[i] ?? 0) + x;
    });
  }
  return sum;
}

/** The group a loose item joins: its last topic's, the nearest by embedding, its repository's; else -1. */
function homeOf(item: Item, groups: Groups, input: ClusterInput, ids: Map<number, string>): number {
  const last = input.previous.get(item.id);
  const lastGroup = [...ids].find(([, id]) => id === last)?.[0];
  if (lastGroup !== undefined) return lastGroup;
  const vector = input.vectors.get(item.id);
  if (vector !== undefined) {
    let best = -1;
    let bestSim = NEAR;
    groups.forEach((group, g) => {
      const c = centroid(group, input.vectors);
      const sim = c === null ? -1 : cosine(vector, c);
      if (sim > bestSim) {
        best = g;
        bestSim = sim;
      }
    });
    if (best !== -1) return best;
  }
  if (item.kind !== "session") return -1;
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const counts = groups.map(
    (group) =>
      group.filter((id) => byId.get(id)?.kind === "session" && byId.get(id)?.repo === item.repo)
        .length,
  );
  const most = Math.max(0, ...counts);
  return most === 0 ? -1 : counts.indexOf(most);
}

/** Loose items placed: in a group, or in a new one per repository, or in one "other" group. */
function placeLoose(loose: readonly string[], groups: Groups, input: ClusterInput): Groups {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const ids = matchIds(groups, input.previous, { value: input.nextId }, false);
  const added = new Map<string, string[]>();
  const out = groups.map((g) => [...g]);
  for (const id of loose) {
    const item = byId.get(id);
    if (item === undefined) continue;
    const home = homeOf(item, groups, input, ids);
    if (home !== -1) {
      out[home]?.push(id);
      continue;
    }
    const key = item.kind === "session" && item.repo !== "" ? `repo:${item.repo}` : "other";
    added.set(key, [...(added.get(key) ?? []), id]);
  }
  return [...out, ...added.values()];
}

function between(a: readonly string[], b: readonly string[], edges: readonly Edge[]): number {
  const x = new Set(a);
  const y = new Set(b);
  return edges
    .filter((e) => (x.has(e.a) && y.has(e.b)) || (x.has(e.b) && y.has(e.a)))
    .reduce((sum, e) => sum + e.weight, 0);
}

/** Merge the smallest group into the one it is most tied to (or nearest, or next smallest) until at most `MAX_TOPICS`. */
function fit(groups: Groups, input: ClusterInput): Groups {
  let out = groups.map((g) => [...g].sort());
  while (out.length > MAX_TOPICS) {
    out.sort((a, b) => b.length - a.length || ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));
    const small = out.pop() ?? [];
    const c = centroid(small, input.vectors);
    const score = (g: string[]) => {
      const tie = between(small, g, input.edges);
      if (tie > 0) return 10 + tie;
      const other = c === null ? null : centroid(g, input.vectors);
      return c !== null && other !== null ? cosine(c, other) : 0;
    };
    let target = out.length - 1;
    out.forEach((g, i) => {
      if (score(g) > score(out[target] ?? [])) target = i;
    });
    out[target] = [...(out[target] ?? []), ...small].sort();
    out = out.filter((g) => g.length > 0);
  }
  return out.map((g) => [...g].sort());
}

/**
 * Each group's id: the last topic most of whose members it holds (or that
 * holds most of its members), greedily by overlap; else a new `t<n>`.
 */
function matchIds(
  groups: Groups,
  previous: ReadonlyMap<string, string>,
  next: { value: number },
  fresh: boolean,
): Map<number, string> {
  const sizes = new Map<string, number>();
  for (const topic of previous.values()) sizes.set(topic, (sizes.get(topic) ?? 0) + 1);
  const pairs: { g: number; topic: string; n: number }[] = [];
  groups.forEach((group, g) => {
    const counts = new Map<string, number>();
    for (const id of group) {
      const topic = previous.get(id);
      if (topic !== undefined) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    for (const [topic, n] of counts) {
      if (n * 2 >= Math.min(group.length, sizes.get(topic) ?? 0)) pairs.push({ g, topic, n });
    }
  });
  pairs.sort((x, y) => y.n - x.n || (x.topic < y.topic ? -1 : 1) || x.g - y.g);
  const ids = new Map<number, string>();
  const taken = new Set<string>();
  for (const { g, topic } of pairs) {
    if (ids.has(g) || taken.has(topic)) continue;
    ids.set(g, topic);
    taken.add(topic);
  }
  if (fresh) {
    groups.forEach((_, g) => {
      if (!ids.has(g)) ids.set(g, `t${next.value++}`);
    });
  }
  return ids;
}

function clusterAt(input: ClusterInput, resolution: number): Groups {
  const ids = input.items.map((item) => item.id).sort();
  const { groups, loose } = partition(ids, input.edges, input.previous, resolution);
  return fit(placeLoose(loose, groups, input), input);
}

/**
 * The topics: Louvain on the graph, loose items placed, at most `MAX_TOPICS`.
 * With fewer than `MIN_TOPICS` from enough items, a finer resolution is tried.
 */
export function cluster(input: ClusterInput): Topics {
  let groups = clusterAt(input, 1);
  if (groups.length < MIN_TOPICS && input.items.length >= 2 * MIN_TOPICS) {
    for (const resolution of [1.5, 2.5]) {
      const finer = clusterAt(input, resolution);
      if (finer.length > groups.length) groups = finer;
      if (groups.length >= MIN_TOPICS) break;
    }
  }
  const next = { value: input.nextId };
  const ids = matchIds(groups, input.previous, next, true);
  const members = new Map<string, string[]>();
  const topicOf = new Map<string, string>();
  groups.forEach((group, g) => {
    const id = ids.get(g) ?? `t${next.value++}`;
    members.set(id, group);
    for (const member of group) topicOf.set(member, id);
  });
  return { members, topicOf, nextId: next.value };
}
