/**
 * Sorting items into themes: what the model is sent, how its answer is read
 * (zod), and the sorting without it — one theme per repository, conversations
 * under their service, cards under "Trello", summaries from brief lines.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Item, Sorting, Theme } from "./types";

export const MAX_THEMES = 9;
/** A summary line's length, in characters: about what fits under a circle's title. */
export const LINE_CHARS = 22;

/** What decides whether the model is asked again: titles, brief lines and conversation heads. */
export function fingerprint(items: readonly Item[]): string {
  const parts = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) =>
      [item.id, item.title, item.brief.join("\n"), item.subject ?? "", item.head ?? ""].join(
        "\u0001",
      ),
    );
  return createHash("sha1").update(parts.join("\u0002")).digest("hex");
}

/** `text` cut at a word to about `chars`, with no trailing punctuation. */
export function shorten(text: string, chars = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= chars) return flat;
  const cut = flat.slice(0, chars + 1);
  const space = cut.lastIndexOf(" ");
  const word = space >= chars * 0.6 ? cut.slice(0, space) : flat.slice(0, chars);
  return `${word.replace(/[\s,.;:-]+$/, "")}…`;
}

/** Short ids for the prompt: a session's first 8 characters, c1.. for conversations, k1.. for cards. */
export function shortIds(items: readonly Item[]): Map<string, string> {
  const ids = new Map<string, string>();
  let c = 0;
  let k = 0;
  const prefixes = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "session") continue;
    const prefix = item.id.slice(0, 8).toLowerCase();
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  for (const item of items) {
    if (item.kind === "session") {
      // Two sessions sharing a start are sent by their whole ids, so neither takes the other's answer.
      const prefix = item.id.slice(0, 8);
      ids.set(item.id, prefixes.get(prefix.toLowerCase()) === 1 ? prefix : item.id);
    } else if (item.kind === "conversation") ids.set(item.id, `c${++c}`);
    else ids.set(item.id, `k${++k}`);
  }
  return ids;
}

function promptItem(item: Item, short: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: short,
    kind: item.kind,
    title: item.title,
    repo: item.repo,
  };
  if (item.brief.length > 0) out["brief"] = item.brief.slice(0, 6);
  if (item.kind === "conversation") {
    if (item.name !== undefined) out["name"] = item.name;
    if (item.subject !== undefined) out["subject"] = item.subject;
    if (item.head !== undefined) out["last"] = item.head.slice(0, 200);
  }
  return out;
}

const SYSTEM = [
  "You sort a person's work into a mind map. Items are coding sessions, conversations (chats and mails) and Trello cards.",
  "Answer with one JSON object and nothing else:",
  '{"themes":[{"id":"t1","name":"2-3 words","sub":"3-5 words"}],',
  ' "items":[{"id":"<item id>","theme":"<theme id>","lines":["<=22 chars","<=22 chars"]}],',
  ' "related":[{"a":"<item id>","b":"<item id>","label":"1-2 words"}]}',
  "Rules: 6 to 9 themes, by what the work is about (a product, a customer, a person, a chore), not by tool.",
  "Every item gets exactly one theme and two summary lines of at most 22 characters each, saying what it is doing or needs.",
  "related: pairs of items about the same thing, especially a session and the conversation or card it is about. At most 20. Labels of 1-2 words.",
  "Keep the previous themes' ids and names where they still fit, so the map stays stable.",
].join("\n");

