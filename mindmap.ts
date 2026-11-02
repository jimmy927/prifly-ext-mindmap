/**
 * The map's state between requests: the sessions (read at most every 15 s),
 * the sources, the embeddings, the topics and their names, and the last
 * layout — kept so circles do not jump and the layout is worked out again
 * only when what it shows changed.
 *
 * Nothing is grouped or named without DeepInfra. A map is "good" only when the
 * embeddings and the names exist for the items now; the last good map is kept
 * in `api.state`. Until there is one, `view` answers with why there is none;
 * after one, a failing call leaves the last good map on screen with the error.
 *
 * Nothing runs on a timer: the page asks every few seconds while it is
 * visible, and each ask starts whatever is due in the background (DeepInfra
 * at most once a minute). A closed map reads nothing.
 */

import { createHash } from "node:crypto";
import type { ExtensionApi } from "@prifly/extension-api";
import type { Failure } from "./deepinfra";
import { deepInfraEmbed, type Embed, Embedder, embedText, textHash } from "./embed";
import type { Point } from "./layout";
import { knownLinks, relatedLinks } from "./links";
import { type Chat, deepInfraChat, Namer } from "./model";
import { sessionItems } from "./sessions";
import { Sources } from "./sources";
import { type Worked, workOut } from "./topics";
import { type FactSession, type Item, readToolOf, type Sorting } from "./types";
import { buildView, type MapView } from "./view";

export const SESSIONS_EVERY_MS = 15_000;
const VAULT_NAMES = ["deepinfra", "deepinfra-api"];
const TOPICS_STATE = "topics";
const MAP_STATE = "map";
const SAVE_MAP_EVERY_MS = 60_000;
const HOUR = 3_600_000;

export type MindMapDeps = { chat?: Chat; embed?: Embed; sources?: Sources };

/**
 * What `api/map` answers:
 * - "map": a good map. With `current` false it is the last good one, shown
 *   because the data has moved on and no call has made a new one yet; `error`
 *   says why, when a call failed. `updatedAt` is when it was last good (epoch ms).
 * - "error": there has been no good map, and why.
 * - "waiting": no good map yet and nothing has failed; the first calls are on their way.
 */
export type MapAnswer =
  | { state: "map"; map: MapView; updatedAt: number; current: boolean; error: Failure | null }
  | { state: "error"; error: Failure }
  | { state: "waiting" };

/** The DeepInfra key from the vault: the entry "deepinfra", else "deepinfra-api". */
async function vaultKey(api: ExtensionApi): Promise<string | null> {
  for (const name of VAULT_NAMES) {
    const key = await api.vault?.read(name).catch(() => null);
    if (typeof key === "string" && key.trim() !== "") return key.trim();
  }
  return null;
}

function shortModel(model: string): string {
  return model.split("/").at(-1) ?? model;
}

type SavedTopics = { topicOf: Record<string, string>; nextId: number };
type SavedMap = { view: MapView; at: number };

export class MindMap {
  private sessions: Item[] = [];
  private sessionsAt = Number.NEGATIVE_INFINITY;
  readonly sources: Sources;
  readonly embedder: Embedder;
  readonly namer: Namer;
  private seeds = new Map<string, string>();
  private nextId = 1;
  private worked: { key: string; worked: Worked } | null = null;
  private positions = new Map<string, Point>();
  private themes = new Map<string, string>();
  private order: string[] = [];
  private colours = new Map<string, string>();
  private last: { key: string; view: MapView } | null = null;
  private good: SavedMap | null = null;
  private saved: { key: string | undefined; at: number } = {
    key: undefined,
    at: Number.NEGATIVE_INFINITY,
  };
  private pending: Promise<void> = Promise.resolve();
  private readonly api: ExtensionApi;

  constructor(api: ExtensionApi, deps: MindMapDeps = {}) {
    this.api = api;
    this.sources = deps.sources ?? new Sources(readToolOf(api));
    const common = {
      key: () => vaultKey(api),
      state: api.state,
      log: (event: string, fields: Record<string, string | number | boolean | null>) =>
        api.log(event, fields),
    };
    this.embedder = new Embedder({ ...common, embed: deps.embed ?? deepInfraEmbed });
    this.namer = new Namer({ ...common, chat: deps.chat ?? deepInfraChat });
  }

  async load(): Promise<void> {
    await Promise.all([this.embedder.load(), this.namer.load()]);
    const state = this.api.state;
    const saved = await state?.get<SavedTopics>(TOPICS_STATE).catch(() => undefined);
    if (saved?.topicOf !== undefined && typeof saved.nextId === "number") {
      this.seeds = new Map(Object.entries(saved.topicOf));
      this.nextId = saved.nextId;
    }
    const map = await state?.get<SavedMap>(MAP_STATE).catch(() => undefined);
    if (map !== undefined && Array.isArray(map.view?.nodes) && typeof map.at === "number") {
      this.good = map;
      this.remember(
        map.view,
        map.view.themes.map((theme) => theme.id),
      );
    }
  }

