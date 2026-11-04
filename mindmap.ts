/**
 * The map's state between requests: the sessions (read at most every 15 s),
 * the sources, the model's grouping and naming, and the last layout — kept so
 * circles do not jump and the layout is worked out again only when what it
 * shows changed.
 *
 * Nothing is grouped or named without the model prifly lends (`api.llm`, the
 * fast tier). A map is "good" only when the model's answer is for the items
 * now; the last good map is kept in `api.state`. Until there is one, `view`
 * answers with why there is none; after one, a failing call leaves the map
 * on screen with the reason. The grouping stands while only status, briefs or
 * last messages change (it depends on the set of ids and titles), and an item
 * the answer does not know yet is left off until it does. With no answer at
 * all, the saved map is shown without any item no longer on the map.
 *
 * Nothing runs on a timer: the page asks every few seconds while it is
 * visible, and each ask starts whatever is due in the background (the grouping
 * at most once a minute, and at most one batch of summary lines per ask; the
 * map is drawn as soon as the grouping has answered, its lines follow). A
 * closed map reads nothing.
 *
 * With the reader's areas (the "Areas" setting), the themes are the areas and
 * the model only places items under them; a changed setting regroups at once.
 * The reader's own moves ("Move to theme…", `api/move`) are kept in
 * `api.state` and always win over the model's placing.
 */

import { createHash } from "node:crypto";
import type { ExtensionApi } from "@prifly/extension-api";
import { type Area, areasIn, areasOf, OTHER, SETTINGS_FEATURE } from "./areas";
import { type Answered, Grouper } from "./grouping";
import type { Point } from "./layout";
import { AskLimits } from "./limits";
import { Liner } from "./liner";
import { knownLinks, relatedLinks } from "./links";
import { askOf, type Failure, modelLine } from "./llm";
import { appLinkOf, linkOf, menuFor, openerOf, openRequest, opensApps } from "./opening";
import { Placements } from "./placements";
import { sessionItems } from "./sessions";
import { Sources } from "./sources";
import { type Picked, pick, relatedOf } from "./topics";
import { type FactSession, type Item, type Link, readToolOf, type Sorting } from "./types";
import { buildView, type MapView, restrictView } from "./view";

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

const SUB_CHARS = 40;

/** What `api/move` is sent: an item and where the reader puts it, or `reset` to give it back to the model. */
export type MoveRequest = { id: string; area: string; sub: string } | { id: string; reset: true };

export function moveRequest(body: unknown): MoveRequest {
  const given = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const { id, area, sub, reset } = given;
  if (typeof id !== "string" || id === "") throw new Error("Say which item to move.");
  if (reset === true) return { id, reset: true };
  if (typeof area !== "string" || area === "") throw new Error("Say which theme to move it to.");
  if (sub !== undefined && typeof sub !== "string") throw new Error("A sub-topic is a text.");
  return { id, area, sub: (sub ?? "").replace(/\s+/g, " ").trim().slice(0, SUB_CHARS) };
}

