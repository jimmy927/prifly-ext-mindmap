/**
 * From items to what the model is sent, without any call: shared entities give
 * each conversation and card a match to the sessions; the best-matching ones
 * are kept; and the pairs that share an entity become hints (and, with the
 * pairs the model finds, the related links). Nothing here groups: that is the
 * model's.
 */

import { type Entity, type EntityEdge, entitiesOf, entityEdges, pairKey } from "./entities";
import type { Pair } from "./sorting";
import { keepCards, keepConversations } from "./sources";
import type { Item } from "./types";

/** At most this many dashed related links. */
export const MAX_RELATED = 20;
/** At most this many shared-entity pairs go to the model as hints. */
export const MAX_HINTS = 40;
const PER_ITEM = 2;

export type Picked = {
  items: Item[];
  entities: Map<string, Entity[]>;
  /** Pairs that share an entity, best first, with the entity as label. */
  shared: Pair[];
};

export type PickInput = {
  sessions: readonly Item[];
  /** Every conversation and card the listings gave. */
  others: readonly Item[];
  now: number;
};

/** How well an item matches the sessions: its strongest shared entity with one. */
function matcher(
  sessions: readonly Item[],
  byPair: ReadonlyMap<string, EntityEdge>,
): (item: Item) => number {
  return (item) =>
    sessions.reduce((best, session) => {
      return Math.max(best, byPair.get(pairKey(item.id, session.id))?.weight ?? 0);
    }, 0);
}

/** Whether a pair crosses kinds or services: the links worth drawing first. */
function crosses(a: Item, b: Item): boolean {
  return a.kind !== b.kind || a.repo !== b.repo;
}

type Ranked = Pair & { rank: number };

/** Pairs that share an entity, best first; two sessions that only share their repository are not worth a link. */
function rankedShared(items: readonly Item[], shared: readonly EntityEdge[]): Ranked[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return shared
    .flatMap((edge) => {
      const a = byId.get(edge.a);
      const b = byId.get(edge.b);
      if (a === undefined || b === undefined) return [];
      const sameRepo = a.kind === "session" && b.kind === "session" && a.repo === b.repo;
      if (sameRepo && edge.label === a.repo) return [];
      const rank = (crosses(a, b) ? 100 : 0) + 10 + edge.weight;
      return [{ a: a.id, b: b.id, label: edge.label, rank }];
    })
    .sort((x, y) => y.rank - x.rank || (pairKey(x.a, x.b) < pairKey(y.a, y.b) ? -1 : 1));
}

/** Which items are drawn, and the shared-entity pairs between them. */
export function pick(input: PickInput): Picked {
  const pool = [...input.sessions, ...input.others];
  const entities = entitiesOf(pool);
  const shared = entityEdges(entities);
  const byPair = new Map(shared.map((edge) => [pairKey(edge.a, edge.b), edge]));
  const score = matcher(input.sessions, byPair);
  const items = [
    ...input.sessions,
    ...keepConversations(input.others, score, input.now),
    ...keepCards(input.others, score),
  ];
  const kept = new Set(items.map((item) => item.id));
  const keptShared = shared.filter((edge) => kept.has(edge.a) && kept.has(edge.b));
  return {
    items,
    entities: new Map([...entities].filter(([id]) => kept.has(id))),
    shared: rankedShared(items, keptShared)
      .slice(0, MAX_HINTS)
      .map(({ a, b, label }) => ({ a, b, label })),
  };
}

/**
 * The dashed links: the pairs that share an entity (labelled by it) and the
 * pairs the model found (labelled by it), across kinds and services first, at
 * most two per item and `MAX_RELATED` in all.
 */
export function relatedOf(picked: Picked, found: readonly Pair[]): Pair[] {
  const byId = new Map(picked.items.map((item) => [item.id, item]));
  const tied = new Set(picked.shared.map((p) => pairKey(p.a, p.b)));
  const own = picked.shared.map((pair, i): Ranked => ({ ...pair, rank: 1000 - i }));
  const theirs = found.flatMap((pair, i): Ranked[] => {
    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    if (a === undefined || b === undefined || tied.has(pairKey(pair.a, pair.b))) return [];
    return [{ ...pair, rank: (crosses(a, b) ? 500 : 0) - i }];
  });
  const per = new Map<string, number>();
  const out: Pair[] = [];
  for (const { a, b, label } of [...own, ...theirs].sort((x, y) => y.rank - x.rank)) {
    if (out.length >= MAX_RELATED) break;
    if ((per.get(a) ?? 0) >= PER_ITEM || (per.get(b) ?? 0) >= PER_ITEM) continue;
    per.set(a, (per.get(a) ?? 0) + 1);
    per.set(b, (per.get(b) ?? 0) + 1);
    out.push({ a, b, label });
  }
  return out;
}
