/**
 * The model groups and names: when the items the map is made of changed (their
 * fingerprint), one call on prifly's fast tier (`api.llm.ask`) gets all the
 * items with hints — the pairs that share an entity and the last map's topics —
 * and answers the topics, each item's topic, and the related pairs (no summary
 * lines: `liner.ts` asks for those apart). At most one call a minute, failures included. An answer that breaks
 * the rules in `rules.ts` is asked for once more with the reasons. The answer
 * is kept in `api.state`, so a restart does not ask again. Nothing is grouped
 * without the model: no feature, a refusal, a failed call or a bad answer
 * leaves `error` saying why.
 */

import { createHash } from "node:crypto";
import type { ExtensionStateApi } from "@prifly/extension-api";
import { AskLimits } from "./limits";
import {
  type Ask,
  badAnswerFailure,
  type Failure,
  type LlmAnswer,
  type LlmBackend,
  refusedFailure,
  unsupportedFailure,
} from "./llm";
import { nameProblem, type Review, reasons, review } from "./rules";
import {
  type Grouping,
  groupingRequest,
  type Hints,
  type Pair,
  type PreviousTopic,
  parseGrouping,
  retryRequest,
} from "./sorting";
import type { Picked } from "./topics";
import type { Item, Theme } from "./types";

export const MIN_GAP_MS = 60_000;
/** A topic keeps its name while at least this share of its members (Jaccard) is the same. */
export const KEEP_NAME = 0.5;
const STATE_NAME = "grouping";

/** A good answer, kept: what the model made of the items whose fingerprint is `fingerprint`. */
export type Answered = {
  fingerprint: string;
  topics: Theme[];
  topicOf: Record<string, string>;
  related: Pair[];
  model: string;
  backend: LlmBackend;
};

/** The answer for no items at all: nothing to ask. */
export const NOTHING: Answered = {
  fingerprint: "",
  topics: [],
  topicOf: {},
  related: [],
  model: "",
  backend: "claude",
};

/**
 * What changes the call: which items there are and what they are called (id,
 * title, subject), in any order. Not their status, brief, last message or
 * time: those change all the time and the grouping stands.
 */
export function fingerprintOf(items: readonly Item[]): string {
  const told = items
    .map((item) => [item.id, item.title, item.subject ?? ""])
    .sort((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));
  return createHash("sha1").update(JSON.stringify(told)).digest("hex");
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  const both = [...x].filter((id) => y.has(id)).length;
  const either = new Set([...x, ...y]).size;
  return either === 0 ? 1 : both / either;
}

