/**
 * What the map is made of: items (sessions, conversations, cards), themes and
 * links — and the parts of prifly's extension API this extension uses before
 * `@prifly/extension-api` has them ("session-facts", "read-tools").
 */

import type { ExtensionApi, ExtensionSession } from "@prifly/extension-api";

/** A session's brief, as prifly's "session-facts" feature gives it. */
export type Brief = {
  done?: string[];
  next?: string[];
  blocked?: string[];
  blockedOnYou?: string[];
};

/**
 * The optional fields prifly adds to a session behind the feature
 * "session-facts". Each may be absent: the map then has no summary lines from
 * them and no solid links.
 */
export type SessionFacts = {
  brief?: Brief;
  repo?: string;
  branch?: string;
  /** Sessions this one waits on, by their first 8 characters. */
  waitsOn?: string[];
  asksYou?: boolean;
  /** Epoch ms or an ISO time. */
  snoozedUntil?: number | string | null;
  /** The session that started this one. */
  parentId?: string | null;
};

export type FactSession = ExtensionSession & SessionFacts;

/** `api.tools.read`, behind the feature "read-tools": another extension's tool, read-only. */
export type ReadTool = (name: string, args: Record<string, unknown>) => Promise<string>;

/** `api.tools.read` where this prifly has it, else null: sessions only. */
export function readToolOf(api: ExtensionApi): ReadTool | null {
  if (!(api.features ?? []).includes("read-tools")) return null;
  const tools = api.tools as (ExtensionApi["tools"] & { read?: unknown }) | undefined;
  const read = tools?.read;
  if (typeof read !== "function") return null;
  return (name, args) => Promise.resolve(read.call(tools, name, args)).then(String);
}

export type ItemKind = "session" | "conversation" | "card";

export type Status = "running" | "waiting" | "error" | "idle";

/** One circle of the map, before it has a theme or a place. */
export type Item = {
  /** A session's full id; "c:<source>:<key>" for a conversation; "k:<key>" for a card. */
  id: string;
  kind: ItemKind;
  title: string;
  /** The repository a session works in; for a conversation, its service's name; "Trello" for a card. */
  repo: string;
  /** Brief lines, most pressing first: blocked on you, blocked, next, done. */
  brief: string[];
  status: Status;
  /** The source a conversation or card came from: "whatsapp_chats". */
  source?: string;
  /** For a conversation: who it is with, its subject, and the start of its last message. */
  name?: string;
  subject?: string;
  head?: string;
  /** When its last message was, epoch ms. */
  last?: number;
  /** What a click opens: a card's or a conversation's link. */
  url?: string;
  /** The session a card is the ticket of. */
  sessionId?: string;
  /** A session's own solid links. */
  parentId?: string;
  waitsOn?: string[];
};

export type Theme = { id: string; name: string; sub: string };

/** What the model (or the fallback) made of the items. */
export type Sorting = {
  themes: Theme[];
  /** Item id → theme id. */
  themeOf: Record<string, string>;
  /** Item id → two short summary lines. */
  lines: Record<string, string[]>;
  related: { a: string; b: string; label: string }[];
  /** "model <name>" or "fallback". */
  by: string;
};

export type LinkKind = "started" | "waits on" | "ticket" | "related";

export type Link = { a: string; b: string; kind: LinkKind; label: string };
