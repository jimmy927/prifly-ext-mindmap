/**
 * From items to topics, without any call: shared entities and embeddings
 * (those at hand) give each conversation and card a match to the sessions;
 * the best-matching ones are kept; the kept items are clustered; and the
 * related links are picked — pairs that share an entity, or that embeddings
 * find very similar, across kinds and services first.
 */

import { cluster, type Edge, SIMILAR, similarityEdges, VERY_SIMILAR } from "./cluster";
import { cosine } from "./embed";
import { type Entity, type EntityEdge, entitiesOf, entityEdges, pairKey } from "./entities";
import type { TopicInfo } from "./model";
import { keepCards, keepConversations } from "./sources";
import type { Item } from "./types";

/** At most this many dashed related links. */
export const MAX_RELATED = 20;
const PER_ITEM = 2;

export type Related = { a: string; b: string; label: string | null; similar: boolean };

export type Worked = {
  items: Item[];
  entities: Map<string, Entity[]>;
  topics: TopicInfo[];
  topicOf: Map<string, string>;
  nextId: number;
  /** Ranked; a similarity-only pair's label is the namer's, so null here. */
  related: Related[];
};

export type WorkInput = {
  sessions: readonly Item[];
  /** Every conversation and card the listings gave. */
  others: readonly Item[];
  vectorOf: (item: Item) => readonly number[] | undefined;
  previous: ReadonlyMap<string, string>;
  nextId: number;
  now: number;
};

function vectorsOf(items: readonly Item[], vectorOf: WorkInput["vectorOf"]) {
  const vectors = new Map<string, readonly number[]>();
  for (const item of items) {
    const vector = vectorOf(item);
    if (vector !== undefined) vectors.set(item.id, vector);
  }
  return vectors;
}

/** How well an item matches the sessions: its strongest tie to one, by shared entities plus similarity. */
function matcher(
  sessions: readonly Item[],
  byPair: ReadonlyMap<string, EntityEdge>,
  vectors: ReadonlyMap<string, readonly number[]>,
): (item: Item) => number {
  const scores = new Map<string, number>();
  return (item) => {
    const known = scores.get(item.id);
    if (known !== undefined) return known;
    const own = vectors.get(item.id);
    let best = 0;
    for (const session of sessions) {
      const shared = byPair.get(pairKey(item.id, session.id))?.weight ?? 0;
      const other = vectors.get(session.id);
      const sim = own !== undefined && other !== undefined ? cosine(own, other) : 0;
      best = Math.max(best, shared + (sim >= SIMILAR ? sim : 0));
    }
    scores.set(item.id, best);
    return best;
  };
}

/** Whether a pair crosses kinds or services: the links worth drawing first. */
function crosses(a: Item, b: Item): boolean {
  return a.kind !== b.kind || a.repo !== b.repo;
}

type Ranked = Related & { rank: number };

/** Pairs that share an entity; two sessions that only share their repository are not worth a link. */
function sharedPairs(byId: ReadonlyMap<string, Item>, shared: readonly EntityEdge[]): Ranked[] {
  return shared.flatMap((edge) => {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (a === undefined || b === undefined) return [];
    const sameRepo = a.kind === "session" && b.kind === "session" && a.repo === b.repo;
    if (sameRepo && edge.label === a.repo) return [];
    const rank = (crosses(a, b) ? 100 : 0) + 10 + edge.weight;
    return [{ a: a.id, b: b.id, label: edge.label, similar: false, rank }];
  });
}

/** Pairs in one topic that only embeddings tie, very similar ones only. */
function similarPairs(
  byId: ReadonlyMap<string, Item>,
  tied: ReadonlySet<string>,
  vectors: ReadonlyMap<string, readonly number[]>,
  topicOf: ReadonlyMap<string, string>,
): Ranked[] {
  const ids = [...vectors.keys()].filter((id) => byId.has(id)).sort();
  const out: Ranked[] = [];
  ids.forEach((a, i) => {
    for (const b of ids.slice(i + 1)) {
      if (tied.has(pairKey(a, b)) || topicOf.get(a) !== topicOf.get(b)) continue;
      const sim = cosine(vectors.get(a) ?? [], vectors.get(b) ?? []);
      const x = byId.get(a);
      const y = byId.get(b);
      if (sim < VERY_SIMILAR || x === undefined || y === undefined) continue;
      out.push({ a, b, label: null, similar: true, rank: (crosses(x, y) ? 100 : 0) + sim });
    }
  });
  return out;
}

function relatedOf(
  items: readonly Item[],
  shared: readonly EntityEdge[],
  vectors: ReadonlyMap<string, readonly number[]>,
  topicOf: ReadonlyMap<string, string>,
): Related[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const tied = new Set(shared.map((edge) => pairKey(edge.a, edge.b)));
  const ranked = [...sharedPairs(byId, shared), ...similarPairs(byId, tied, vectors, topicOf)].sort(
    (x, y) => y.rank - x.rank || (pairKey(x.a, x.b) < pairKey(y.a, y.b) ? -1 : 1),
  );
  // At most two links per item, so a chat that names a repository does not link to all its sessions.
  const per = new Map<string, number>();
  const out: Related[] = [];
  for (const { a, b, label, similar } of ranked) {
    if (out.length >= MAX_RELATED) break;
    if ((per.get(a) ?? 0) >= PER_ITEM || (per.get(b) ?? 0) >= PER_ITEM) continue;
    per.set(a, (per.get(a) ?? 0) + 1);
    per.set(b, (per.get(b) ?? 0) + 1);
    out.push({ a, b, label, similar });
  }
  return out;
}

/** Everything the map is made of before naming: which items, their topics, and the related links. */
export function workOut(input: WorkInput): Worked {
  const pool = [...input.sessions, ...input.others];
  const entities = entitiesOf(pool);
  const shared = entityEdges(entities);
  const byPair = new Map(shared.map((edge) => [pairKey(edge.a, edge.b), edge]));
  const allVectors = vectorsOf(pool, input.vectorOf);
  const score = matcher(input.sessions, byPair, allVectors);
  const items = [
    ...input.sessions,
    ...keepConversations(input.others, score, input.now),
    ...keepCards(input.others, score),
  ];
  const kept = new Set(items.map((item) => item.id));
  const vectors = new Map([...allVectors].filter(([id]) => kept.has(id)));
  const keptShared = shared.filter((edge) => kept.has(edge.a) && kept.has(edge.b));
  const edges: Edge[] = [...keptShared, ...similarityEdges(vectors)];
  const topics = cluster({
    items,
    edges,
    vectors,
    previous: input.previous,
    nextId: input.nextId,
  });
  const related = relatedOf(items, keptShared, vectors, topics.topicOf);
  const byId = new Map(items.map((item) => [item.id, item]));
  const infos: TopicInfo[] = [...topics.members].map(([id, members]) => ({
    id,
    members: members.flatMap((m) => byId.get(m) ?? []),
    pairs: related
      .filter((r) => r.similar && topics.topicOf.get(r.a) === id)
      .map((r): [string, string] => [r.a, r.b]),
  }));
  return {
    items,
    entities: new Map([...entities].filter(([id]) => kept.has(id))),
    topics: infos,
    topicOf: topics.topicOf,
    nextId: topics.nextId,
    related,
  };
}