export type GrouperDeps = {
  /** `api.llm.ask`, or null where prifly has none. Asked each time, so a prifly update is seen. */
  ask: () => Ask | null;
  state?: ExtensionStateApi | undefined;
  /** Shared with the summary lines: one ask in flight, and the hour's count. */
  limits?: AskLimits;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

/** One reading of an answer: the grouping when its shape is right, the review of it, and every reason to ask again. */
type Read = { grouping: Grouping | null; checked: Review | null; problems: string[] };

export class Grouper {
  private answered: Answered | null = null;
  private askedAt = Number.NEGATIVE_INFINITY;
  private failure: Failure | null = null;
  private readonly deps: GrouperDeps;
  private readonly limits: AskLimits;
  private clock = 0;

  constructor(deps: GrouperDeps) {
    this.deps = deps;
    this.limits = deps.limits ?? new AskLimits();
  }

  /** The answer kept in `api.state`. */
  async load(): Promise<void> {
    const saved = await this.deps.state?.get<Answered>(STATE_NAME).catch(() => undefined);
    if (typeof saved?.fingerprint === "string" && Array.isArray(saved.topics))
      this.answered = saved;
  }

  /** The answer for exactly these items, or null while the model has not given one. */
  answerFor(items: readonly Item[]): Answered | null {
    if (items.length === 0) return NOTHING;
    return this.answered?.fingerprint === fingerprintOf(items) ? this.answered : null;
  }

  /**
   * The last answer and the items it covers, while the model has not yet
   * answered for exactly these: `items` less those the answer does not know.
   * Null when there is no answer or it knows none of them.
   */
  partialFor(items: readonly Item[]): { answered: Answered; items: Item[] } | null {
    const answered = this.answered;
    if (answered === null) return null;
    const known = items.filter((item) => answered.topicOf[item.id] !== undefined);
    return known.length === 0 ? null : { answered, items: known };
  }

  /** The topics of the last answer, with their members: a hint, so topics stay stable. */
  private previous(): PreviousTopic[] {
    const last = this.answered;
    if (last === null) return [];
    return last.topics.map((topic) => ({
      ...topic,
      members: Object.entries(last.topicOf).flatMap(([id, t]) => (t === topic.id ? [id] : [])),
    }));
  }

  /** Whether `update` would call now: the items changed, a minute has passed since the last call, and prifly has a model. */
  due(items: readonly Item[], now: number): boolean {
    return (
      !this.limits.busy &&
      items.length > 0 &&
      this.deps.ask() !== null &&
      now - this.askedAt >= MIN_GAP_MS &&
      this.answered?.fingerprint !== fingerprintOf(items)
    );
  }

  /** Ask for the grouping of `picked`, when due; see `due`. */
  async update(picked: Picked, now: number): Promise<void> {
    const ask = this.deps.ask();
    if (ask === null || !this.due(picked.items, now) || !this.limits.begin()) return;
    this.askedAt = now;
    this.clock = now;
    const started = Date.now();
    try {
      const hints: Hints = { shared: picked.shared, previous: this.previous() };
      const done = await this.converse(ask, picked.items, hints);
      this.deps.log?.("grouped", {
        items: picked.items.length,
        ok: done,
        ms: Date.now() - started,
      });
    } finally {
      this.limits.end();
    }
  }

  private async callAsk(ask: Ask, request: Parameters<Ask>[0]): Promise<LlmAnswer> {
    this.limits.record(this.clock);
    try {
      return await ask(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.("ask_threw", { error: message });
      return { ok: false, code: "failed", reason: "The model call failed before it answered." };
    }
  }

  /** The topics of the last answer that these members mostly still match, to keep their names. */
  private kept(grouping: Grouping): Map<string, Theme> {
    const members = new Map<string, string[]>();
    for (const [id, topic] of grouping.topicOf)
      members.set(topic, [...(members.get(topic) ?? []), id]);
    const before = new Map(this.previous().map((topic) => [topic.id, topic]));
    const kept = new Map<string, Theme>();
    for (const [id, ids] of members) {
      const old = before.get(id);
      if (
        old !== undefined &&
        jaccard(old.members, ids) >= KEEP_NAME &&
        nameProblem(old.name, []) === null
      )
        kept.set(id, { id, name: old.name, sub: old.sub });
    }
    return kept;
  }

  private read(text: string, items: readonly Item[]): Read {
    const parsed = parseGrouping(text, items);
    if (parsed.grouping === null)
      return { grouping: null, checked: null, problems: parsed.problems };
    const fixed = new Set(this.kept(parsed.grouping).keys());
    const checked = review(parsed.grouping, fixed);
    return { grouping: parsed.grouping, checked, problems: reasons(checked) };
  }

  /** The call, and the one more call when the answer breaks a rule. True when an answer was kept. */
  private async converse(ask: Ask, items: readonly Item[], hints: Hints): Promise<boolean> {
    const request = groupingRequest(items, hints);
    const first = await this.callAsk(ask, request);
    if (!first.ok) return this.fail(refusedFailure(first.code, first.reason));
    const one = this.read(first.text, items);
    if (one.problems.length === 0) return this.accept(first, one, items);
    const second = await this.callAsk(ask, retryRequest(request, first.text, one.problems));
    if (!second.ok) {
      this.deps.log?.("retry_failed", { code: second.code });
      // The first answer stands if its shape was right; else why the second call failed.
      return one.grouping === null
        ? this.fail(refusedFailure(second.code, second.reason))
        : this.accept(first, one, items);
    }
    const two = this.read(second.text, items);
    if (two.grouping !== null) return this.accept(second, two, items);
    return one.grouping !== null
      ? this.accept(first, one, items)
      : this.fail(badAnswerFailure(two.problems[0] ?? "it was not a grouping"));
  }

  private fail(failure: Failure): false {
    this.failure = failure;
    return false;
  }

  /** The topics' names: the earlier name while members barely changed, else the answer's; a catch-all with no earlier name is no answer. */
  private themes(grouping: Grouping, checked: Review): Theme[] | string {
    const kept = this.kept(grouping);
    const last = new Map(this.previous().map((topic) => [topic.id, topic]));
    const names = grouping.topics.map((t) => t.name);
    const out: Theme[] = [];
    for (const topic of grouping.topics) {
      const keep = kept.get(topic.id);
      const problem = checked.names.get(topic.id);
      const before = last.get(topic.id);
      const others = names.filter((name) => name !== topic.name);
      if (keep !== undefined) out.push(keep);
      else if (problem === undefined) out.push(topic);
      else if (before !== undefined && nameProblem(before.name, others) === null)
        out.push({ id: topic.id, name: before.name, sub: before.sub });
      else if (problem.kind === "overlap") out.push(topic);
      else return `the name "${topic.name}" was a catch-all`;
    }
    return out;
  }

  private accept(answer: LlmAnswer & { ok: true }, read: Read, items: readonly Item[]): boolean {
    const { grouping, checked } = read;
    if (grouping === null || checked === null)
      return this.fail(badAnswerFailure("it was not a grouping"));
    const topics = this.themes(grouping, checked);
    if (typeof topics === "string") return this.fail(badAnswerFailure(topics));
    this.answered = {
      fingerprint: fingerprintOf(items),
      topics,
      topicOf: Object.fromEntries(grouping.topicOf),
      related: grouping.related,
      model: answer.model,
      backend: answer.backend,
    };
    this.failure = null;
    void this.deps.state?.set(STATE_NAME, this.answered).catch(() => undefined);
    return true;
  }

  /** Why there is no (new) grouping: prifly has no model call, a refusal, a failed call or a bad answer; null after a good one. */
  error(): Failure | null {
    return this.deps.ask() === null ? unsupportedFailure() : this.failure;
  }
}