/** `picked` with only `items`, and the pairs and entities of those. */
function narrow(picked: Picked, items: Item[]): Picked {
  const ids = new Set(items.map((item) => item.id));
  return {
    items,
    entities: new Map([...picked.entities].filter(([id]) => ids.has(id))),
    shared: picked.shared.filter((pair) => ids.has(pair.a) && ids.has(pair.b)),
  };
}

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
  /** The items and links of the map last drawn: what `open` looks links up in. */
  private drawn: { items: Item[]; links: Link[] } | null = null;
  private good: SavedMap | null = null;
  private saved: { key: string | undefined; at: number } = {
    key: undefined,
    at: Number.NEGATIVE_INFINITY,
  };
  private pending: Promise<void> = Promise.resolve();
  private readonly api: ExtensionApi;
  /** The reader's areas; none: the model's own themes, as before there were areas. */
  private areas: Area[];
  readonly placements: Placements;

  constructor(api: ExtensionApi, deps: MindMapDeps = {}) {
    this.api = api;
    this.sources = deps.sources ?? new Sources(readToolOf(api));
    this.areas = areasOf(api);
    this.placements = new Placements(api.state);
    const limits = new AskLimits();
    const log = (event: string, fields: Record<string, string | number | boolean | null>) =>
      api.log(event, fields);
    this.grouper = new Grouper({
      ask: () => askOf(api),
      state: api.state,
      limits,
      log,
      areas: () => this.areas,
      examples: () => this.placements.examples(this.areas),
    });
    this.liner = new Liner({ ask: () => askOf(api), state: api.state, limits, log });
    if ((api.features ?? []).includes(SETTINGS_FEATURE))
      api.onSettings?.((values) => this.settingsChanged(areasIn(values)));
  }

  /** The reader edited the settings: with other areas, the map is placed again at once. */
  private settingsChanged(areas: Area[]): void {
    if (JSON.stringify(areas) === JSON.stringify(this.areas)) return;
    this.areas = areas;
    this.last = null;
    this.grouper.regroup();
    if (this.picked !== null) this.pending = this.refresh(Date.now());
  }

  async load(): Promise<void> {
    const state = this.api.state;
    await Promise.all([this.grouper.load(), this.liner.load(), this.placements.load()]);
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
    const picked = this.pick(now);
    const answered = this.grouper.answerFor(picked.items);
    if (answered !== null) {
      const map = this.render(picked, answered);
      this.keep(map, now);
      return { state: "map", map, updatedAt: now, current: true, error: null };
    }
    const error = this.grouper.error();
    const at = this.good?.at ?? now;
    // The model has not grouped these items yet: draw those its last answer knows,
    // with their present state; an item it does not know joins after the answer.
    const partial = this.grouper.partialFor(picked.items);
    if (partial !== null) {
      const map = this.render(narrow(picked, partial.items), partial.answered);
      return { state: "map", map, updatedAt: at, current: false, error };
    }
    // No answer to draw from: the last saved map, less whatever is no longer on the map.
    const saved =
      this.good === null
        ? null
        : restrictView(this.good.view, new Set(picked.items.map((item) => item.id)));
    if (saved !== null) return { state: "map", map: saved, updatedAt: at, current: false, error };
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

  /**
   * `api/open`: opens the link of one of an item's menu entries in the
   * reader's browser. The page names the item and the target item; the link
   * is the target's own, and a target the item's menu does not list is refused.
   * `opened` is false when this prifly cannot open a browser or says it did not.
   */
  async open(body: unknown): Promise<{ opened: boolean }> {
    const { id, target } = openRequest(body);
    const { items, links } = this.drawn ?? this.known();
    const item = items.find((one) => one.id === id);
    if (item === undefined) throw new Error("That item is not on the map.");
    const entry = menuFor(item, items, links).find((e) => e.target === target);
    const other = items.find((one) => one.id === target);
    const url = other === undefined ? undefined : linkOf(other);
    if (entry === undefined || entry.where !== "browser" || url === undefined)
      throw new Error("That item cannot be opened there.");
    const open = openerOf(this.api);
    if (open === null) return { opened: false };
    try {
      const app = opensApps(this.api) && other !== undefined ? appLinkOf(other) : undefined;
      // The app link first; when no app is registered for it, the web link at once.
      if (app !== undefined && (await open(app)) === true) return { opened: true };
      return { opened: (await open(url)) === true };
    } catch (error) {
      this.api.log("open_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { opened: false };
    }
  }

  /**
   * `api/move`: puts an item of the map under one of the reader's areas (by
   * id) and a sub-topic ("" for none), or with `reset` gives it back to the
   * model. Kept at once; the answer is the map as `api/map` gives it, the
   * move on it.
   */
  async move(body: unknown, now: number): Promise<MapAnswer> {
    const request = moveRequest(body);
    const { items } = this.drawn ?? this.known();
    const item = items.find((one) => one.id === request.id);
    if (item === undefined) throw new Error("That item is not on the map.");
    if ("reset" in request) await this.placements.reset(item.id);
    else {
      const area = this.areas.find((one) => one.id === request.area);
      if (area === undefined) throw new Error("That is not one of your areas.");
      const placement = { area: area.name, sub: request.sub, title: item.title, at: now };
      await this.placements.set(item.id, placement);
    }
    return this.view(now);
  }

  /** The items now and the links prifly knows, before any map has been drawn. */
  private known(): { items: Item[]; links: Link[] } {
    const items = this.picked?.picked.items ?? [];
    return { items, links: knownLinks(items) };
  }

  /** Wait for the reads and the call the last `view` started (for tests). */
  settle(): Promise<void> {
    return this.pending;
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
    const sorting: Sorting = {
      themes: answered.topics,
      themeOf: answered.topicOf,
      lines: this.liner.linesOf(picked.items),
      related: relatedOf(picked, answered.related),
    };
    return answered.areas === undefined || this.areas.length === 0
      ? sorting
      : this.placed(picked.items, answered, sorting);
  }

  /** The model's placing under the reader's areas, with the reader's own moves over it. */
  private placed(items: readonly Item[], answered: Answered, sorting: Sorting): Sorting {
    const themeOf = { ...answered.topicOf };
    const subOf = { ...answered.subOf };
    const manual: string[] = [];
    for (const item of items) {
      const placement = this.placements.of(item.id, this.areas);
      if (placement === undefined) continue;
      themeOf[item.id] = placement.area.id;
      subOf[item.id] = placement.sub;
      manual.push(item.id);
    }
    const other = items.some((item) => themeOf[item.id] === OTHER.id);
    const shown = [...this.areas, ...(other ? [OTHER] : [])];
    return {
      ...sorting,
      themes: shown.map((area) => ({ id: area.id, name: area.name, sub: "" })),
      themeOf,
      subOf,
      manual,
      areaOrder: shown.map((area) => area.id),
    };
  }

  /** Keep a map's places, themes and colours, so the next layout moves from them. */
  private remember(view: MapView, order: string[]): void {
    const subs = view.subs ?? [];
    this.order = order;
    this.colours = new Map(view.themes.map((theme) => [theme.id, theme.color]));
    this.themes = new Map([
      ...view.nodes.map((node): [string, string] => [node.id, node.hub ?? node.theme]),
      ...subs.map((sub): [string, string] => [sub.id, sub.theme]),
    ]);
    this.positions = new Map(
      [...view.nodes, ...subs, ...view.themes].map((node) => [node.id, { x: node.x, y: node.y }]),
    );
  }

  private render(picked: Picked, answered: Answered): MapView {
    const items = picked.items;
    const sorting = this.sortingOf(picked, answered);
    const known = knownLinks(items);
    const links = [...known, ...relatedLinks(items, sorting, known)];
    this.drawn = { items, links };
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
