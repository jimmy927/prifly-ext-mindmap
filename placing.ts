/**
 * Placing, when the reader has set areas: the model does not invent themes, it
 * puts each item under exactly one of the reader's areas (or "Other"), with an
 * optional sub-topic of 1-3 words inside it. What it is sent, the JSON Schema
 * it is asked to follow and how its answer is read. An area the answer names
 * that is not one of the reader's sends the item to "Other"; a sub-topic that
 * is a catch-all, a service's name or the area's own name is sent back once
 * with the reason, and left out if it comes back again (the item stays in its
 * area). The reader's own placements go along as examples.
 */

import { z } from "zod";
import { type Area, areaNamed, OTHER } from "./areas";
import { fold, SERVICES } from "./entities";
import type { LlmRequest } from "./llm";
import { nameProblem, normalise } from "./rules";
import { jsonIn, MAX_TOKENS, type Pair, promptItem, shorten, shortIds } from "./sorting";
import type { Item } from "./types";

const SUB_CHARS = 22;
/** The most reader placements sent as examples, the latest first. */
export const MAX_EXAMPLES = 30;

const SYSTEM = [
  "You place a person's coding sessions, chats, mails and Trello cards under the areas of their mind map.",
  "The areas are the person's own top-level themes. Never invent a new top-level theme, and never rename, merge or split an area.",
  "Answer with one JSON object and nothing else, in the shape of the schema:",
  '{"items":[{"id":"i1","area":"an area name, exactly as given","sub":"1-3 words, or empty"}],"related":[{"a":"i1","b":"i2","label":"1-2 words"}]}',
  'area: exactly one of the names in "areas", copied exactly. A hint after an area lists what belongs there. Choose by what the item is about (a product, a partner, a customer, a person, a chore), never by the service it came from: a session, a WhatsApp chat, a mail and a Trello card about the same thing go under the same area. An item that fits no area: "Other".',
  'sub: a sub-topic inside the area, 1-3 words naming what its items share (a partner, a feature, a person, an invoice run). Items about the same thing share one sub, spelled the same. Leave it "" for an item that stands alone. Never a service or tool such as WhatsApp, Gmail or Trello, never a catch-all ("Misc", "Other", "General", "Various"), never the area\'s own name.',
  "items: every item once. Give no summary lines: they are asked for separately.",
  'related: up to 20 pairs of items about the same thing, across kinds and services first, each with a label of 1-2 words naming what the two share. "sharedEntities" are pairs found by matching names, repositories and ticket ids: label them as given or better, and add others you see.',
  '"readerPlacements" are items the person placed by hand: place similar items the same way.',
  '"previousSubs" are the sub-topics of the last map with their members: keep a sub\'s name for the items that still belong together.',
].join("\n");

/** One manual placement, as an example: the item's title and where the reader put it. */
export type Example = { title: string; area: string; sub: string };
/** A sub-topic of the last map, by area name, with its members by full id. */
export type PreviousSub = { area: string; sub: string; members: string[] };
export type PlaceHints = { shared: Pair[]; previous: PreviousSub[]; examples: Example[] };

const Entry = z.object({ id: z.string(), area: z.string(), sub: z.string() });
const Related = z.object({ a: z.string(), b: z.string(), label: z.string() });
const Answer = z.object({ items: z.array(Entry), related: z.array(Related) });

export const PLACE_SCHEMA: Record<string, unknown> = Object.fromEntries(
  Object.entries(z.toJSONSchema(Answer)).filter(([key]) => key !== "$schema"),
);

/** "the reader put "Teamtailor webhook" under Partners & integrations / Teamtailor". */
export function exampleLine(example: Example): string {
  const where = example.sub === "" ? example.area : `${example.area} / ${example.sub}`;
  return `the reader put "${example.title}" under ${where}`;
}

/** The request that asks the fast tier to place `items` under `areas`. */
export function placingRequest(
  items: readonly Item[],
  areas: readonly Area[],
  hints: PlaceHints,
): LlmRequest {
  const short = shortIds(items);
  const idOf = (id: string) => short.get(id);
  const pairs = hints.shared.flatMap(({ a, b, label }) => {
    const x = idOf(a);
    const y = idOf(b);
    return x === undefined || y === undefined ? [] : [{ a: x, b: y, label }];
  });
  const payload = {
    areas: areas.map(({ name, hint }) => (hint === "" ? { name } : { name, hint })),
    items: items.map((item) => promptItem(item, idOf(item.id) ?? item.id)),
    sharedEntities: pairs,
    previousSubs: hints.previous.map((sub) => ({
      ...sub,
      members: sub.members.flatMap((id) => idOf(id) ?? []),
    })),
    readerPlacements: hints.examples.slice(0, MAX_EXAMPLES).map(exampleLine),
  };
  return {
    tier: "fast",
    system: SYSTEM,
    prompt: JSON.stringify(payload),
    schema: PLACE_SCHEMA,
    maxTokens: MAX_TOKENS,
  };
}

