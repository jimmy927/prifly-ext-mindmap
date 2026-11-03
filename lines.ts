/**
 * The summary lines, asked for apart from the grouping so each call is small:
 * a batch of up to `BATCH` items, each with what its lines are made from, and
 * the two short lines per item back. An item's lines are made again only when
 * its fingerprint (title, brief lines, conversation head) changed.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmRequest } from "./llm";
import { goodLines } from "./rules";
import { clip, jsonIn, LINE_CHARS, shorten } from "./sorting";
import type { Item } from "./types";

/** The most items in one call. */
export const BATCH = 20;
const MAX_TOKENS = 2500;
const TITLE_CHARS = 100;
const BRIEF_LINES = 4;
const BRIEF_CHARS = 100;
const HEAD_CHARS = 200;

/** What a batch is told of one item, under the id `id`. */
function linesItem(item: Item, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id,
    kind: item.kind === "conversation" ? "chat or mail" : item.kind,
    title: clip(item.title, TITLE_CHARS),
  };
  if (item.brief.length > 0)
    out["brief"] = item.brief.slice(0, BRIEF_LINES).map((line) => clip(line, BRIEF_CHARS));
  if (item.kind === "conversation") {
    if (item.name !== undefined) out["name"] = clip(item.name, 40);
    if (item.subject !== undefined) out["subject"] = clip(item.subject, 60);
    if (item.head !== undefined) out["last"] = clip(item.head, HEAD_CHARS);
  }
  return out;
}

/** What the lines of `item` depend on: when it changes, its lines are made again. */
export function lineFingerprint(item: Item): string {
  return createHash("sha1")
    .update(JSON.stringify(linesItem(item, "")))
    .digest("hex");
}

const SYSTEM = [
  "You write the two short summary lines under each circle of a mind map of a person's coding sessions, chats, mails and Trello cards.",
  "Answer with one JSON object and nothing else, in the shape of the schema:",
  `{"items":[{"id":"i1","lines":["<=${LINE_CHARS} chars","<=${LINE_CHARS} chars"]}]}`,
  `items: every item once, with two summary lines of at most ${LINE_CHARS} characters each, saying what it is doing, needs, or is about.`,
  'A summary line must not repeat or merely shorten the item\'s title, and must not say a generic thing such as "Person contact" or "Message from".',
].join("\n");

const Answer = z.object({
  items: z.array(z.object({ id: z.string(), lines: z.array(z.string()) })),
});

/** The JSON Schema of a batch's answer, made from the zod schema that reads it. */
export const LINES_SCHEMA: Record<string, unknown> = Object.fromEntries(
  Object.entries(z.toJSONSchema(Answer)).filter(([key]) => key !== "$schema"),
);

/** The request that asks the fast tier for the lines of `items` (at most `BATCH`), named i1, i2, ... */
export function linesRequest(items: readonly Item[]): LlmRequest {
  return {
    tier: "fast",
    system: SYSTEM,
    prompt: JSON.stringify({ items: items.map((item, i) => linesItem(item, `i${i + 1}`)) }),
    schema: LINES_SCHEMA,
    maxTokens: MAX_TOKENS,
  };
}

/**
 * The lines the answer gives, by full item id: at most two, cut to fit, and
 * none that repeat the item's title. An item the answer leaves out gets none.
 * Null when the answer is no JSON of the shape asked for.
 */
export function parseLines(text: string, items: readonly Item[]): Map<string, string[]> | null {
  const parsed = Answer.safeParse(jsonIn(text));
  if (!parsed.success) return null;
  const byShort = new Map(items.map((item, i) => [`i${i + 1}`, item]));
  const out = new Map<string, string[]>(items.map((item) => [item.id, []]));
  for (const entry of parsed.data.items) {
    const item = byShort.get(entry.id.trim().toLowerCase());
    if (item === undefined) continue;
    const kept = entry.lines.filter((line) => line.trim() !== "").slice(0, 2);
    out.set(
      item.id,
      goodLines(
        kept.map((line) => shorten(line)),
        item.title,
      ),
    );
  }
  return out;
}
