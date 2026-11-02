/**
 * The model only names: one short chat call per new or changed topic, on
 * DeepInfra's OpenAI-compatible endpoint with the key from the vault, asking
 * for the theme's name, a line under it, two summary lines per member and
 * labels for the pairs only embeddings tie. At most one round of calls a
 * minute; answers are kept in `api.state`. A topic keeps its name while its
 * members barely change. No key, a failed call or a bad answer: the topic is
 * named by the entity its members share.
 */

import type { ExtensionStateApi } from "@prifly/extension-api";
import { embedText, textHash } from "./embed";
import { type Entity, pairKey } from "./entities";
import { fallbackLines, fallbackTheme, namePrompt, parseNaming } from "./sorting";
import type { Item, Theme } from "./types";

export const MODEL = "google/gemma-4-26B-A4B-it";
export const ENDPOINT = "https://api.deepinfra.com/v1/openai/chat/completions";
export const MIN_GAP_MS = 60_000;
/** A topic keeps its name while at least this share of its members (Jaccard) is the same. */
export const KEEP_NAME = 0.5;
const TIMEOUT_MS = 60_000;
const STATE_NAME = "names";

export type Message = { role: string; content: string };
/** One chat completion's text. Throws on a failed call. */
export type Chat = (key: string, model: string, messages: Message[]) => Promise<string>;

