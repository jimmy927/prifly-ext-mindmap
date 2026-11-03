/**
 * Grouping and naming: what the model is sent for all the items at once, the
 * JSON Schema it is asked to follow, and how its answer is read (zod). The call
 * is kept small so the fast tier answers inside its 60 s: it sends short ids
 * and only what grouping needs, and asks for no summary lines (those are asked
 * for in batches, see `lines.ts`). Nothing is grouped without the model.
 */

import { z } from "zod";
import { fold, SERVICES } from "./entities";
import type { LlmRequest } from "./llm";
import type { Item } from "./types";

/** A summary line's length, in characters: about what fits under a circle's title. */
export const LINE_CHARS = 22;
/** The most topics on a map. */
export const MAX_TOPICS = 9;
const TITLE_CHARS = 100;
const NAME_CHARS = 40;
const BRIEF_LINES = 2;
const BRIEF_CHARS = 50;
const HEAD_CHARS = 120;
/**
 * The answer's cap, thinking included: Claude Code counts the model's thinking
 * against it, and on a cap it asks again rather than answering. For 75 items
 * this compact call took 4 turns and 54-58 s with no answer at 3,000 (Haiku
 * thought 11,500 tokens); at 32,000 it answered in 20-31 s (2026-11-03).
 */
export const MAX_TOKENS = 32_000;

/** `text` cut at a word to about `chars`, with no trailing punctuation. */
export function shorten(text: string, chars = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= chars) return flat;
  const cut = flat.slice(0, chars + 1);
  const space = cut.lastIndexOf(" ");
  const word = space >= chars * 0.6 ? cut.slice(0, space) : flat.slice(0, chars);
  return `${word.replace(/[\s,.;:-]+$/, "")}…`;
}

/** `text` on one line, hard-cut to `chars`: for what goes into a prompt. */
export function clip(text: string, chars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, chars);
}

/** What the grouping call is told of one item, under the id `id`: only what grouping needs. */
export function promptItem(item: Item, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id,
    kind: item.kind === "conversation" ? "chat or mail" : item.kind,
    title: clip(item.title, TITLE_CHARS),
  };
  // A card's repo is always "Trello", which its kind already says; a chat's name is often its title.
  if (item.kind !== "card") out["repo"] = clip(item.repo, NAME_CHARS);
  if (item.brief.length > 0)
    out["brief"] = item.brief.slice(0, BRIEF_LINES).map((line) => clip(line, BRIEF_CHARS));
  if (item.kind === "conversation") {
    if (item.name !== undefined && item.name !== item.title)
      out["name"] = clip(item.name, NAME_CHARS);
    if (item.subject !== undefined) out["subject"] = clip(item.subject, NAME_CHARS);
    if (item.head !== undefined) out["last"] = clip(item.head, HEAD_CHARS);
  }
  return out;
}

const SYSTEM = [
  "You group a person's coding sessions, chats, mails and Trello cards into the topics of a mind map, and name them.",
  "Answer with one JSON object and nothing else, in the shape of the schema:",
  '{"topics":[{"id":"t1","name":"2-3 words","sub":"3-5 words"}],"items":[{"id":"i1","topic":"t1"}],"related":[{"a":"i1","b":"i2","label":"1-2 words"}]}',
  `topics: 6 to ${MAX_TOPICS} of them when there are enough items (fewer for a few), each with at least one item. A topic is what the items are about (a product, a customer, a person, a chore), whatever service they came from: a session, the chat and the mail about the same person sit together.`,
  "topic name: never a tool or service such as WhatsApp, Gmail or Trello.",
  'No catch-all names: never "Mixed", "Misc", "Other", "General", "Personal and Work", "Various", "Activity" or an "X and Y" pairing of two unrelated things. Name what the items have in common.',
  'Every topic name must be distinct: it must not share its main word with any other topic\'s name (not "Prifly and ODI" next to "Prifly Project").',
  "items: every item once, with the id of its topic. Give no summary lines: they are asked for separately.",
  'related: up to 20 pairs of items about the same thing, across kinds and services first, each with a label of 1-2 words naming what the two share. "sharedEntities" are pairs found by matching names, repositories and ticket ids: label them as given or better, and add others you see.',
  '"previousTopics" are the topics of the last map, with their members. So the map stays stable: keep a previous topic\'s id, name and sub for the items that still belong together, and give a new topic an id that is not used there.',
].join("\n");

/** A pair of items by full id, with what they share. */
export type Pair = { a: string; b: string; label: string };
/** A topic of the last map: its id, name and sub, and its members by full id. */
export type PreviousTopic = { id: string; name: string; sub: string; members: string[] };
/** What goes to the model besides the items; none of it groups anything by itself. */
export type Hints = { shared: Pair[]; previous: PreviousTopic[] };

/** The model's name for an item in the prompt: "i1", "i2", ... in order. */
export function shortIds(items: readonly Item[]): Map<string, string> {
  return new Map(items.map((item, i) => [item.id, `i${i + 1}`]));
}

