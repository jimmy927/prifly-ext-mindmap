/**
 * The model that sorts items into themes: a small instruct model on
 * DeepInfra's OpenAI-compatible endpoint, with the key from the vault. Asked
 * only when the fingerprint of the items changes, and at most once a minute;
 * its last answer is kept in `api.state`. No key, or a failed call: the
 * fallback sorting.
 */

import type { ExtensionStateApi } from "@prifly/extension-api";
import { completeSorting, fallbackSorting, fingerprint, parseAnswer, promptOf } from "./sorting";
import type { Item, Sorting } from "./types";

/** Chosen by measuring on real session data: see the README. */
export const MODEL = "Qwen/Qwen2.5-7B-Instruct";
export const ENDPOINT = "https://api.deepinfra.com/v1/openai/chat/completions";
export const MIN_GAP_MS = 60_000;
/** A sorting of ~35 items took 33-52 s when measured; a call past this is given up. */
const TIMEOUT_MS = 90_000;

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
      max_tokens: 4000,
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

type Saved = { fingerprint: string; at: number; sorting: Sorting };
const STATE_NAME = "sorting";

export type SorterDeps = {
  /** The DeepInfra key, or null when the vault has none for this extension. */
  key: () => Promise<string | null>;
  chat: Chat;
  state?: ExtensionStateApi | undefined;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  model?: string;
};

/** What the map shows of the model: whether it sorted, and why not. */
export type ModelStatus = "model" | "no key" | "failed" | "waiting";

export class Sorter {
  private saved: Saved | null = null;
  /**
   * The fingerprint the model last answered for, and when it was last tried
   * (answered, failed or without a key). Until it answers for the items now —
   * no key yet, or a failed call — it is tried again once a minute.
   */
  private askedFor = "";
  private askedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private status: ModelStatus = "waiting";
  readonly model: string;
  private readonly deps: SorterDeps;

  constructor(deps: SorterDeps) {
    this.deps = deps;
    this.model = deps.model ?? MODEL;
  }

  /** The last answer kept in `api.state`, so a restart does not ask again for the same items. */
  async load(): Promise<void> {
    const saved = await this.deps.state?.get<Saved>(STATE_NAME).catch(() => undefined);
    if (saved?.sorting !== undefined && typeof saved.fingerprint === "string") {
      this.saved = saved;
      this.askedFor = saved.fingerprint;
      this.status = "model";
    }
  }

  /**
   * Whether `update` would ask the model now: it has not answered for these
   * items (they changed, or the last try had no key or failed), and a minute
   * has passed since the last try.
   */
  due(items: readonly Item[], now: number): boolean {
    return !this.busy && fingerprint(items) !== this.askedFor && now - this.askedAt >= MIN_GAP_MS;
  }

  /** Ask the model when it is due; see `due`. */
  async update(items: readonly Item[], now: number): Promise<void> {
    if (items.length === 0 || !this.due(items, now)) return;
    const print = fingerprint(items);
    this.busy = true;
    this.askedAt = now;
    try {
      const key = await this.deps.key();
      if (key === null || key === "") {
        this.status = "no key";
        return;
      }
      await this.ask(key, items, print, now);
    } finally {
      this.busy = false;
    }
  }

  private async ask(
    key: string,
    items: readonly Item[],
    print: string,
    now: number,
  ): Promise<void> {
    const started = Date.now();
    try {
      const text = await this.deps.chat(
        key,
        this.model,
        promptOf(items, this.saved?.sorting.themes ?? []),
      );
      const sorting = parseAnswer(text, items, this.model);
      if (sorting === null) throw new Error("the answer was not a valid sorting");
      this.saved = { fingerprint: print, at: now, sorting };
      this.askedFor = print;
      this.status = "model";
      this.deps.log?.("sorted", {
        items: items.length,
        themes: sorting.themes.length,
        ms: Date.now() - started,
      });
      await this.deps.state?.set(STATE_NAME, this.saved).catch(() => undefined);
    } catch (error) {
      this.status = "failed";
      this.deps.log?.("sort_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The sorting to draw: the model's last answer stretched to the items now, or the fallback. */
  sortingFor(items: readonly Item[]): Sorting {
    const saved = this.saved;
    if (saved === null || this.status === "no key") return fallbackSorting(items);
    return completeSorting(saved.sorting, items);
  }

  /** The footer's word on the model. */
  statusLine(): string {
    if (this.status === "model") return `Themes by ${this.model.split("/").at(-1) ?? this.model}`;
    if (this.status === "no key") return "No DeepInfra key in the vault: themes by repository";
    if (this.status === "failed")
      return this.saved === null
        ? "The model failed: themes by repository"
        : "The model failed: last themes kept";
    return "Themes by repository until the model answers";
  }
}
