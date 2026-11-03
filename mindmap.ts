/**
 * The map's state between requests: the sessions (read at most every 15 s),
 * the sources, the model's grouping and naming, and the last layout — kept so
 * circles do not jump and the layout is worked out again only when what it
 * shows changed.
 *
 * Nothing is grouped or named without the model prifly lends (`api.llm`, the
 * fast tier). A map is "good" only when the model's answer is for the items
 * now; the last good map is kept in `api.state`. Until there is one, `view`
 * answers with why there is none; after one, a failing call leaves the last
 * good map on screen with the reason.
 *
 * Nothing runs on a timer: the page asks every few seconds while it is
 * visible, and each ask starts whatever is due in the background (the grouping
 * at most once a minute, and at most one batch of summary lines per ask; the
 * map is drawn as soon as the grouping has answered, its lines follow). A
 * closed map reads nothing.
 */

import { createHash } from "node:crypto";
import type { ExtensionApi } from "@prifly/extension-api";
import { type Answered, Grouper } from "./grouping";
import type { Point } from "./layout";
import { AskLimits } from "./limits";
import { Liner } from "./liner";
import { knownLinks, relatedLinks } from "./links";
import { askOf, type Failure, modelLine } from "./llm";
import { sessionItems } from "./sessions";
import { Sources } from "./sources";
import { type Picked, pick, relatedOf } from "./topics";
import { type FactSession, type Item, readToolOf, type Sorting } from "./types";
import { buildView, type MapView } from "./view";

export const SESSIONS_EVERY_MS = 15_000;
const MAP_STATE = "map";
/** What earlier versions kept, which nothing reads now. */
const OLD_STATE = ["embeddings", "names", "topics"];
const SAVE_MAP_EVERY_MS = 60_000;
const HOUR = 3_600_000;

export type MindMapDeps = { sources?: Sources };

/**
 * What `api/map` answers:
 * - "map": a good map. With `current` false it is the last good one, shown
 *   because the data has moved on and no call has made a new one yet; `error`
 *   says why, when a call failed. `updatedAt` is when it was last good (epoch ms).
 * - "error": there has been no good map, and why.
 * - "waiting": no good map yet and nothing has failed; the first call is on its way.
 */
export type MapAnswer =
  | { state: "map"; map: MapView; updatedAt: number; current: boolean; error: Failure | null }
  | { state: "error"; error: Failure }
  | { state: "waiting" };

type SavedMap = { view: MapView; at: number };

export class MindMap {
  private sessions: Item[] = [];
  private sessionsAt = Number.NEGATIVE_INFINITY;
  readonly sources: Sources;
  readonly grouper: Grouper;
  readonly liner: Liner;
  private picked: { key: string; picked: Picked } | null = null;
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
    const limits = new AskLimits();
    const log = (event: string, fields: Record<string, string | number | boolean | null>) =>
      api.log(event, fields);
    this.grouper = new Grouper({ ask: () => askOf(api), state: api.state, limits, log });
    this.liner = new Liner({ ask: () => askOf(api), state: api.state, limits, log });
  }

  async load(): Promise<void> {
    const state = this.api.state;
    await Promise.all([this.grouper.load(), this.liner.load()]);
    for (const name of OLD_STATE) void state?.delete(name).catch(() => undefined);
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

  /** The items drawn and the hints that go with them, worked out again only when the items, their texts or the hour changed. */
  private pick(now: number): Picked {
    const others = this.sources.items();
    const key = createHash("sha1")
      .update(
        JSON.stringify([
          [...this.sessions, ...others].map((item) => [
            item.id,
            item.title,
            item.brief,
            item.name,
            item.subject,
            item.head,
            item.last ?? 0,
            item.repo,
            item.status,
          ]),
          Math.floor(now / HOUR),
        ]),
      )
      .digest("hex");
    if (this.picked?.key === key) return this.picked.picked;
    const picked = pick({ sessions: this.sessions, others, now });
    this.picked = { key, picked };
    return picked;
  }

  /** What `api/map` answers now; starts the reads and the call that are due. */
  view(now: number): MapAnswer {
    this.readSessions(now);
    this.pending = this.refresh(now);
    const map = this.currentMap(now);
    if (map !== null) {
      this.keep(map, now);
      return { state: "map", map, updatedAt: now, current: true, error: null };
    }
    const error = this.grouper.error();
    if (this.good !== null)
      return { state: "map", map: this.good.view, updatedAt: this.good.at, current: false, error };
    return error === null ? { state: "waiting" } : { state: "error", error };
  }

  /** The reads, then (when the items changed) the grouping call, then one batch of summary lines when some are due. */
  private refresh(now: number): Promise<void> {
    return this.sources
      .refresh(now)
      .then(async () => {
        const picked = this.pick(now);
        await this.grouper.update(picked, now);
        // Lines only for a map that is drawn: no use asking for them without the grouping.
        if (this.grouper.answerFor(picked.items) !== null)
          await this.liner.update(picked.items, now);
      })
      .catch((error: unknown) => {
        this.api.log("refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Wait for the reads and the call the last `view` started (for tests). */
  settle(): Promise<void> {
    return this.pending;
  }

  /** The map for the items now, or null while the model has not grouped them. */
  private currentMap(now: number): MapView | null {
    const picked = this.pick(now);
    const answered = this.grouper.answerFor(picked.items);
    return answered === null ? null : this.render(picked, answered);
  }

  /** Remember a good map as the last one; in `api.state` when it changed, else at most once a minute. */
  private keep(view: MapView, now: number): void {
    this.good = { view, at: now };
    const key = this.last?.key;
    if (key === this.saved.key && now - this.saved.at < SAVE_MAP_EVERY_MS) return;
    this.saved = { key, at: now };
    void this.api.state?.set(MAP_STATE, this.good).catch(() => undefined);
  }

  private sortingOf(picked: Picked, answered: Answered): Sorting {
    return {
      themes: answered.topics,
      themeOf: answered.topicOf,
      lines: this.liner.linesOf(picked.items),
      related: relatedOf(picked, answered.related),
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

  private render(picked: Picked, answered: Answered): MapView {
    const items = picked.items;
    const sorting = this.sortingOf(picked, answered);
    const known = knownLinks(items);
    const links = [...known, ...relatedLinks(items, sorting, known)];
    const footer = {
      model: answered.model === "" ? "" : modelLine(answered.model, answered.backend),
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