/** What a readable answer gives, by full item id: each item's area id and sub-topic. */
export type Placing = {
  areaOf: Map<string, string>;
  subOf: Map<string, string>;
  related: Pair[];
};

export type Placed = {
  placing: Placing | null;
  /** Every reason to ask again: items left out, bad sub-topics. */
  problems: string[];
};

/** Why `sub` is no good inside `area` beside the area's `others`; null when it is. */
export function subProblem(sub: string, area: Area, others: readonly string[]): string | null {
  if (SERVICES.includes(fold(sub))) return `the sub-topic "${sub}" is a service, not a subject`;
  if (normalise(sub) === normalise(area.name))
    return `the sub-topic "${sub}" only repeats its area's name`;
  const problem = nameProblem(sub, others);
  return problem?.kind === "catch-all" ? problem.text.replace("name", "sub-topic") : null;
}

/** The sub-topics that are no good, left out, and why. Overlapping names are kept. */
function checkSubs(placing: Placing, areas: readonly Area[]): string[] {
  const problems: string[] = [];
  const byArea = new Map<string, Set<string>>();
  for (const [id, sub] of placing.subOf) {
    const area = placing.areaOf.get(id) ?? OTHER.id;
    byArea.set(area, (byArea.get(area) ?? new Set()).add(sub));
  }
  const bad = new Set<string>();
  for (const [areaId, subs] of byArea) {
    const area = [...areas, OTHER].find((a) => a.id === areaId) ?? OTHER;
    for (const sub of subs) {
      const why = subProblem(
        sub,
        area,
        [...subs].filter((s) => s !== sub),
      );
      if (why === null) continue;
      problems.push(why);
      bad.add(`${areaId}|${sub}`);
    }
  }
  for (const [id, sub] of placing.subOf)
    if (bad.has(`${placing.areaOf.get(id) ?? OTHER.id}|${sub}`)) placing.subOf.delete(id);
  return problems;
}

/**
 * The model's placing of `items` under `areas`, or why it is none. An unknown
 * area, or an item the answer left out, goes to "Other"; a left-out item and a
 * bad sub-topic are also reasons to ask again (a bad sub-topic is dropped).
 */
export function parsePlacing(text: string, items: readonly Item[], areas: readonly Area[]): Placed {
  const parsed = Answer.safeParse(jsonIn(text));
  if (!parsed.success) {
    const where = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") || "the answer");
    return {
      placing: null,
      problems: [`the answer was not the JSON asked for (see ${where.join(", ")})`],
    };
  }
  const byShort = new Map(items.map((item, i) => [`i${i + 1}`, item.id]));
  const placing: Placing = { areaOf: new Map(), subOf: new Map(), related: [] };
  for (const entry of parsed.data.items) {
    const id = byShort.get(entry.id.trim().toLowerCase());
    if (id === undefined) continue;
    placing.areaOf.set(id, areaNamed(areas, entry.area)?.id ?? OTHER.id);
    const sub = shorten(entry.sub, SUB_CHARS);
    if (sub !== "") placing.subOf.set(id, sub);
  }
  const problems: string[] = [];
  const missing = [...byShort].filter(([, id]) => !placing.areaOf.has(id)).map(([s]) => s);
  if (missing.length > 0) problems.push(`items without an area: ${missing.join(", ")}`);
  for (const [, id] of byShort) if (!placing.areaOf.has(id)) placing.areaOf.set(id, OTHER.id);
  placing.related = parsed.data.related.flatMap(({ a, b, label }) => {
    const x = byShort.get(a.trim().toLowerCase());
    const y = byShort.get(b.trim().toLowerCase());
    return x === undefined || y === undefined || x === y
      ? []
      : [{ a: x, b: y, label: shorten(label, 14) }];
  });
  problems.push(...checkSubs(placing, areas));
  return { placing, problems };
}
