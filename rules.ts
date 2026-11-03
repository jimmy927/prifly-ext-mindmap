/**
 * What a good naming is, checked in code after the answer is parsed: a theme
 * name that is no catch-all and shares no main word with another theme's
 * name, and summary lines that say more than their item's title. A bad theme
 * name is sent back once with its reason (see `grouping.ts`); a bad line is
 * left out (see `liner.ts`).
 */

import type { Grouping } from "./sorting";

/** Lower case, no accents, letters and digits only, single spaces: for comparing words, not for showing. */
export function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const CATCH_ALL_WORDS = new Set(
  [
    "mixed",
    "misc",
    "miscellaneous",
    "other",
    "others",
    "general",
    "various",
    "activity",
    "activities",
    "diverse",
    "blandat",
    "övrigt",
    "allmänt",
  ].map(normalise),
);
const CATCH_ALL_PHRASES = ["personal and work", "work and personal", "personal and business"];

/** Words that name no subject: they never make two themes overlap. */
const FILLER = new Set(
  [
    "and",
    "the",
    "for",
    "with",
    "och",
    "med",
    "project",
    "projects",
    "work",
    "chat",
    "chats",
    "mail",
    "mails",
    "email",
    "emails",
    "task",
    "tasks",
    "issue",
    "issues",
    "support",
    "team",
  ].map(normalise),
);

/** Lines that say nothing about the item. */
const GENERIC_LINES = ["person contact", "contact person", "message from", "messages from"];

export type NameProblem = { kind: "catch-all" | "overlap"; text: string };

/** The subject words of a theme name: three letters or more, no filler. */
function mainWords(name: string): string[] {
  return normalise(name)
    .split(" ")
    .filter((word) => word.length >= 3 && !FILLER.has(word));
}

/** Why `name` is no good beside the `others` themes' names, or null when it is. */
export function nameProblem(name: string, others: readonly string[]): NameProblem | null {
  const flat = normalise(name);
  const word = flat.split(" ").find((w) => CATCH_ALL_WORDS.has(w));
  const phrase = CATCH_ALL_PHRASES.find((p) => flat.includes(p));
  if (word !== undefined || phrase !== undefined)
    return {
      kind: "catch-all",
      text: `the name "${name}" is a catch-all; name what the members have in common`,
    };
  const mine = mainWords(name);
  for (const other of others) {
    const shared = mainWords(other).find((w) => mine.includes(w));
    if (shared !== undefined)
      return {
        kind: "overlap",
        text: `the name "${name}" shares "${shared}" with the other theme "${other}"; pick a name that is distinct`,
      };
  }
  return null;
}

/** Why a summary line is no good under `title`, or null when it is. */
export function lineProblem(line: string, title: string): string | null {
  const flat = normalise(line);
  if (flat === "" || normalise(title).includes(flat))
    return `the line "${line}" repeats or shortens the title "${title}"; say what the item is doing, needs, or is about`;
  if (GENERIC_LINES.some((generic) => flat.startsWith(generic)))
    return `the line "${line}" is generic; say what the item is doing, needs, or is about`;
  return null;
}

export type Review = {
  /** The topics whose name is no good, by topic id. */
  names: Map<string, NameProblem>;
};

/**
 * A grouping checked: each topic's name beside the others' (except the
 * `fixed` topics, which keep an earlier name).
 */
export function review(grouping: Grouping, fixed: ReadonlySet<string>): Review {
  const names = new Map<string, NameProblem>();
  for (const topic of grouping.topics) {
    if (fixed.has(topic.id)) continue;
    const others = grouping.topics.filter((t) => t.id !== topic.id).map((t) => t.name);
    const problem = nameProblem(topic.name, others);
    if (problem !== null) names.set(topic.id, problem);
  }
  return { names };
}

/** The lines of one item that pass `lineProblem` under its `title`; the rest are left out. */
export function goodLines(lines: readonly string[], title: string): string[] {
  return lines.filter((line) => lineProblem(line, title) === null);
}

const MAX_REASONS = 12;

/** Every reason a review found, for the retry message. */
export function reasons(checked: Review): string[] {
  const all = [...checked.names.values()].map((p) => p.text);
  return all.length <= MAX_REASONS
    ? all
    : [...all.slice(0, MAX_REASONS), `and ${all.length - MAX_REASONS} more like these`];
}