/** The chat messages for the model. */
export function promptOf(
  items: readonly Item[],
  previous: readonly Theme[],
): { role: string; content: string }[] {
  const ids = shortIds(items);
  const payload = {
    previousThemes: previous.map(({ id, name, sub }) => ({ id, name, sub })),
    items: items.map((item) => promptItem(item, ids.get(item.id) ?? item.id)),
  };
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

const AnswerSchema = z.object({
  themes: z
    .array(
      z.object({
        id: z.coerce.string().min(1),
        name: z.string().min(1),
        sub: z.string().catch(""),
      }),
    )
    .min(1),
  items: z.array(
    z.object({
      id: z.coerce.string().min(1),
      theme: z.coerce.string().min(1),
      lines: z.array(z.string()).catch([]),
    }),
  ),
  related: z
    .array(
      z.object({ a: z.coerce.string(), b: z.coerce.string(), label: z.string().catch("related") }),
    )
    .catch([]),
});

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
 * The model's answer as a sorting, or null when it is no valid answer: not
 * JSON, not the shape, or fewer than half the items given a known theme.
 */
export function parseAnswer(text: string, items: readonly Item[], model: string): Sorting | null {
  const parsed = AnswerSchema.safeParse(jsonIn(text));
  if (!parsed.success) return null;
  const answer = parsed.data;
  const byShort = new Map([...shortIds(items)].map(([full, short]) => [short.toLowerCase(), full]));
  const themes = dedupeThemes(answer.themes).slice(0, MAX_THEMES);
  const themeIds = new Set(themes.map((theme) => theme.id));
  const sorting: Sorting = { themes, themeOf: {}, lines: {}, related: [], by: `model ${model}` };
  for (const entry of answer.items) {
    const id = byShort.get(entry.id.toLowerCase());
    if (id === undefined || !themeIds.has(entry.theme)) continue;
    sorting.themeOf[id] = entry.theme;
    sorting.lines[id] = entry.lines
      .filter((line) => line.trim() !== "")
      .slice(0, 2)
      .map((line) => shorten(line));
  }
  if (Object.keys(sorting.themeOf).length * 2 < items.length) return null;
  for (const link of answer.related.slice(0, 30)) {
    const a = byShort.get(link.a.toLowerCase());
    const b = byShort.get(link.b.toLowerCase());
    if (a !== undefined && b !== undefined && a !== b) {
      sorting.related.push({ a, b, label: shorten(link.label, 14) });
    }
  }
  return sorting;
}

function dedupeThemes(themes: readonly Theme[]): Theme[] {
  const out: Theme[] = [];
  for (const theme of themes) {
    if (out.some((kept) => kept.id === theme.id)) continue;
    out.push({ id: theme.id, name: shorten(theme.name, 18), sub: shorten(theme.sub, 26) });
  }
  return out;
}

/** Two lines for an item without the model: its brief's first two, a conversation's subject and head, or none. */
export function fallbackLines(item: Item): string[] {
  if (item.brief.length > 0) return item.brief.slice(0, 2).map((line) => shorten(line));
  const lines = [item.subject, item.head].filter(
    (line): line is string => line !== undefined && line !== "",
  );
  return lines.slice(0, 2).map((line) => shorten(line));
}

const OTHER: Theme = { id: "other", name: "Other", sub: "" };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A repository's (or service's) theme: "prifly", "3 sessions". */
function repoTheme(repo: string, members: readonly Item[]): Theme {
  const sessions = members.filter((m) => m.kind === "session").length;
  const word = members[0]?.kind === "card" ? "card" : "conversation";
  const sub = sessions > 0 ? plural(sessions, "session") : plural(members.length, word);
  return { id: `r:${repo}`, name: shorten(repo, 18), sub };
}

/** One theme per repository (conversations under their service, cards under "Trello"), at most `MAX_THEMES`. */
export function fallbackSorting(items: readonly Item[]): Sorting {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.repo === "" ? "Other" : item.repo;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ranked = [...groups].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const kept = ranked.length > MAX_THEMES ? ranked.slice(0, MAX_THEMES - 1) : ranked;
  const sorting: Sorting = { themes: [], themeOf: {}, lines: {}, related: [], by: "fallback" };
  for (const [repo, members] of kept) {
    const theme = repoTheme(repo, members);
    sorting.themes.push(theme);
    for (const member of members) sorting.themeOf[member.id] = theme.id;
  }
  const rest = ranked.slice(kept.length).flatMap(([, members]) => members);
  if (rest.length > 0) {
    sorting.themes.push({ ...OTHER, sub: plural(rest.length, "item") });
    for (const member of rest) sorting.themeOf[member.id] = OTHER.id;
  }
  for (const item of items) sorting.lines[item.id] = fallbackLines(item);
  return sorting;
}

/**
 * The model's sorting carried over to items it has not seen yet: a new item
 * joins the theme most of its repository's items are in, else "Other", with
 * fallback lines. Items gone from the map are dropped from it.
 */
export function completeSorting(sorting: Sorting, items: readonly Item[]): Sorting {
  const themeOf: Record<string, string> = {};
  const lines: Record<string, string[]> = {};
  const byRepo = new Map<string, Map<string, number>>();
  for (const item of items) {
    const theme = sorting.themeOf[item.id];
    if (theme === undefined) continue;
    const counts = byRepo.get(item.repo) ?? new Map<string, number>();
    counts.set(theme, (counts.get(theme) ?? 0) + 1);
    byRepo.set(item.repo, counts);
  }
  let other = false;
  for (const item of items) {
    const known = sorting.themeOf[item.id];
    const counts = [...(byRepo.get(item.repo) ?? new Map<string, number>())].sort(
      (a, b) => b[1] - a[1],
    );
    const theme = known ?? counts[0]?.[0] ?? OTHER.id;
    if (theme === OTHER.id && !sorting.themes.some((t) => t.id === OTHER.id)) other = true;
    themeOf[item.id] = theme;
    const given = sorting.lines[item.id];
    lines[item.id] = given !== undefined && given.length > 0 ? given : fallbackLines(item);
  }
  const used = new Set(Object.values(themeOf));
  const themes = [...sorting.themes, ...(other ? [OTHER] : [])].filter((theme) =>
    used.has(theme.id),
  );
  return { themes, themeOf, lines, related: sorting.related, by: sorting.by };
}
