/**
 * Naming a topic: what the model is sent for one cluster, how its answer is
 * read (zod), and the name without it — the entity most members share, or
 * the repository — with summaries from brief lines.
 */

import { z } from "zod";
import { commonEntity, type Entity, fold } from "./entities";
import type { Item, Theme } from "./types";

/** A summary line's length, in characters: about what fits under a circle's title. */
export const LINE_CHARS = 22;
const SERVICES = new Set([
  "whatsapp",
  "gmail",
  "outlook",
  "telegram",
  "instagram",
  "linkedin",
  "messenger",
  "trello",
]);

/** `text` cut at a word to about `chars`, with no trailing punctuation. */
export function shorten(text: string, chars = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= chars) return flat;
  const cut = flat.slice(0, chars + 1);
  const space = cut.lastIndexOf(" ");
  const word = space >= chars * 0.6 ? cut.slice(0, space) : flat.slice(0, chars);
  return `${word.replace(/[\s,.;:-]+$/, "")}…`;
}

/** Two lines for an item without the model: its brief's first two, a conversation's subject and head, or none. */
export function fallbackLines(item: Item): string[] {
  if (item.brief.length > 0) return item.brief.slice(0, 2).map((line) => shorten(line));
  const lines = [item.subject, item.head].filter(
    (line): line is string => line !== undefined && line !== "",
  );
  return lines.slice(0, 2).map((line) => shorten(line));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "2 sessions, 3 chats": what a topic holds. */
export function countsOf(members: readonly Item[]): string {
  const sessions = members.filter((m) => m.kind === "session").length;
  const conversations = members.filter((m) => m.kind === "conversation").length;
  const cards = members.filter((m) => m.kind === "card").length;
  const parts = [
    sessions > 0 ? plural(sessions, "session") : "",
    conversations > 0 ? plural(conversations, "chat") : "",
    cards > 0 ? plural(cards, "card") : "",
  ].filter((part) => part !== "");
  return shorten(parts.join(", "), 26);
}

/** A topic's theme without the model: named by the entity most members share, else its repository, else "Other". */
export function fallbackTheme(
  id: string,
  members: readonly Item[],
  entities: ReadonlyMap<string, readonly Entity[]>,
): Theme {
  const name = commonEntity(members, entities) ?? "Other";
  return { id, name: shorten(name, 18), sub: countsOf(members) };
}

/** What the namer is told of one member. */
function promptItem(item: Item, short: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: short,
    kind: item.kind === "conversation" ? "chat or mail" : item.kind,
    title: item.title,
  };
  if (item.kind === "session" && item.repo !== "") out["repo"] = item.repo;
  if (item.brief.length > 0) out["brief"] = item.brief.slice(0, 4);
  if (item.subject !== undefined) out["subject"] = item.subject;
  if (item.head !== undefined) out["last"] = item.head.slice(0, 160);
  return out;
}

const SYSTEM = [
  "You name one theme of a person's mind map: a group of their coding sessions, chats, mails and Trello cards that belong together.",
  "Answer with one JSON object and nothing else:",
  '{"name":"2-3 words","sub":"3-5 words","items":[{"id":"i1","lines":["<=22 chars","<=22 chars"]}],"pairs":[{"a":"i1","b":"i2","label":"1-2 words"}]}',
  "name: what the items are about (a product, a customer, a person, a chore). Never a tool or service such as WhatsApp, Gmail or Trello.",
  "items: every item once, with two summary lines of at most 22 characters each, saying what it is doing or needs.",
  "pairs: for each pair you are given, 1-2 words naming what the two items share.",
  'When "keep" is given, answer with that name and sub.',
].join("\n");

export type NamePrompt = { role: string; content: string }[];

/** The chat messages naming one topic. `pairs` are full item ids to label. */
export function namePrompt(
  members: readonly Item[],
  shared: readonly string[],
  pairs: readonly (readonly [string, string])[],
  keep: Theme | null,
): NamePrompt {
  const shortOf = new Map(members.map((m, i) => [m.id, `i${i + 1}`]));
  const payload: Record<string, unknown> = {
    shared,
    items: members.map((m) => promptItem(m, shortOf.get(m.id) ?? m.id)),
    pairs: pairs.flatMap(([a, b]) => {
      const x = shortOf.get(a);
      const y = shortOf.get(b);
      return x === undefined || y === undefined ? [] : [[x, y]];
    }),
  };
  if (keep !== null) payload["keep"] = { name: keep.name, sub: keep.sub };
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** A garbled key the model sometimes writes for "name" ("name la") is read as "name". */
function withName(value: unknown): unknown {
  if (typeof value !== "object" || value === null || "name" in value) return value;
  const record = value as Record<string, unknown>;
  const key = Object.keys(record).find((k) => /^name\b/i.test(k.trim()));
  return key === undefined ? value : { ...record, name: record[key] };
}

const NameSchema = z.object({
  name: z.string().trim().min(1),
  sub: z.string().catch(""),
  items: z
    .array(z.object({ id: z.coerce.string(), lines: z.array(z.string()).catch([]) }))
    .catch([]),
  pairs: z
    .array(
      z.object({ a: z.coerce.string(), b: z.coerce.string(), label: z.string().catch("related") }),
    )
    .catch([]),
});

/** What a namer's answer gives: the theme's name and sub, lines by item id, labels by pair. */
export type Naming = {
  name: string;
  sub: string;
  lines: Map<string, string[]>;
  labels: { a: string; b: string; label: string }[];
};

/** The first JSON object in `text`: the whole text, or inside a ```json fence, or between the outer braces. */
function jsonIn(text: string): unknown {
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

/**
 * The namer's answer, or null when it is no valid answer: not JSON, not the
 * shape, or a name that is only a service's.
 */
export function parseNaming(text: string, members: readonly Item[]): Naming | null {
  const parsed = NameSchema.safeParse(withName(jsonIn(text)));
  if (!parsed.success) return null;
  const answer = parsed.data;
  if (SERVICES.has(fold(answer.name))) return null;
  const byShort = new Map(members.map((m, i) => [`i${i + 1}`, m.id]));
  const lines = new Map<string, string[]>();
  for (const entry of answer.items) {
    const id = byShort.get(entry.id.trim().toLowerCase());
    if (id === undefined) continue;
    const kept = entry.lines.filter((line) => line.trim() !== "").slice(0, 2);
    lines.set(
      id,
      kept.map((line) => shorten(line)),
    );
  }
  const labels = answer.pairs.flatMap(({ a, b, label }) => {
    const x = byShort.get(a.trim().toLowerCase());
    const y = byShort.get(b.trim().toLowerCase());
    return x === undefined || y === undefined || x === y
      ? []
      : [{ a: x, b: y, label: shorten(label, 14) }];
  });
  return { name: shorten(answer.name, 18), sub: shorten(answer.sub, 26), lines, labels };
}