const Topic = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  sub: z.string(),
});
const Entry = z.object({ id: z.string(), topic: z.string() });
const Related = z.object({ a: z.string(), b: z.string(), label: z.string() });
const Answer = z.object({
  topics: z.array(Topic),
  items: z.array(Entry),
  related: z.array(Related),
});

/** The JSON Schema the answer must follow, made from the zod schema that reads it. */
export const ANSWER_SCHEMA: Record<string, unknown> = Object.fromEntries(
  Object.entries(z.toJSONSchema(Answer)).filter(([key]) => key !== "$schema"),
);

/** The request that asks the fast tier to group and name `items`. */
export function groupingRequest(items: readonly Item[], hints: Hints): LlmRequest {
  const short = shortIds(items);
  const idOf = (id: string) => short.get(id);
  const pairs = hints.shared.flatMap(({ a, b, label }) => {
    const x = idOf(a);
    const y = idOf(b);
    return x === undefined || y === undefined ? [] : [{ a: x, b: y, label }];
  });
  const previous = hints.previous.map((topic) => ({
    ...topic,
    members: topic.members.flatMap((id) => idOf(id) ?? []),
  }));
  const payload = {
    items: items.map((item) => promptItem(item, idOf(item.id) ?? item.id)),
    sharedEntities: pairs,
    previousTopics: previous,
  };
  return {
    tier: "fast",
    system: SYSTEM,
    prompt: JSON.stringify(payload),
    schema: ANSWER_SCHEMA,
    maxTokens: MAX_TOKENS,
  };
}

/** The same request, with the answer that was not accepted and why. */
export function retryRequest(
  request: LlmRequest,
  answer: string,
  reasons: readonly string[],
): LlmRequest {
  return {
    ...request,
    prompt: `${request.prompt}\n\nYour answer was:\n${answer}\n\nNot accepted: ${reasons.join("; ")}. Answer again with the same JSON, fixing only that.`,
  };
}

/** What a valid answer gives, by full item id. */
export type Grouping = {
  topics: { id: string; name: string; sub: string }[];
  /** Item id → topic id. */
  topicOf: Map<string, string>;
  related: Pair[];
};

/** The first JSON object in `text`: the whole text, or inside a ```json fence, or between the outer braces. */
export function jsonIn(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)?.[1];
  const body = fenced ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type Parsed = { grouping: Grouping | null; problems: string[] };

const unusable = (problems: string[]): Parsed => ({ grouping: null, problems });

/** Why the answer does not give every item a declared topic; empty when it does. */
function shapeProblems(
  answer: z.infer<typeof Answer>,
  topicIds: ReadonlySet<string>,
  shortOf: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  if (topicIds.size !== answer.topics.length) problems.push("two topics share an id");
  if (topicIds.size > MAX_TOPICS) problems.push(`there are more than ${MAX_TOPICS} topics`);
  const seen = new Map<string, string>();
  for (const entry of answer.items) {
    const id = entry.id.trim().toLowerCase();
    if (!shortOf.has(id)) continue;
    if (!topicIds.has(entry.topic))
      problems.push(`item ${id} is in "${entry.topic}", which is not in topics`);
    else seen.set(id, entry.topic);
  }
  const missing = [...shortOf.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) problems.push(`items without a topic: ${missing.join(", ")}`);
  const service = answer.topics.find((topic) => SERVICES.includes(fold(topic.name)));
  if (service !== undefined) problems.push(`"${service.name}" is a service, not a topic`);
  return problems;
}

/**
 * The model's answer for `items`, or why it is no valid answer: not JSON, not
 * the shape, an item without a declared topic, too many topics, a topic
 * that is only a service's name. A topic left with no item is dropped.
 */
export function parseGrouping(text: string, items: readonly Item[]): Parsed {
  const parsed = Answer.safeParse(jsonIn(text));
  if (!parsed.success) {
    const where = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") || "the answer");
    return unusable([`the answer was not the JSON asked for (see ${where.join(", ")})`]);
  }
  const answer = parsed.data;
  const byShort = new Map(items.map((item, i) => [`i${i + 1}`, item.id]));
  const topicIds = new Set(answer.topics.map((topic) => topic.id));
  const problems = shapeProblems(answer, topicIds, byShort);
  if (problems.length > 0) return unusable(problems);
  const topicOf = new Map<string, string>();
  for (const entry of answer.items) {
    const id = byShort.get(entry.id.trim().toLowerCase());
    if (id !== undefined) topicOf.set(id, entry.topic);
  }
  const used = new Set(topicOf.values());
  const related = answer.related.flatMap(({ a, b, label }) => {
    const x = byShort.get(a.trim().toLowerCase());
    const y = byShort.get(b.trim().toLowerCase());
    return x === undefined || y === undefined || x === y
      ? []
      : [{ a: x, b: y, label: shorten(label, 14) }];
  });
  const topics = answer.topics
    .filter((topic) => used.has(topic.id))
    .map((topic) => ({ id: topic.id, name: shorten(topic.name, 18), sub: shorten(topic.sub, 26) }));
  return { grouping: { topics, topicOf, related }, problems: [] };
}
