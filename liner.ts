/**
 * The summary lines under the circles. They come apart from the grouping, so
 * the map does not wait for them: an item with no lines yet is drawn with its
 * title only. Each item's lines are kept in `api.state` with the fingerprint
 * they were made for; only items whose fingerprint is new or changed are asked
 * for, in batches of `BATCH`, one batch per refresh tick, one after another
 * (the `AskLimits` allow one ask in flight). A failed batch stops the batches
 * until a minute has passed; nothing is shown for it, the map is as it was.
 */

import type { ExtensionStateApi } from "@prifly/extension-api";
import { type AskLimits, LINES_BUDGET } from "./limits";
import { BATCH, lineFingerprint, linesRequest, parseLines } from "./lines";
import type { Ask } from "./llm";
import type { Item } from "./types";

/** After a failed batch, no other batch for this long. */
export const FAIL_GAP_MS = 60_000;
const STATE_NAME = "lines";
/** The most items whose lines are kept. */
const KEEP = 300;

type Kept = Record<string, { fp: string; lines: string[] }>;

export type LinerDeps = {
  ask: () => Ask | null;
  limits: AskLimits;
  state?: ExtensionStateApi | undefined;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

export class Liner {
  private kept: Kept = {};
  private failedAt = Number.NEGATIVE_INFINITY;
  private readonly deps: LinerDeps;

  constructor(deps: LinerDeps) {
    this.deps = deps;
  }

  /** The lines kept in `api.state`. */
  async load(): Promise<void> {
    const saved = await this.deps.state?.get<Kept>(STATE_NAME).catch(() => undefined);
    if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) this.kept = saved;
  }

  /** The lines of each item that has some: old ones stay until the new ones come. */
  linesOf(items: readonly Item[]): Record<string, string[]> {
    return Object.fromEntries(
      items.flatMap((item) => {
        const lines = this.kept[item.id]?.lines;
        return Array.isArray(lines) ? [[item.id, lines]] : [];
      }),
    );
  }

  /** The items whose lines are not made yet or were made for other text. */
  pending(items: readonly Item[]): Item[] {
    return items.filter((item) => this.kept[item.id]?.fp !== lineFingerprint(item));
  }

  /** Ask for one batch of the lines that are due, if the limits allow; see the file's note. */
  async update(items: readonly Item[], now: number): Promise<void> {
    const ask = this.deps.ask();
    const todo = this.pending(items).slice(0, BATCH);
    if (ask === null || todo.length === 0 || now - this.failedAt < FAIL_GAP_MS) return;
    const { limits } = this.deps;
    if (limits.used(now) >= LINES_BUDGET || !limits.begin()) return;
    const started = Date.now();
    try {
      limits.record(now);
      const ok = await this.batch(ask, todo, items);
      if (!ok) this.failedAt = now;
      this.deps.log?.("lines", { items: todo.length, ok, ms: Date.now() - started });
    } finally {
      limits.end();
    }
  }

  private async batch(ask: Ask, todo: readonly Item[], items: readonly Item[]): Promise<boolean> {
    try {
      const answer = await ask(linesRequest(todo));
      if (!answer.ok) {
        this.deps.log?.("lines_refused", { code: answer.code });
        return false;
      }
      const lines = parseLines(answer.text, todo);
      if (lines === null) {
        this.deps.log?.("lines_unreadable", {});
        return false;
      }
      for (const item of todo)
        this.kept[item.id] = { fp: lineFingerprint(item), lines: lines.get(item.id) ?? [] };
      this.save(items);
      return true;
    } catch (error) {
      this.deps.log?.("lines_threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private save(items: readonly Item[]): void {
    const keys = Object.keys(this.kept);
    if (keys.length > KEEP) {
      const now = new Set(items.map((item) => item.id));
      for (const key of keys) if (!now.has(key)) delete this.kept[key];
    }
    void this.deps.state?.set(STATE_NAME, this.kept).catch(() => undefined);
  }
}
