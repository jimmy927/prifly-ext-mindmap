/**
 * The map's state between requests: the sessions (read at most every 15 s),
 * the sources, the model, and the last layout — kept so circles do not jump
 * and the layout is worked out again only when what it shows changed.
 *
 * Nothing runs on a timer: the page asks every few seconds while it is
 * visible, and each ask starts whatever is due in the background. A closed
 * map reads nothing.
 */

import { createHash } from "node:crypto";
import type { ExtensionApi } from "@prifly/extension-api";
import type { Point } from "./layout";
import { knownLinks, relatedLinks } from "./links";
import { type Chat, deepInfraChat, Sorter } from "./model";
import { sessionItems } from "./sessions";
import { keepCards, keepConversations, RECENT_MS, Sources } from "./sources";
import { type FactSession, type Item, readToolOf, type Sorting } from "./types";
import { buildView, type MapView } from "./view";

export const SESSIONS_EVERY_MS = 15_000;
/** At most this many conversations go to the model to be linked. */
const MODEL_CONVERSATIONS = 30;
const VAULT_NAMES = ["deepinfra", "deepinfra-api"];

export type MindMapDeps = { chat?: Chat; sources?: Sources };

/** The DeepInfra key from the vault: the entry "deepinfra", else "deepinfra-api". */
async function vaultKey(api: ExtensionApi): Promise<string | null> {
  for (const name of VAULT_NAMES) {
    const key = await api.vault?.read(name).catch(() => null);
    if (typeof key === "string" && key.trim() !== "") return key.trim();
  }
  return null;
}

export class MindMap {
  private sessions: Item[] = [];
  private sessionsAt = Number.NEGATIVE_INFINITY;
  readonly sources: Sources;
  readonly sorter: Sorter;
  private positions = new Map<string, Point>();
  private order: string[] = [];
  private colours = new Map<string, string>();
  private last: { key: string; view: MapView } | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly api: ExtensionApi;

  constructor(api: ExtensionApi, deps: MindMapDeps = {}) {
    this.api = api;
    this.sources = deps.sources ?? new Sources(readToolOf(api));
    this.sorter = new Sorter({
      key: () => vaultKey(api),
      chat: deps.chat ?? deepInfraChat,
      state: api.state,
      log: (event, fields) => api.log(event, fields),
    });
  }

  async load(): Promise<void> {
    await this.sorter.load();
  }

  private readSessions(now: number): void {
    if (now - this.sessionsAt < SESSIONS_EVERY_MS) return;
    this.sessionsAt = now;
    this.sessions = sessionItems(this.api.sessions() as FactSession[], now);
  }

  /** Conversations a session was about last time, by the model's related links. */
  private linkedIds(sorting: Sorting | null): Set<string> {
    const ids = new Set<string>();
    for (const link of sorting?.related ?? []) {
      ids.add(link.a);
      ids.add(link.b);
    }
    return ids;
  }

  /** Sessions, conversations (linked before, or recent) and cards: what the model is sent. */
  private candidates(now: number, linked: ReadonlySet<string>): Item[] {
    const all = this.sources.items();
    const conversations = all
      .filter((item) => item.kind === "conversation")
      .filter((item) => linked.has(item.id) || (item.last !== undefined && now - item.last <= RECENT_MS))
      .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || (b.last ?? 0) - (a.last ?? 0))
      .slice(0, MODEL_CONVERSATIONS);
    return [...this.sessions, ...conversations, ...keepCards(all)];
  }

  /** What the map shows now; starts the reads and the model call that are due. */
  view(now: number): MapView {
    this.readSessions(now);
    const before = this.linkedIds(this.sorter.sortingFor(this.sessions));
    const candidates = this.candidates(now, before);
    this.pending = Promise.all([this.sources.refresh(now), this.sorter.update(candidates, now)]).then(() => undefined);
    const sorting = this.sorter.sortingFor(candidates);
    const linked = this.linkedIds(sorting);
    const items = [
      ...this.sessions,
      ...keepConversations(candidates, linked, now),
      ...candidates.filter((item) => item.kind === "card"),
    ];
    return this.render(items, this.sorter.sortingFor(items));
  }

  /** Wait for the reads and the model call the last `view` started (for tests). */
  settle(): Promise<void> {
    return this.pending;
  }

  private render(items: Item[], sorting: Sorting): MapView {
    const known = knownLinks(items);
    const links = [...known, ...relatedLinks(items, sorting, known)];
    const footer = {
      model: this.sorter.statusLine(),
      skipped: this.sources.skipped(),
      sessions: items.filter((item) => item.kind === "session").length,
      conversations: items.filter((item) => item.kind === "conversation").length,
      cards: items.filter((item) => item.kind === "card").length,
    };
    const key = createHash("sha1").update(JSON.stringify({ items, sorting, links })).digest("hex");
    if (this.last?.key === key) return { ...this.last.view, footer };
    const built = buildView({
      items,
      sorting,
      links,
      previous: this.positions,
      previousOrder: this.order,
      colours: this.colours,
      footer,
    });
    this.order = built.order;
    this.colours = built.colours;
    this.positions = new Map([...built.view.nodes, ...built.view.themes].map((n) => [n.id, { x: n.x, y: n.y }]));
    this.last = { key, view: built.view };
    return built.view;
  }
}
