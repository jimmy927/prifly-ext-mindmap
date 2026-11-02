/**
 * The map's state between requests: the sessions (read at most every 15 s),
 * the sources, the embeddings, the topics and their names, and the last
 * layout — kept so circles do not jump and the layout is worked out again
 * only when what it shows changed.
 *
 * Nothing runs on a timer: the page asks every few seconds while it is
 * visible, and each ask starts whatever is due in the background. A closed
 * map reads nothing.
 */

import { createHash } from "node:crypto";
import type { ExtensionApi } from "@prifly/extension-api";
import { deepInfraEmbed, type Embed, Embedder, embedText, textHash } from "./embed";
import type { Point } from "./layout";
import { knownLinks, relatedLinks } from "./links";
import { type Chat, deepInfraChat, type ModelStatus, Namer } from "./model";
import { sessionItems } from "./sessions";
import { Sources } from "./sources";
import { type Worked, workOut } from "./topics";
import { type FactSession, type Item, readToolOf, type Sorting } from "./types";
import { buildView, type MapView } from "./view";

export const SESSIONS_EVERY_MS = 15_000;
const VAULT_NAMES = ["deepinfra", "deepinfra-api"];
const TOPICS_STATE = "topics";
const HOUR = 3_600_000;

export type MindMapDeps = { chat?: Chat; embed?: Embed; sources?: Sources };

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

/** The footer's word on how the themes were made, and what is missing. */
export function statusLine(
  naming: ModelStatus,
  similarity: ReturnType<Embedder["state"]>,
  models: { chat: string; embed: string },
): string {
  if (naming === "no key" || similarity === "no key")
    return "No DeepInfra key in the vault: topics by shared names and repositories, no similarity";
  const names =
    naming === "model"
      ? `Names by ${shortModel(models.chat)}`
      : naming === "failed"
        ? "Naming failed: names from shared entities"
        : "Names from shared entities until the model answers";
  const similar =
    similarity === "ok"
      ? `similarity by ${shortModel(models.embed)}`
      : similarity === "failed"
        ? "similarity failed: topics by shared names"
        : "similarity pending";
  return `${names} · ${similar}`;
}

type SavedTopics = { topicOf: Record<string, string>; nextId: number };

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
    const saved = await this.api.state?.get<SavedTopics>(TOPICS_STATE).catch(() => undefined);
    if (saved?.topicOf !== undefined && typeof saved.nextId === "number") {
      this.seeds = new Map(Object.entries(saved.topicOf));
      this.nextId = saved.nextId;
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

  /** What the map shows now; starts the reads, the embedding and the naming that are due. */
  view(now: number): MapView {
    this.readSessions(now);
    const worked = this.work(now);
    this.pending = this.sources
      .refresh(now)
      .then(() => this.embedder.update(this.pool(), now))
      .then(() => {
        const fresh = this.work(now);
        return this.namer.update(fresh.topics, fresh.entities, now);
      });
    return this.render(worked.items, this.sortingOf(worked));
  }

  /** Wait for the reads and the calls the last `view` started (for tests). */
  settle(): Promise<void> {
    return this.pending;
  }

  private sortingOf(worked: Worked): Sorting {
    const sorting: Sorting = {
      themes: worked.topics.map((topic) => this.namer.themeOf(topic, worked.entities)),
      themeOf: Object.fromEntries(worked.topicOf),
      lines: Object.fromEntries(worked.items.map((item) => [item.id, this.namer.linesOf(item)])),
      related: worked.related.map(({ a, b, label }) => ({
        a,
        b,
        label: label ?? this.namer.labelOf(a, b) ?? "similar",
      })),
      by: this.namer.state() === "model" ? `model ${this.namer.model}` : "entities",
    };
    return sorting;
  }

  private render(items: Item[], sorting: Sorting): MapView {
    const known = knownLinks(items);
    const links = [...known, ...relatedLinks(items, sorting, known)];
    const footer = {
      model: statusLine(this.namer.state(), this.embedder.state(), {
        chat: this.namer.model,
        embed: this.embedder.model,
      }),
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
    this.order = built.order;
    this.colours = built.colours;
    this.themes = new Map(built.view.nodes.map((n) => [n.id, n.theme]));
    this.positions = new Map(
      [...built.view.nodes, ...built.view.themes].map((n) => [n.id, { x: n.x, y: n.y }]),
    );
    this.last = { key, view: built.view };
    return built.view;
  }
}
