/**
 * Conversations and cards, read from other extensions' listing tools through
 * `api.tools.read`: one listing call per source, never a loop over threads,
 * nothing marked read. A missing or failing source is skipped and named.
 */

import { type Entry, parseListing } from "./parse";
import type { Item, ReadTool } from "./types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A conversation is kept when a session is about it, or its last message is this recent. */
export const RECENT_MS = 3 * DAY;
export const MAX_CONVERSATIONS = 20;
export const MAX_CARDS = 15;

export type Source = {
  tool: string;
  /** The service's name, which the fallback themes by. */
  service: string;
  kind: "conversation" | "card";
  everyMs: number;
  args: (now: number) => Record<string, unknown>;
  /** A pipe table's columns when it has no header. */
  columns?: string[];
};

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export const SOURCES: readonly Source[] = [
  {
    tool: "whatsapp_chats",
    service: "WhatsApp",
    kind: "conversation",
    everyMs: 5 * MINUTE,
    args: () => ({ limit: 30 }),
  },
  {
    tool: "gmail_search",
    service: "Gmail",
    kind: "conversation",
    everyMs: 5 * MINUTE,
    args: () => ({ query: "newer_than:3d", max: 30 }),
    columns: ["thread_id", "messages", "date", "from", "subject"],
  },
  {
    tool: "outlook_search",
    service: "Outlook",
    kind: "conversation",
    everyMs: 5 * MINUTE,
    args: (now) => ({ query: `received>=${isoDay(now - RECENT_MS)}`, max: 30 }),
  },
  {
    tool: "telegram_chats",
    service: "Telegram",
    kind: "conversation",
    everyMs: 5 * MINUTE,
    args: () => ({ limit: 30 }),
  },
  { tool: "trello_cards", service: "Trello", kind: "card", everyMs: 5 * MINUTE, args: () => ({}) },
  // Driven through the reader's browser: read less often.
  {
    tool: "instagram_inbox",
    service: "Instagram",
    kind: "conversation",
    everyMs: 15 * MINUTE,
    args: () => ({}),
  },
  {
    tool: "linkedin_my_conversations",
    service: "LinkedIn",
    kind: "conversation",
    everyMs: 15 * MINUTE,
    args: () => ({}),
  },
  {
    tool: "messenger_threads",
    service: "Messenger",
    kind: "conversation",
    everyMs: 15 * MINUTE,
    args: () => ({}),
  },
];

/** What a source last gave: its items, when it was read, and why it failed if it did. */
type Read = { at: number; items: Item[]; error: string | null };

function itemOf(source: Source, entry: Entry): Item {
  const item: Item = {
    id: source.kind === "card" ? `k:${entry.key}` : `c:${source.tool}:${entry.key}`,
    kind: source.kind,
    title: entry.name,
    repo: source.service,
    brief: [],
    status: "idle",
    source: source.tool,
  };
  if (source.kind === "conversation") item.name = entry.name;
  if (entry.subject !== undefined) item.subject = entry.subject;
  if (entry.head !== undefined) item.head = entry.head;
  if (entry.last !== undefined) item.last = entry.last;
  if (entry.url !== undefined) item.url = entry.url;
  if (entry.sessionId !== undefined) item.sessionId = entry.sessionId;
  return item;
}

/** One source's answer as items. A throw is the source failing. */
export async function readSource(read: ReadTool, source: Source, now: number): Promise<Item[]> {
  const raw = await read(source.tool, source.args(now));
  return parseListing(raw, source.columns).map((entry) => itemOf(source, entry));
}

/** Reads each source when it is due, one call each, and keeps what it last gave. */
export class Sources {
  private readonly reads = new Map<string, Read>();
  private readonly busy = new Set<string>();

  private readonly read: ReadTool | null;
  private readonly sources: readonly Source[];

  constructor(read: ReadTool | null, sources: readonly Source[] = SOURCES) {
    this.read = read;
    this.sources = sources;
  }

  /** Start the reads that are due; resolves when they are done (callers need not wait). */
  refresh(now: number): Promise<void> {
    const read = this.read;
    if (read === null) return Promise.resolve();
    const due = this.sources.filter((source) => {
      const last = this.reads.get(source.tool);
      return !this.busy.has(source.tool) && (last === undefined || now - last.at >= source.everyMs);
    });
    return Promise.all(due.map((source) => this.one(read, source, now))).then(() => undefined);
  }

  private async one(read: ReadTool, source: Source, now: number): Promise<void> {
    this.busy.add(source.tool);
    try {
      const items = await readSource(read, source, now);
      this.reads.set(source.tool, { at: now, items, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reads.set(source.tool, { at: now, items: [], error: message });
    } finally {
      this.busy.delete(source.tool);
    }
  }

  /** Everything the sources last gave. */
  items(): Item[] {
    return [...this.reads.values()].flatMap((read) => read.items);
  }

  /** The services that could not be read, for the footer: "Instagram (not installed)". */
  skipped(): string[] {
    if (this.read === null) return [];
    return this.sources.flatMap((source) => {
      const error = this.reads.get(source.tool)?.error;
      return error === undefined || error === null
        ? []
        : [`${source.service} (${shortReason(error)})`];
    });
  }
}

function shortReason(message: string): string {
  if (/not (?:found|installed|listed|in .*reads)|unknown tool|no such tool/i.test(message))
    return "not installed";
  const line = message.split("\n")[0] ?? message;
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/**
 * The conversations worth a circle: those a session is about (`linked`)
 * first, then any with a message in the last three days, newest first; at
 * most `MAX_CONVERSATIONS`.
 */
export function keepConversations(
  items: readonly Item[],
  linked: ReadonlySet<string>,
  now: number,
): Item[] {
  const conversations = items.filter((item) => item.kind === "conversation");
  const newest = (a: Item, b: Item) => (b.last ?? 0) - (a.last ?? 0);
  const withLink = conversations.filter((item) => linked.has(item.id)).sort(newest);
  const recent = conversations
    .filter(
      (item) => !linked.has(item.id) && item.last !== undefined && now - item.last <= RECENT_MS,
    )
    .sort(newest);
  return [...withLink, ...recent].slice(0, MAX_CONVERSATIONS);
}

/** The cards worth a circle: those with a session first, at most `MAX_CARDS`. */
export function keepCards(items: readonly Item[]): Item[] {
  const cards = items.filter((item) => item.kind === "card");
  const ticketed = cards.filter((card) => card.sessionId !== undefined);
  const rest = cards.filter((card) => card.sessionId === undefined);
  return [...ticketed, ...rest].slice(0, MAX_CARDS);
}