  private readSessions(now: number): void {
    if (now - this.sessionsAt < SESSIONS_EVERY_MS) return;
    this.sessionsAt = now;
    this.sessions = sessionItems(this.api.sessions() as FactSession[], now);
  }

  /** Every item there is: sessions, and every conversation and card the listings gave. */
  private pool(): Item[] {
    return [...this.sessions, ...this.sources.items()];
  }

  /** The topics, worked out again only when the items, their texts or the vectors changed. */
  private work(now: number): Worked {
    const pool = this.pool();
    const key = createHash("sha1")
      .update(
        JSON.stringify([
          pool.map((item) => [item.id, textHash(embedText(item)), item.last ?? 0, item.repo]),
          this.embedder.version,
          Math.floor(now / HOUR),
        ]),
      )
      .digest("hex");
    if (this.worked?.key === key) return this.worked.worked;
    const worked = workOut({
      sessions: this.sessions,
      others: this.sources.items(),
      vectorOf: (item) => this.embedder.vectorOf(item),
      previous: this.seeds,
      nextId: this.nextId,
      now,
    });
    this.worked = { key, worked };
    this.seeds = worked.topicOf;
    this.nextId = worked.nextId;
    const saved: SavedTopics = { topicOf: Object.fromEntries(worked.topicOf), nextId: this.nextId };
    void this.api.state?.set(TOPICS_STATE, saved).catch(() => undefined);
    return worked;
  }

  /** What `api/map` answers now; starts the reads, the embedding and the naming that are due. */
  view(now: number): MapAnswer {
    this.readSessions(now);
    this.pending = this.refresh(now);
    const map = this.currentMap(now);
    if (map !== null) {
      this.keep(map, now);
      return { state: "map", map, updatedAt: now, current: true, error: null };
    }
    const error = this.embedder.error() ?? this.namer.error();
    if (this.good !== null)
      return { state: "map", map: this.good.view, updatedAt: this.good.at, current: false, error };
    return error === null ? { state: "waiting" } : { state: "error", error };
  }

  /** The reads, then the embedding, then (only with every vector) the naming. */
  private refresh(now: number): Promise<void> {
    return this.sources
      .refresh(now)
      .then(() => this.embedder.update(this.pool(), now))
      .then(() => {
        if (!this.embedder.complete(this.pool())) return;
        const fresh = this.work(now);
        return this.namer.update(fresh.topics, fresh.entities, now);
      })
      .catch((error: unknown) => {
        this.api.log("refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Wait for the reads and the calls the last `view` started (for tests). */
  settle(): Promise<void> {
    return this.pending;
  }

  /** The map for the items now, or null while any embedding or name is missing. */
  private currentMap(now: number): MapView | null {
    if (!this.embedder.complete(this.pool())) return null;
    const worked = this.work(now);
    if (!this.namer.ready(worked.topics)) return null;
    return this.render(worked.items, this.sortingOf(worked));
  }

  /** Remember a good map as the last one; in `api.state` when it changed, else at most once a minute. */
  private keep(view: MapView, now: number): void {
    this.good = { view, at: now };
    const key = this.last?.key;
    if (key === this.saved.key && now - this.saved.at < SAVE_MAP_EVERY_MS) return;
    this.saved = { key, at: now };
    void this.api.state?.set(MAP_STATE, this.good).catch(() => undefined);
  }

  private sortingOf(worked: Worked): Sorting {
    return {
      themes: worked.topics.flatMap((topic) => this.namer.themeOf(topic) ?? []),
      themeOf: Object.fromEntries(worked.topicOf),
      lines: Object.fromEntries(worked.items.map((item) => [item.id, this.namer.linesOf(item)])),
      related: worked.related.map(({ a, b, label }) => ({
        a,
        b,
        label: label ?? this.namer.labelOf(a, b) ?? "similar",
      })),
    };
  }

  /** Keep a map's places, themes and colours, so the next layout moves from them. */
  private remember(view: MapView, order: string[]): void {
    this.order = order;
    this.colours = new Map(view.themes.map((theme) => [theme.id, theme.color]));
    this.themes = new Map(view.nodes.map((node) => [node.id, node.theme]));
    this.positions = new Map(
      [...view.nodes, ...view.themes].map((node) => [node.id, { x: node.x, y: node.y }]),
    );
  }

  private render(items: Item[], sorting: Sorting): MapView {
    const known = knownLinks(items);
    const links = [...known, ...relatedLinks(items, sorting, known)];
    const footer = {
      model: `Names by ${shortModel(this.namer.model)} · similarity by ${shortModel(this.embedder.model)}`,
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
      previousTheme: this.themes,
      previousOrder: this.order,
      colours: this.colours,
      footer,
    });
    this.remember(built.view, built.order);
    this.colours = built.colours;
    this.last = { key, view: built.view };
    return built.view;
  }
}