/** DeepInfra's chat endpoint, asked for a JSON object. */
export const deepInfraChat: Chat = async (key, model, messages) => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`DeepInfra answered ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("DeepInfra's answer had no message");
  return content;
};

/** One topic as the namer sees it: its members and the pairs only similarity ties. */
export type TopicInfo = { id: string; members: Item[]; pairs: [string, string][] };

type Named = { members: string[]; name: string; sub: string };
type Saved = {
  topics: Record<string, Named>;
  lines: Record<string, { hash: string; lines: string[] }>;
  labels: Record<string, string>;
};

export type NamerDeps = {
  /** The DeepInfra key, or null when the vault has none for this extension. */
  key: () => Promise<string | null>;
  chat: Chat;
  state?: ExtensionStateApi | undefined;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  model?: string;
};

/** What the map shows of the model: whether it named, and why not. */
export type ModelStatus = "model" | "no key" | "failed" | "waiting";

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  const both = [...x].filter((id) => y.has(id)).length;
  const either = new Set([...x, ...y]).size;
  return either === 0 ? 1 : both / either;
}

function hashOf(item: Item): string {
  return textHash(embedText(item));
}

export class Namer {
  private saved: Saved = { topics: {}, lines: {}, labels: {} };
  private askedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private status: ModelStatus = "waiting";
  readonly model: string;
  private readonly deps: NamerDeps;

  constructor(deps: NamerDeps) {
    this.deps = deps;
    this.model = deps.model ?? MODEL;
  }

  /** The names kept in `api.state`, so a restart does not ask again. */
  async load(): Promise<void> {
    const saved = await this.deps.state?.get<Saved>(STATE_NAME).catch(() => undefined);
    if (saved?.topics === undefined || saved.lines === undefined) return;
    this.saved = { topics: saved.topics, lines: saved.lines, labels: saved.labels ?? {} };
    if (Object.keys(saved.topics).length > 0) this.status = "model";
  }

  /** The name a topic keeps: the model's, while its members barely changed. */
  private named(topic: TopicInfo): Named | null {
    const named = this.saved.topics[topic.id];
    const ids = topic.members.map((m) => m.id);
    return named !== undefined && jaccard(named.members, ids) >= KEEP_NAME ? named : null;
  }

  /** A topic with no name, members much changed, a member without fresh lines, or a pair without a label. */
  private isDue(topic: TopicInfo): boolean {
    const named = this.saved.topics[topic.id];
    if (named === undefined || this.named(topic) === null) return true;
    const ids = topic.members.map((m) => m.id);
    if (ids.length !== named.members.length || ids.some((id) => !named.members.includes(id)))
      return true;
    if (topic.members.some((m) => this.saved.lines[m.id]?.hash !== hashOf(m))) return true;
    return topic.pairs.some(([a, b]) => this.saved.labels[pairKey(a, b)] === undefined);
  }

  /** Whether `update` would call now: a topic is due, and a minute has passed since the last round. */
  due(topics: readonly TopicInfo[], now: number): boolean {
    return !this.busy && now - this.askedAt >= MIN_GAP_MS && topics.some((t) => this.isDue(t));
  }

  /** Name the due topics, one call each, all at once; see `due`. */
  async update(
    topics: readonly TopicInfo[],
    entities: ReadonlyMap<string, readonly Entity[]>,
    now: number,
  ): Promise<void> {
    if (!this.due(topics, now)) return;
    this.busy = true;
    this.askedAt = now;
    try {
      const key = await this.deps.key();
      if (key === null || key === "") {
        this.status = "no key";
        return;
      }
      const due = topics.filter((t) => this.isDue(t));
      const started = Date.now();
      const results = await Promise.all(due.map((t) => this.name(key, t, entities)));
      const failed = results.filter((ok) => !ok).length;
      this.status = failed > 0 ? "failed" : "model";
      this.deps.log?.("named", { topics: due.length, failed, ms: Date.now() - started });
      this.prune(topics);
      await this.deps.state?.set(STATE_NAME, this.saved).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }

  /** One topic's call. False when it failed or its answer was no valid naming. */
  private async name(
    key: string,
    topic: TopicInfo,
    entities: ReadonlyMap<string, readonly Entity[]>,
  ): Promise<boolean> {
    const kept = this.named(topic);
    const shared = fallbackTheme(topic.id, topic.members, entities).name;
    const keep = kept === null ? null : { id: topic.id, name: kept.name, sub: kept.sub };
    try {
      const text = await this.deps.chat(
        key,
        this.model,
        namePrompt(topic.members, [shared], topic.pairs, keep),
      );
      const naming = parseNaming(text, topic.members);
      if (naming === null)
        throw new Error(`the answer was not a valid naming: ${text.slice(0, 160)}`);
      this.saved.topics[topic.id] = {
        members: topic.members.map((m) => m.id),
        name: kept?.name ?? naming.name,
        sub: kept?.sub ?? naming.sub,
      };
      for (const member of topic.members) {
        const lines = naming.lines.get(member.id) ?? fallbackLines(member);
        this.saved.lines[member.id] = { hash: hashOf(member), lines };
      }
      for (const [a, b] of topic.pairs) {
        const given = naming.labels.find(
          (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a),
        );
        this.saved.labels[pairKey(a, b)] = given?.label ?? "related";
      }
      return true;
    } catch (error) {
      this.deps.log?.("name_failed", {
        topic: topic.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Drop what no topic or item on the map needs any more. */
  private prune(topics: readonly TopicInfo[]): void {
    const ids = new Set(topics.map((t) => t.id));
    const items = new Set(topics.flatMap((t) => t.members.map((m) => m.id)));
    const pairs = new Set(topics.flatMap((t) => t.pairs.map(([a, b]) => pairKey(a, b))));
    const keep = <T>(record: Record<string, T>, alive: Set<string>) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => alive.has(id)));
    this.saved = {
      topics: keep(this.saved.topics, ids),
      lines: keep(this.saved.lines, items),
      labels: keep(this.saved.labels, pairs),
    };
  }

  /** A topic's theme: the model's name while its members barely changed, else the entity they share. */
  themeOf(topic: TopicInfo, entities: ReadonlyMap<string, readonly Entity[]>): Theme {
    const named = this.status === "no key" ? null : this.named(topic);
    if (named !== null) return { id: topic.id, name: named.name, sub: named.sub };
    return fallbackTheme(topic.id, topic.members, entities);
  }

  /** An item's two lines: the model's while its text is unchanged, else from its brief. */
  linesOf(item: Item): string[] {
    const saved = this.saved.lines[item.id];
    if (saved !== undefined && saved.hash === hashOf(item) && saved.lines.length > 0)
      return saved.lines;
    return fallbackLines(item);
  }

  /** The model's label for a pair only similarity ties, if it gave one. */
  labelOf(a: string, b: string): string | undefined {
    return this.saved.labels[pairKey(a, b)];
  }

  state(): ModelStatus {
    return this.status;
  }
}
