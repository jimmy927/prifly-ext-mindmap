/**
 * What the map is made of: items (sessions, conversations, cards), themes and
 * links — and the parts of prifly's extension API this extension uses before
 * `@prifly/extension-api` has them ("session-facts", "read-tools").
 */

import type { ExtensionApi, ExtensionSession } from "@prifly/extension-api";

/** A session's brief, as prifly's "session-facts" feature gives it (read tolerantly all the same). */
export type Brief = {
  done: string[];
  next: string[];
  blocked: string[];
  blockedOnYou: string[];
};

/**
 * The optional fields prifly adds to a session behind the feature
 * "session-facts" (prifly branch prifly-541). Each may be absent: the map then
 * has no summary lines from them and no solid links.
 */
export type SessionFacts = {
  brief?: Brief;
  repo?: string;
  branch?: string;
  /** Sessions this one waits on, by their first 8 characters. */
  waitsOn?: string[];
  asksYou?: boolean;
  /** An ISO time. */
  snoozedUntil?: string;
  /** The full id of the session that started this one. */
  parentId?: string;
};

export type FactSession = ExtensionSession & SessionFacts;

/** What `api.tools.read` answers. */
export type ReadResult = { ok: true; text: string } | { ok: false; error: string };

/** Another extension's tool, read-only: its text, or a throw with why it failed. */
export type ReadTool = (name: string, args: Record<string, unknown>) => Promise<string>;

type ToolsWithRead = NonNullable<ExtensionApi["tools"]> & {
  read?: (name: string, args: Record<string, unknown>) => Promise<ReadResult>;
};

/** The answer's text; a failed read throws its error. A bare string is taken as the text. */
export function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "ok" in result) {
    const answer = result as { ok: unknown; text?: unknown; error?: unknown };
    if (answer.ok === true && typeof answer.text === "string") return answer.text;
    throw new Error(typeof answer.error === "string" ? answer.error : "the read failed");
  }
  throw new Error("the read gave no text");
}

/**
 * `api.tools.read` where this prifly has it (feature "read-tools"), else null:
 * sessions only. It reads only the tools the manifest's `reads` names.
 */
export function readToolOf(api: ExtensionApi): ReadTool | null {
  if (!(api.features ?? []).includes("read-tools")) return null;
  const tools = api.tools as ToolsWithRead | undefined;
  const read = tools?.read;
  if (tools === undefined || typeof read !== "function") return null;
  return async (name, args) => textOf(await read.call(tools, name, args));
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
