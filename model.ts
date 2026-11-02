/**
 * The model only names: one short chat call per new or changed topic, on
 * DeepInfra's OpenAI-compatible endpoint with the key from the vault, asking
 * for the theme's name, a line under it, two summary lines per member and
 * labels for the pairs only embeddings tie. At most one round of calls a
 * minute; answers are kept in `api.state`. A topic keeps its name while its
 * members barely change. No key, a failed call or a bad answer: nothing is
 * named, and `error` says why. A name or line that breaks the rules in
 * `rules.ts` is asked for once more with the reason (see `asked`).
 */

import type { ExtensionStateApi } from "@prifly/extension-api";
import { type Failure, failedResponse, failureOf, noKeyFailure } from "./deepinfra";
import { embedText, textHash } from "./embed";
import { commonEntity, type Entity, pairKey } from "./entities";
import { type NameProblem, nameProblem, type Review, reasons, review } from "./rules";
import { type NamePrompt, type Naming, namePrompt, parseNaming } from "./sorting";
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
  if (!response.ok) throw await failedResponse(response);
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
  private failure: Failure | null = null;
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
  }

  /** The name a topic keeps: the model's, while its members barely changed. */
  private named(topic: TopicInfo): Named | null {
    const named = this.saved.topics[topic.id];
    const ids = topic.members.map((m) => m.id);
    // A catch-all name is not kept, whenever it was given.
    return named !== undefined &&
      jaccard(named.members, ids) >= KEEP_NAME &&
      nameProblem(named.name, [])?.kind !== "catch-all"
      ? named
      : null;
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

  /** Name the due topics, one call each (two when a part of the answer breaks a rule), one after another; see `due`. */
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
        this.failure = noKeyFailure("naming");
        return;
      }
      const due = topics.filter((t) => this.isDue(t));
      const started = Date.now();
      // One after the other, so each topic is told the names the others have by then.
      const results: (Failure | null)[] = [];
      for (const t of due)
        results.push(await this.name(key, t, entities, this.othersOf(t, topics)));
      const failures = results.filter((result) => result !== null);
      // A failed topic stays unnamed and is asked again; the others are kept.
      this.failure = failures[0] ?? null;
      this.deps.log?.("named", {
        topics: due.length,
        failed: failures.length,
        ms: Date.now() - started,
      });
      this.prune(topics);
      await this.deps.state?.set(STATE_NAME, this.saved).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }

  /** The names of the other topics that have one now. */
  private othersOf(topic: TopicInfo, topics: readonly TopicInfo[]): string[] {
    return topics.flatMap((t) => (t.id === topic.id ? [] : (this.named(t)?.name ?? [])));
  }

  /** One call and its answer read; throws when the call failed or the answer is no valid naming. */
  private async ask(
    key: string,
    members: readonly Item[],
    messages: NamePrompt,
  ): Promise<{ text: string; naming: Naming }> {
    const text = await this.deps.chat(key, this.model, messages);
    const naming = parseNaming(text, members);
    if (naming === null)
      // Its length only: the answer summarises private chats and mails.
      throw new Error(`the answer (${text.length} characters) was not a valid naming`);
    return { text, naming };
  }

  /**
   * The model's answer, checked against the naming rules; when a part is bad,
   * asked once more with the reasons, and the second answer is the one kept
   * (an unusable second answer leaves the first).
   */
  private async asked(
    key: string,
    topic: TopicInfo,
    messages: NamePrompt,
    others: readonly string[],
    checkName: boolean,
  ): Promise<{ naming: Naming; checked: Review }> {
    const first = await this.ask(key, topic.members, messages);
    const checked = review(first.naming, topic.members, others, checkName);
    const bad = reasons(checked);
    if (bad.length === 0) return { naming: first.naming, checked };
    const again: NamePrompt = [
      ...messages,
      { role: "assistant", content: first.text },
      {
        role: "user",
        content: `Not accepted: ${bad.join("; ")}. Answer again with the same JSON, fixing only that.`,
      },
    ];
    try {
      const second = await this.ask(key, topic.members, again);
      const rechecked = review(second.naming, topic.members, others, checkName);
      return { naming: second.naming, checked: rechecked };
    } catch (error) {
      this.deps.log?.("retry_failed", {
        topic: topic.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { naming: first.naming, checked };
    }
  }

  /**
   * The theme's name and sub: the answer's when it passed; else the topic's
   * last good name; else, for an overlap only, the answer's. A catch-all with
   * nothing better is no name: the topic stays unnamed and is asked again.
   */
  private chosen(
    topic: TopicInfo,
    naming: Naming,
    problem: NameProblem | null,
    others: readonly string[],
  ): { name: string; sub: string } {
    if (problem === null) return { name: naming.name, sub: naming.sub };
    const last = this.saved.topics[topic.id];
    if (last !== undefined && nameProblem(last.name, others) === null) return last;
    if (problem.kind === "overlap") return { name: naming.name, sub: naming.sub };
    throw new Error("the name was a catch-all, and the topic has no earlier name");
  }

  /** One topic's call. Why it failed when it did, or its answer was no valid naming; else null. */
  private async name(
    key: string,
    topic: TopicInfo,
    entities: ReadonlyMap<string, readonly Entity[]>,
    others: readonly string[],
  ): Promise<Failure | null> {
    const kept = this.named(topic);
    // What the members share goes to the model as a hint; it names nothing by itself.
    const common = commonEntity(topic.members, entities);
    const shared = common === null ? [] : [common];
    const keep = kept === null ? null : { id: topic.id, name: kept.name, sub: kept.sub };
    try {
      const messages = namePrompt(topic.members, shared, topic.pairs, keep, others);
      const { naming, checked } = await this.asked(key, topic, messages, others, kept === null);
      const theme = kept ?? this.chosen(topic, naming, checked.name, others);
      this.saved.topics[topic.id] = {
        members: topic.members.map((m) => m.id),
        name: theme.name,
        sub: theme.sub,
      };
      for (const member of topic.members) {
        // A line that repeated the title is left out: none is better than a repeat.
        const lines = checked.lines.get(member.id) ?? [];
        this.saved.lines[member.id] = { hash: hashOf(member), lines };
      }
      for (const [a, b] of topic.pairs) {
        const given = naming.labels.find(
          (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a),
        );
        this.saved.labels[pairKey(a, b)] = given?.label ?? "related";
      }
      return null;
    } catch (error) {
      this.deps.log?.("name_failed", {
        topic: topic.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return failureOf("naming", error);
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

  /** Whether every topic has its name, every member its lines and every pair its label, as the topics are now. */
  ready(topics: readonly TopicInfo[]): boolean {
    return topics.every((topic) => !this.isDue(topic));
  }

  /** A topic's theme: the model's name, kept while its members barely changed; null while it has none. */
  themeOf(topic: TopicInfo): Theme | null {
    const named = this.named(topic);
    return named === null ? null : { id: topic.id, name: named.name, sub: named.sub };
  }

  /** An item's two lines: the model's while its text is unchanged. */
  linesOf(item: Item): string[] {
    const saved = this.saved.lines[item.id];
    return saved !== undefined && saved.hash === hashOf(item) ? saved.lines : [];
  }

  /** The model's label for a pair only similarity ties, if it gave one. */
  labelOf(a: string, b: string): string | undefined {
    return this.saved.labels[pairKey(a, b)];
  }

  /** Why the last naming round left topics unnamed (no key, a failed call, a bad answer); null after one that worked. */
  error(): Failure | null {
    return this.failure;
  }
}
